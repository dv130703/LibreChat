const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createMethods } = require('@librechat/data-schemas');

// Only mock genuine external boundaries: JWT verification, the storage
// strategy (would otherwise hit real S3/local disk semantics we don't need
// to re-verify here), retention policy lookup, and the RAG/WhisperX call
// itself. Mongo persistence (saveConvo/createFile/addConvoFile) runs for
// real against an in-memory server - that's the behavior this test exists
// to catch (the ordering bug), so it must not be mocked away.
jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware/config/app', () => (req, res, next) => next());

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn().mockResolvedValue('/fake/storage/path'),
  })),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn(() => 'local'),
}));

// Isolates the route's real (unmocked) local-disk stream-copy to a temp
// directory instead of the project's actual client/public/images.
jest.mock('~/config/paths', () => ({
  publicPath: require('os').tmpdir(),
}));

jest.mock('~/server/services/Files/retention', () => ({
  getRetentionExpiry: jest.fn().mockResolvedValue({}),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getStorageMetadata: jest.fn(() => ({})),
  // Real ffmpeg can't decode the fake bytes these tests upload - stand in
  // with a plain copy so the route's orchestration (which only cares that
  // an output file exists to stat/persist) still gets a real file on disk.
  extractAudioTrack: jest.fn((inputPath, outputPath) =>
    require('fs').promises.copyFile(inputPath, outputPath),
  ),
}));

const mockTranscribeAndEmbed = jest.fn();
jest.mock('~/server/services/Transcription', () => ({
  transcribeAndEmbed: (...args) => mockTranscribeAndEmbed(...args),
}));

