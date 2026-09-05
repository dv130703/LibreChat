const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Constants } = require('librechat-data-provider');
const { createMethods } = require('@librechat/data-schemas');
const { onIdle } = require('~/server/services/Transcription/jobQueue');

// Only mock genuine external boundaries: JWT verification, the storage
// strategy (would otherwise hit real S3/local disk semantics we don't need
// to re-verify here), retention policy lookup, and the RAG/WhisperX call
// itself. Mongo persistence (saveConvo/createFile/addConvoFile) runs for
// real against an in-memory server - that's the behavior these tests exist
// to catch, so it must not be mocked away. The job queue and tenant-context
// middleware are real too (not mocked) - `onIdle()` above is how tests
// synchronize on the fire-and-forget enqueued job actually finishing.
jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware/config/app', () => (req, res, next) => next());

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn().mockResolvedValue('/fake/storage/path'),
    // Mirrors the real local strategy's `getLocalFileStream`: a `/images/`-
    // prefixed path (what `saveSourceFile`'s local branch actually stores)
    // resolves against `req.config.paths.imageOutput`, not the raw string -
    // an absolute path (what hand-seeded retranscribe fixtures use) is read
    // as-is. A naive `fs.createReadStream(filepath)` for both looked
    // correct against hand-seeded fixtures but silently broke retry/
    // retranscribe against a file that went through the real upload path.
    getDownloadStream: jest.fn((req, filepath) => {
      if (filepath.includes('/images/')) {
        const basePath = filepath.split('/images/')[1];
        return require('fs').createReadStream(
          require('path').join(req.config.paths.imageOutput, basePath),
        );
      }
      return require('fs').createReadStream(filepath);
    }),
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

const mockProbeAudioChannels = jest.fn();
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getStorageMetadata: jest.fn(() => ({})),
  // Real ffmpeg can't decode the fake bytes these tests upload - stand in
  // with a plain copy so the route's orchestration (which only cares that
  // an output file exists to stat/persist) still gets a real file on disk.
  extractAudioTrack: jest.fn((inputPath, outputPath) =>
    require('fs').promises.copyFile(inputPath, outputPath),
  ),
  // Real ffprobe can't read channel count from fake bytes either - `POST
  // /probe`'s own tests set this per-case; other tests never call it.
  probeAudioChannels: (...args) => mockProbeAudioChannels(...args),
}));

const mockTranscribeAndEmbed = jest.fn();
jest.mock('~/server/services/Transcription', () => ({
  transcribeAndEmbed: (...args) => mockTranscribeAndEmbed(...args),
}));

const DEFAULT_RESULT = {
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
};

