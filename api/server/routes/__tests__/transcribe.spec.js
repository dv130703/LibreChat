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
    // Real enough for /retranscribe's real-disk round trip: reads back
    // whatever local path the test itself wrote as the "stored" source file.
    getDownloadStream: jest.fn((req, filepath) => require('fs').createReadStream(filepath)),
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
      diarizationTurns: [{ start: 0, end: 1, speaker: 'SPEAKER_00' }],
      speakerEmbeddings: null,
      recordingProfile: {
        speaker_count: 1,
        turn_count: 1,
        median_turn_duration_s: 1,
        mean_turn_duration_s: 1,
        p95_turn_duration_s: 1,
        longest_turn_s: 1,
        speaker_switches_per_minute: 0,
        speaker_time_distribution_s: { 'Speaker 1': 1 },
        overlap_ratio: 0,
        unassigned_audio_ratio: 0,
        short_turn_ratio: 0,
        classification: 'monologue',
      },
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
    expect(response.body.diarizationDetailFile).not.toBeNull();
    // Diarization-detail-only fields never leak into the plain response -
    // only the persisted file (asserted below) carries them.
    expect(response.body.segments[0]).not.toHaveProperty('words');
    expect(response.body.segments[0]).not.toHaveProperty('assignment_method');

    const File = mongoose.models.File;
    const transcriptFile = await File.findOne({ file_id: 'source-file-transcript' }).lean();
    expect(transcriptFile).not.toBeNull();
    expect(transcriptFile.context).toBe('transcript_rag');
    expect(transcriptFile.text).toBe('Speaker 1: Hello');

    const sourceFile = await File.findOne({ conversationId, filename: 'meeting.m4a' }).lean();
    expect(sourceFile).not.toBeNull();
    expect(sourceFile.context).toBe('transcript_rag');

    const diarizationDetailFileId = `${sourceFile.file_id}-diarization-detail`;
    const diarizationDetailFile = await File.findOne({ file_id: diarizationDetailFileId }).lean();
    expect(diarizationDetailFile).not.toBeNull();
    expect(diarizationDetailFile.context).toBe('transcript_diarization_detail');
    expect(diarizationDetailFile.embedded).toBe(false);
    const detail = JSON.parse(diarizationDetailFile.text);
    expect(detail.diarizationTurns).toEqual([{ start: 0, end: 1, speaker: 'SPEAKER_00' }]);
    expect(detail.segments[0]).toEqual(
      expect.objectContaining({ speaker: 'Speaker 1', text: 'Hello', assignmentMethod: 'none' }),
    );
    expect(detail.recordingProfile).toEqual(
      expect.objectContaining({ speakerCount: 1, turnCount: 1, classification: 'monologue' }),
    );

    const Conversation = mongoose.models.Conversation;
    const convo = await Conversation.findOne({ conversationId }).lean();
    expect(convo).not.toBeNull();
    expect(convo.files).toEqual(
      expect.arrayContaining([
        sourceFile.file_id,
        'source-file-transcript',
        diarizationDetailFileId,
      ]),
    );
    expect(convo.files).toHaveLength(3);
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
        diarizationTurns: [],
        speakerEmbeddings: null,
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

    // ...and exists, with all three files attached, once the request is done.
    const convo = await mongoose.models.Conversation.findOne({ conversationId }).lean();
    expect(convo).not.toBeNull();
    expect(convo.files).toHaveLength(3);
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

describe('POST /api/transcribe/:conversationId/retranscribe', () => {
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
  });

  it('identifies the real source file even when a diarization-detail file id would sort before it', async () => {
    // Regression test: adding a third per-conversation file
    // (`-diarization-detail`) broke the old `fileIds.find((id) => id !==
    // transcriptFileId)` discovery logic, which assumed "whatever isn't the
    // transcript" was necessarily the source audio. Deliberately ordered so
    // the diarization-detail id comes before the real source id - exactly
    // the shape that logic would have picked wrong.
    const conversationId = `convo-retranscribe-${Date.now()}`;
    const File = mongoose.models.File;
    const Conversation = mongoose.models.Conversation;

    const audioPath = path.join(os.tmpdir(), `retranscribe-source-${Date.now()}.m4a`);
    await fs.promises.writeFile(audioPath, Buffer.from('fake-audio-bytes'));

    const sourceFileId = `source-${Date.now()}`;
    const transcriptFileId = `${sourceFileId}-transcript`;
    const diarizationDetailFileId = `${sourceFileId}-diarization-detail`;

    await File.create({
      user: userId,
      file_id: sourceFileId,
      filename: 'meeting.m4a',
      filepath: audioPath,
      source: 'local',
      type: 'audio/mp4',
      bytes: 16,
      context: 'transcript_rag',
      conversationId,
    });
    await File.create({
      user: userId,
      file_id: diarizationDetailFileId,
      filename: 'meeting-diarization-detail.json',
      filepath: `transcript-diarization-detail://${diarizationDetailFileId}`,
      source: 'text',
      type: 'application/json',
      bytes: 2,
      text: '{}',
      context: 'transcript_diarization_detail',
      conversationId,
    });
    await Conversation.create({
      conversationId,
      user: userId,
      endpoint: 'agents',
      files: [transcriptFileId, diarizationDetailFileId, sourceFileId],
    });

    mockTranscribeAndEmbed.mockResolvedValue({
      segments: [{ start: 0, end: 1, speaker: 'Speaker 1', text: 'Hi again' }],
      language: 'en',
      diagnostics: {},
      diarizationTurns: [],
      speakerEmbeddings: null,
      text: 'Speaker 1: Hi again',
      transcriptFileId,
      embedded: true,
    });

    const response = await request(app)
      .post(`/api/transcribe/${conversationId}/retranscribe`)
      .send({});

    expect(response.status).toBe(200);
    expect(mockTranscribeAndEmbed).toHaveBeenCalledWith(expect.objectContaining({ sourceFileId }));

    await fs.promises.unlink(audioPath).catch(() => {});
  });
});