describe('POST /api/transcribe', () => {
  let app;
  let mongoServer;
  let userId;
  let modelsToCleanup = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const { createModels } = require('@librechat/data-schemas');
    const models = createModels(mongoose);
    modelsToCleanup = Object.keys(models);
    Object.assign(mongoose.models, models);

    const methods = createMethods(mongoose);
    await methods.seedDefaultRoles();

    userId = new mongoose.Types.ObjectId().toString();

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: userId, tenantId: undefined };
      req.config = { paths: { uploads: os.tmpdir() } };
      next();
    });

    const router = require('../transcribe');
    app.use('/api/transcribe', router);
  });

  afterAll(async () => {
    await fs.promises.rm(path.join(os.tmpdir(), 'images', userId), {
      recursive: true,
      force: true,
    });
    for (const modelName of modelsToCleanup) {
      if (mongoose.models[modelName]) {
        delete mongoose.models[modelName];
      }
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockTranscribeAndEmbed.mockResolvedValue({
      segments: [{ start: 0, end: 1, speaker: 'Speaker 1', text: 'Hello' }],
      language: 'en',
      diagnostics: {},
      text: 'Speaker 1: Hello',
      transcriptFileId: 'source-file-transcript',
      embedded: true,
    });
  });

  const tinyAudioBuffer = Buffer.from('fake-audio-bytes');

  it('creates the conversation before attaching the transcript file (ordering fix)', async () => {
    const conversationId = `convo-${Date.now()}`;

    const response = await request(app)
      .post('/api/transcribe')
      .field('conversationId', conversationId)
      .field('endpoint', 'agents')
      .attach('file', tinyAudioBuffer, { filename: 'meeting.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBe(conversationId);
    expect(response.body.transcriptFile).toEqual(
      expect.objectContaining({ file_id: 'source-file-transcript' }),
    );

    const File = mongoose.models.File;
    const transcriptFile = await File.findOne({ file_id: 'source-file-transcript' }).lean();
    expect(transcriptFile).not.toBeNull();
    expect(transcriptFile.context).toBe('transcript_rag');
    expect(transcriptFile.text).toBe('Speaker 1: Hello');

    const sourceFile = await File.findOne({ conversationId, filename: 'meeting.m4a' }).lean();
    expect(sourceFile).not.toBeNull();
    expect(sourceFile.context).toBe('transcript_rag');

    const Conversation = mongoose.models.Conversation;
    const convo = await Conversation.findOne({ conversationId }).lean();
    expect(convo).not.toBeNull();
    expect(convo.files).toEqual(
      expect.arrayContaining([sourceFile.file_id, 'source-file-transcript']),
    );
    expect(convo.files).toHaveLength(2);
  });

  it('does not persist the conversation until the transcription finishes', async () => {
    const conversationId = `convo-${Date.now()}`;
    let convoDuringTranscription;

    // Snapshot the conversation collection from inside the transcription
    // itself - the window that used to leave a titled, clickable, but
    // un-openable row in the sidebar for the whole minutes-long run.
    mockTranscribeAndEmbed.mockImplementation(async () => {
      convoDuringTranscription = await mongoose.models.Conversation.findOne({
        conversationId,
      }).lean();
      return {
        segments: [{ start: 0, end: 1, speaker: 'Speaker 1', text: 'Hello' }],
        language: 'en',
        diagnostics: {},
        text: 'Speaker 1: Hello',
        transcriptFileId: 'source-file-transcript',
        embedded: true,
      };
    });

    const response = await request(app)
      .post('/api/transcribe')
      .field('conversationId', conversationId)
      .attach('file', tinyAudioBuffer, { filename: 'meeting.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(200);
    expect(convoDuringTranscription).toBeNull();

    // ...and exists, with both files attached, once the request is done.
    const convo = await mongoose.models.Conversation.findOne({ conversationId }).lean();
    expect(convo).not.toBeNull();
    expect(convo.files).toHaveLength(2);
  });

  it('leaves no conversation behind when the transcription fails', async () => {
    const conversationId = `convo-${Date.now()}`;
    mockTranscribeAndEmbed.mockRejectedValue(new Error('diarization produced no segments'));

    const response = await request(app)
      .post('/api/transcribe')
      .field('conversationId', conversationId)
      .attach('file', tinyAudioBuffer, { filename: 'meeting.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(500);
    const convo = await mongoose.models.Conversation.findOne({ conversationId }).lean();
    expect(convo).toBeNull();
  });

  it('returns 400 when conversationId is missing', async () => {
    const response = await request(app)
      .post('/api/transcribe')
      .attach('file', tinyAudioBuffer, { filename: 'meeting.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(400);
    expect(mockTranscribeAndEmbed).not.toHaveBeenCalled();
  });

  it('returns 400 when no file is provided', async () => {
    const response = await request(app)
      .post('/api/transcribe')
      .field('conversationId', `convo-${Date.now()}`);

    expect(response.status).toBe(400);
  });

  it('rejects non audio/video files', async () => {
    const response = await request(app)
      .post('/api/transcribe')
      .field('conversationId', `convo-${Date.now()}`)
      .attach('file', Buffer.from('not audio'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(500);
    expect(mockTranscribeAndEmbed).not.toHaveBeenCalled();
  });

  it('does not create a transcript file when no speech is detected', async () => {
    mockTranscribeAndEmbed.mockResolvedValue({
      segments: [],
      language: 'en',
      diagnostics: {},
      text: '',
      transcriptFileId: null,
      embedded: false,
    });
    const conversationId = `convo-${Date.now()}`;

    const response = await request(app)
      .post('/api/transcribe')
      .field('conversationId', conversationId)
      .attach('file', tinyAudioBuffer, { filename: 'silent.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(200);
    expect(response.body.transcriptFile).toBeNull();

    const File = mongoose.models.File;
    const sourceFile = await File.findOne({ conversationId, filename: 'silent.m4a' }).lean();
    expect(sourceFile).not.toBeNull();

    const Conversation = mongoose.models.Conversation;
    const convo = await Conversation.findOne({ conversationId }).lean();
    expect(convo.files).toEqual([sourceFile.file_id]);
  });
});