describe('transcribe.js (async job model, transcription/ARCHITECTURE.md Phase 2)', () => {
  let app;
  let mongoServer;
  let userId;
  let modelsToCleanup = [];
  let File;
  let Conversation;
  let Message;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const { createModels } = require('@librechat/data-schemas');
    const models = createModels(mongoose);
    modelsToCleanup = Object.keys(models);
    Object.assign(mongoose.models, models);
    File = mongoose.models.File;
    Conversation = mongoose.models.Conversation;
    Message = mongoose.models.Message;

    const methods = createMethods(mongoose);
    await methods.seedDefaultRoles();

    userId = new mongoose.Types.ObjectId().toString();

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: userId, tenantId: undefined };
      // `saveSourceFile`'s local branch writes under `<publicPath>/images/`
      // and returns a `/images/...`-relative path; `getLocalFileStream`
      // resolves that by joining `imageOutput` directly with what's after
      // `/images/` in the path, so `imageOutput` here must already point at
      // the `images` directory itself, not its parent - matching how these
      // two config values are presumed to line up in real deployments.
      req.config = {
        paths: { uploads: os.tmpdir(), imageOutput: path.join(os.tmpdir(), 'images') },
      };
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
    mockTranscribeAndEmbed.mockResolvedValue(DEFAULT_RESULT);
    mockProbeAudioChannels.mockResolvedValue(1);
  });

  const tinyAudioBuffer = Buffer.from('fake-audio-bytes');

  const uploadFile = (conversationId, filename = 'meeting.mp3', extraFields = {}) => {
    let req = request(app)
      .post('/api/transcribe')
      .field('conversationId', conversationId)
      .field('endpoint', 'agents');
    for (const [field, value] of Object.entries(extraFields)) {
      req = req.field(field, value);
    }
    return req.attach('file', tinyAudioBuffer, { filename, contentType: 'audio/mpeg' });
  };

  describe('POST /api/transcribe', () => {
    it('responds 202 immediately with a queued job, and completes asynchronously', async () => {
      const conversationId = `convo-${Date.now()}`;

      const response = await uploadFile(conversationId);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ conversationId, status: 'queued' });
      expect(response.body.sourceFile.file_id).toEqual(expect.any(String));
      expect(response.body.queuePosition).toEqual(expect.any(Number));

      // The conversation and its source file already exist the instant the
      // response comes back - the core ordering change of §5.1. Neither
      // waits for transcription to finish anymore.
      const convoImmediately = await Conversation.findOne({ conversationId }).lean();
      expect(convoImmediately).not.toBeNull();
      expect(convoImmediately.files).toContain(response.body.sourceFile.file_id);

      await onIdle();

      const transcriptFile = await File.findOne({ file_id: 'source-file-transcript' }).lean();
      expect(transcriptFile).not.toBeNull();
      expect(transcriptFile.context).toBe('transcript_rag');
      expect(transcriptFile.text).toBe('Speaker 1: Hello');
      expect(transcriptFile.sourceFileId).toBe(response.body.sourceFile.file_id);

      const sourceFile = await File.findOne({ file_id: response.body.sourceFile.file_id }).lean();
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

      const convo = await Conversation.findOne({ conversationId }).lean();
      expect(convo.files).toEqual(
        expect.arrayContaining([
          sourceFile.file_id,
          'source-file-transcript',
          diarizationDetailFileId,
        ]),
      );
      expect(convo.files).toHaveLength(3);
      // Dual-write, same as Phase 1.
      expect(convo.transcription).toBeTruthy();

      expect(sourceFile.transcription).toMatchObject({
        status: 'ready',
        transcriptFileId: 'source-file-transcript',
        diarizationDetailFileId,
      });
      expect(sourceFile.transcription.jobId).toEqual(expect.any(String));
      expect(sourceFile.transcription.instanceId).toEqual(expect.any(String));
      expect(sourceFile.transcription.startedAt).toBeTruthy();
      expect(sourceFile.transcription.completedAt).toBeTruthy();
    });

    // transcription/ARCHITECTURE.md §12 #12: the composer intercept used to
    // leave the recording with no visible trace in the conversation until
    // the user manually sent a message carrying it - reported directly as
    // "goes to blank canvas" once the panel-only navigate was tried instead.
    // A real, persisted message is what makes it show up immediately, the
    // same way any other attachment does, via the ordinary messages query -
    // `saveMessage` requires a UUID-shaped `conversationId` (real callers
    // always mint one via `v4()`), unlike this file's other fixtures.
    it('creates a real user message carrying the source file, rooted at NO_PARENT for a brand-new conversation', async () => {
      const conversationId = crypto.randomUUID();

      const response = await uploadFile(conversationId, 'recording.mp3');
      expect(response.status).toBe(202);

      const message = await Message.findOne({ conversationId }).lean();
      expect(message).not.toBeNull();
      expect(message.isCreatedByUser).toBe(true);
      expect(message.parentMessageId).toBe(Constants.NO_PARENT);
      expect(message.files).toHaveLength(1);
      expect(message.files[0]).toMatchObject({
        file_id: response.body.sourceFile.file_id,
        filename: response.body.sourceFile.filename,
      });
      expect(response.body.messageId).toBe(message.messageId);

      // `saveConvo` re-derives `messages` from what's actually persisted -
      // the conversation's pointer must include this message right away,
      // not just once transcription later calls `saveConvo` again itself.
      const convo = await Conversation.findOne({ conversationId }).lean();
      expect(convo.messages.map(String)).toContain(String(message._id));
    });

    it('creates the conversation and queues the source file before transcribeAndEmbed is ever called', async () => {
      const conversationId = `convo-${Date.now()}`;
      let stateWhileTranscribing;

      mockTranscribeAndEmbed.mockImplementation(async () => {
        const convo = await Conversation.findOne({ conversationId }).lean();
        const files = await File.find({ conversationId }).lean();
        stateWhileTranscribing = { convo, sourceFile: files[0] };
        return DEFAULT_RESULT;
      });

      const response = await uploadFile(conversationId);
      expect(response.status).toBe(202);
      await onIdle();

      expect(stateWhileTranscribing.convo).not.toBeNull();
      expect(stateWhileTranscribing.sourceFile.transcription.status).toBe('transcribing');
    });

    it('keeps the conversation and source file when the job fails - marks transcription failed instead of deleting anything', async () => {
      const conversationId = `convo-${Date.now()}`;
      mockTranscribeAndEmbed.mockRejectedValue(new Error('diarization produced no segments'));

      const response = await uploadFile(conversationId);
      expect(response.status).toBe(202);
      const sourceFileId = response.body.sourceFile.file_id;

      await onIdle();

      // Nothing rolled back - this is the behavior change §5.1 exists for.
      const convo = await Conversation.findOne({ conversationId }).lean();
      expect(convo).not.toBeNull();
      const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
      expect(sourceFile).not.toBeNull();
      expect(sourceFile.transcription.status).toBe('failed');
      expect(sourceFile.transcription.error).toMatch(/diarization produced no segments/i);
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

    it('does not create a transcript file when no speech is detected, but still marks the job ready', async () => {
      mockTranscribeAndEmbed.mockResolvedValue({
        segments: [],
        language: 'en',
        diagnostics: {},
        text: '',
        transcriptFileId: null,
        embedded: false,
      });
      const conversationId = `convo-${Date.now()}`;

      const response = await uploadFile(conversationId, 'silent.mp3');
      expect(response.status).toBe(202);
      await onIdle();

      const sourceFile = await File.findOne({ file_id: response.body.sourceFile.file_id }).lean();
      expect(sourceFile.transcription.status).toBe('ready');
      expect(sourceFile.transcription.transcriptFileId).toBeNull();

      const convo = await Conversation.findOne({ conversationId }).lean();
      expect(convo.files).toEqual([sourceFile.file_id]);
    });

    // Phase 4 (transcription/ARCHITECTURE.md §6.1): the composer calls this
    // same route against a conversation that already exists, unlike the
    // standalone page's always-fresh id.
    describe('against an existing conversation (Phase 4 composer integration)', () => {
      it('attaches the source file without touching the conversation title/endpoint', async () => {
        const conversationId = `existing-convo-${Date.now()}`;
        await Conversation.create({
          conversationId,
          user: userId,
          title: 'My real conversation title',
          endpoint: 'openAI',
          files: [],
        });

        const response = await uploadFile(conversationId, 'recording.mp3');
        expect(response.status).toBe(202);
        await onIdle();

        const convo = await Conversation.findOne({ conversationId }).lean();
        expect(convo.title).toBe('My real conversation title');
        expect(convo.endpoint).toBe('openAI');
        expect(convo.files).toContain(response.body.sourceFile.file_id);

        const sourceFile = await File.findOne({ file_id: response.body.sourceFile.file_id }).lean();
        expect(sourceFile.transcription.status).toBe('ready');
      });

      it("links the new message onto the conversation's current branch via parentMessageId", async () => {
        const conversationId = crypto.randomUUID();
        await Conversation.create({
          conversationId,
          user: userId,
          title: 'Ongoing chat',
          endpoint: 'openAI',
          files: [],
        });
        const leafMessage = await Message.create({
          messageId: crypto.randomUUID(),
          conversationId,
          parentMessageId: Constants.NO_PARENT,
          user: userId,
          isCreatedByUser: true,
          sender: 'User',
          text: 'earlier turn',
        });

        const response = await uploadFile(conversationId, 'recording.mp3', {
          parentMessageId: leafMessage.messageId,
        });
        expect(response.status).toBe(202);

        const newMessage = await Message.findOne({
          conversationId,
          messageId: response.body.messageId,
        }).lean();
        expect(newMessage.parentMessageId).toBe(leafMessage.messageId);
        expect(newMessage.files[0].file_id).toBe(response.body.sourceFile.file_id);
      });

      it('never deletes the existing conversation when the prep phase fails', async () => {
        // Regression guard for the sharper risk here: `conversationCreated`
        // gates the failure-path rollback, which fully deletes the
        // conversation - if it were ever set true for a pre-existing one, a
        // prep-phase failure would delete the user's entire chat, not just
        // this attempt's leftovers.
        const conversationId = `existing-convo-fail-${Date.now()}`;
        await Conversation.create({
          conversationId,
          user: userId,
          title: 'Do not delete me',
          endpoint: 'openAI',
          files: [],
        });

        const { extractAudioTrack } = require('@librechat/api');
        extractAudioTrack.mockRejectedValueOnce(new Error('ffmpeg exploded'));

        const response = await uploadFile(conversationId, 'recording.mp3');
        expect(response.status).toBe(500);

        const convo = await Conversation.findOne({ conversationId }).lean();
        expect(convo).not.toBeNull();
        expect(convo.title).toBe('Do not delete me');
      });
    });
  });

  describe('POST /api/transcribe/probe', () => {
    it('returns the channel count ffprobe reports', async () => {
      mockProbeAudioChannels.mockResolvedValue(2);

      const response = await request(app)
        .post('/api/transcribe/probe')
        .attach('file', tinyAudioBuffer, { filename: 'meeting.mp3', contentType: 'audio/mpeg' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ channelCount: 2 });
      expect(mockTranscribeAndEmbed).not.toHaveBeenCalled();
    });

    it('does not create a File record or a conversation', async () => {
      mockProbeAudioChannels.mockResolvedValue(1);
      const filesBefore = await File.countDocuments({});
      const convosBefore = await Conversation.countDocuments({});

      const response = await request(app)
        .post('/api/transcribe/probe')
        .attach('file', tinyAudioBuffer, { filename: 'meeting.mp3', contentType: 'audio/mpeg' });

      expect(response.status).toBe(200);
      expect(await File.countDocuments({})).toBe(filesBefore);
      expect(await Conversation.countDocuments({})).toBe(convosBefore);
    });

    it('returns 400 when no file is provided', async () => {
      const response = await request(app).post('/api/transcribe/probe');
      expect(response.status).toBe(400);
      expect(mockProbeAudioChannels).not.toHaveBeenCalled();
    });

    it('rejects non audio/video files', async () => {
      const response = await request(app)
        .post('/api/transcribe/probe')
        .attach('file', Buffer.from('not audio'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        });
      expect(response.status).toBe(500);
      expect(mockProbeAudioChannels).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/transcribe/status', () => {
    it('returns status for owned source files', async () => {
      const conversationId = `convo-${Date.now()}`;
      const response = await uploadFile(conversationId);
      await onIdle();
      const sourceFileId = response.body.sourceFile.file_id;

      const statusResponse = await request(app).get('/api/transcribe/status').query({
        fileIds: sourceFileId,
      });

      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.files).toHaveLength(1);
      expect(statusResponse.body.files[0]).toMatchObject({
        file_id: sourceFileId,
        status: 'ready',
        transcriptFileId: 'source-file-transcript',
      });
    });

    it('silently omits a file id not owned by the caller', async () => {
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await File.create({
        user: otherUserId,
        file_id: 'not-mine',
        filename: 'a.m4a',
        filepath: '/tmp/a',
        type: 'audio/mp4',
        bytes: 1,
        source: 'local',
        context: 'transcript_rag',
        transcription: {
          status: 'ready',
          jobId: 'j',
          instanceId: 'i',
          heartbeatAt: new Date(),
        },
      });

      const statusResponse = await request(app)
        .get('/api/transcribe/status')
        .query({ fileIds: 'not-mine' });

      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.files).toEqual([]);
    });

    it('returns 400 when fileIds is missing', async () => {
      const response = await request(app).get('/api/transcribe/status');
      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/transcribe/:sourceFileId/audio-token', () => {
    // transcription/ARCHITECTURE.md §12 #13: mints the token
    // `transcribeStream.js`'s unauthenticated (by `requireJwtAuth`) streaming
    // route relies on in place of an `Authorization` header - own coverage
    // here is ownership/shape only; the token's actual verification and the
    // streaming route it authorizes for are covered end-to-end in
    // transcribeStream.spec.js.
    it('mints a token that verifies to the caller and a url scoped to this source file', async () => {
      const conversationId = `convo-${Date.now()}`;
      const response = await uploadFile(conversationId);
      await onIdle();
      const sourceFileId = response.body.sourceFile.file_id;

      const tokenResponse = await request(app).get(`/api/transcribe/${sourceFileId}/audio-token`);

      expect(tokenResponse.status).toBe(200);
      expect(tokenResponse.body.expiresIn).toEqual(expect.any(Number));
      expect(tokenResponse.body.url).toContain(`/api/transcribe/${sourceFileId}/audio?token=`);

      const token = new URL(tokenResponse.body.url, 'http://localhost').searchParams.get('token');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      expect(decoded.id).toBe(userId);
    });

    it('returns 404 for a source file that does not belong to the caller', async () => {
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await File.create({
        user: otherUserId,
        file_id: 'not-mine-audio-token',
        filename: 'a.m4a',
        filepath: '/tmp/a',
        type: 'audio/mp4',
        bytes: 1,
        source: 'local',
        context: 'transcript_rag',
      });

      const response = await request(app).get('/api/transcribe/not-mine-audio-token/audio-token');
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/transcribe/:sourceFileId/retry', () => {
    it('returns 404 for a source file that does not belong to the caller', async () => {
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await File.create({
        user: otherUserId,
        file_id: 'foreign-retry-target',
        filename: 'a.m4a',
        filepath: '/tmp/a',
        type: 'audio/mp4',
        bytes: 1,
        source: 'local',
        context: 'transcript_rag',
        transcription: { status: 'failed', jobId: 'j', instanceId: 'i', heartbeatAt: new Date() },
      });

      const response = await request(app).post('/api/transcribe/foreign-retry-target/retry');
      expect(response.status).toBe(404);
    });

    it('returns 409 when the job is not currently failed', async () => {
      const conversationId = `convo-${Date.now()}`;
      const response = await uploadFile(conversationId);
      await onIdle();

      const retryResponse = await request(app).post(
        `/api/transcribe/${response.body.sourceFile.file_id}/retry`,
      );
      expect(retryResponse.status).toBe(409);
    });

    it('re-queues a failed job and it can succeed on retry', async () => {
      const conversationId = `convo-${Date.now()}`;
      mockTranscribeAndEmbed.mockRejectedValueOnce(new Error('transient failure'));

      const response = await uploadFile(conversationId);
      const sourceFileId = response.body.sourceFile.file_id;
      await onIdle();
      expect((await File.findOne({ file_id: sourceFileId }).lean()).transcription.status).toBe(
        'failed',
      );

      mockTranscribeAndEmbed.mockResolvedValue(DEFAULT_RESULT);
      const retryResponse = await request(app).post(`/api/transcribe/${sourceFileId}/retry`);
      expect(retryResponse.status).toBe(202);
      expect(retryResponse.body.status).toBe('queued');

      await onIdle();
      const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
      expect(sourceFile.transcription.status).toBe('ready');
      expect(sourceFile.transcription.error).toBeFalsy();
    });
  });

  describe('POST /api/transcribe/:sourceFileId/retranscribe', () => {
    async function seedTranscribedConversation() {
      const conversationId = `convo-retranscribe-${Date.now()}-${Math.random()}`;
      const audioPath = path.join(
        os.tmpdir(),
        `retranscribe-source-${Date.now()}-${Math.random()}.m4a`,
      );
      await fs.promises.writeFile(audioPath, Buffer.from('fake-audio-bytes'));

      const sourceFileId = `source-${Date.now()}-${Math.random()}`;
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
        transcription: {
          status: 'ready',
          jobId: 'j',
          instanceId: 'i',
          heartbeatAt: new Date(),
          transcriptFileId: `${sourceFileId}-transcript`,
        },
      });
      await Conversation.create({
        conversationId,
        user: userId,
        endpoint: 'agents',
        files: [sourceFileId],
      });

      return { conversationId, sourceFileId, audioPath };
    }

    it('re-transcribes the owned source file and links the new transcript back to it', async () => {
      const { conversationId, sourceFileId, audioPath } = await seedTranscribedConversation();
      const transcriptFileId = `${sourceFileId}-transcript`;

      mockTranscribeAndEmbed.mockResolvedValue({
        ...DEFAULT_RESULT,
        text: 'Speaker 1: Hi again',
        transcriptFileId,
      });

      const response = await request(app)
        .post(`/api/transcribe/${sourceFileId}/retranscribe`)
        .send({});

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ conversationId, status: 'queued' });
      expect(mockTranscribeAndEmbed).not.toHaveBeenCalled(); // not yet - queued, not run inline

      await onIdle();
      expect(mockTranscribeAndEmbed).toHaveBeenCalledWith(
        expect.objectContaining({ sourceFileId }),
      );

      const transcriptFile = await File.findOne({ file_id: transcriptFileId }).lean();
      expect(transcriptFile.sourceFileId).toBe(sourceFileId);
      expect(transcriptFile.text).toBe('Speaker 1: Hi again');
      const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
      expect(sourceFile.transcription).toMatchObject({ status: 'ready', transcriptFileId });

      await fs.promises.unlink(audioPath).catch(() => {});
    });

    it('discards existing corrections on retranscribe', async () => {
      const { sourceFileId, audioPath } = await seedTranscribedConversation();
      const transcriptFileId = `${sourceFileId}-transcript`;
      const TranscriptCorrection = mongoose.models.TranscriptCorrection;
      await TranscriptCorrection.create({
        transcriptFileId,
        conversationId: (await File.findOne({ file_id: sourceFileId }).lean()).conversationId,
        user: userId,
        type: 'text_edit',
        lineIndex: 0,
        toText: 'edited',
      });
      expect(await TranscriptCorrection.countDocuments({ transcriptFileId })).toBe(1);

      mockTranscribeAndEmbed.mockResolvedValue({ ...DEFAULT_RESULT, transcriptFileId });
      const response = await request(app)
        .post(`/api/transcribe/${sourceFileId}/retranscribe`)
        .send({});
      expect(response.status).toBe(202);
      await onIdle();

      expect(await TranscriptCorrection.countDocuments({ transcriptFileId })).toBe(0);
      await fs.promises.unlink(audioPath).catch(() => {});
    });

    // R4 (transcription/ARCHITECTURE.md §5.2): the highest-risk item in the
    // whole migration - ownership must be re-verified explicitly now that
    // this route no longer goes through a conversation lookup.
    it('returns 404 for a source file that belongs to a different user (R4)', async () => {
      const otherUserId = new mongoose.Types.ObjectId().toString();
      const conversationId = `convo-foreign-${Date.now()}`;
      await File.create({
        user: otherUserId,
        file_id: 'foreign-retranscribe-target',
        filename: 'a.m4a',
        filepath: '/tmp/a',
        type: 'audio/mp4',
        bytes: 1,
        source: 'local',
        context: 'transcript_rag',
        conversationId,
        transcription: { status: 'ready', jobId: 'j', instanceId: 'i', heartbeatAt: new Date() },
      });
      await Conversation.create({
        conversationId,
        user: otherUserId,
        endpoint: 'agents',
        files: ['foreign-retranscribe-target'],
      });

      const response = await request(app)
        .post('/api/transcribe/foreign-retranscribe-target/retranscribe')
        .send({});

      expect(response.status).toBe(404);
      expect(mockTranscribeAndEmbed).not.toHaveBeenCalled();
    });

    it('returns 404 for a sourceFileId that does not exist at all', async () => {
      const response = await request(app)
        .post('/api/transcribe/does-not-exist/retranscribe')
        .send({});
      expect(response.status).toBe(404);
    });
  });

  describe('docx export ownership (R4)', () => {
    it('interview-docx returns 404 for a source file belonging to a different user', async () => {
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await File.create({
        user: otherUserId,
        file_id: 'foreign-docx-target',
        filename: 'a.m4a',
        filepath: '/tmp/a',
        type: 'audio/mp4',
        bytes: 1,
        source: 'local',
        context: 'transcript_rag',
        transcription: { status: 'ready', jobId: 'j', instanceId: 'i', heartbeatAt: new Date() },
      });

      const response = await request(app)
        .post('/api/transcribe/foreign-docx-target/interview-docx')
        .send({ form: {}, speakers: [] });

      expect(response.status).toBe(404);
    });

    it('meeting-minutes-docx returns 404 for a source file belonging to a different user', async () => {
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await File.create({
        user: otherUserId,
        file_id: 'foreign-docx-target-2',
        filename: 'a.m4a',
        filepath: '/tmp/a',
        type: 'audio/mp4',
        bytes: 1,
        source: 'local',
        context: 'transcript_rag',
        transcription: { status: 'ready', jobId: 'j', instanceId: 'i', heartbeatAt: new Date() },
      });

      const response = await request(app)
        .post('/api/transcribe/foreign-docx-target-2/meeting-minutes-docx')
        .send({ form: {}, speakers: [] });

      expect(response.status).toBe(404);
    });
  });
});
