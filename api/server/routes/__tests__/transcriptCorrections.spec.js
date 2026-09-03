const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createMethods } = require('@librechat/data-schemas');

// Only the RAG network call is mocked - everything else (Mongo persistence,
// version bumping, status transitions, the reembed queue) runs for real,
// since that's the behavior this file exists to verify.
jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

const mockEmbedTranscript = jest.fn();
jest.mock('~/server/services/Transcription', () => ({
  embedTranscript: (...args) => mockEmbedTranscript(...args),
}));

describe('transcript-corrections version/index-status lifecycle', () => {
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
      next();
    });

    const router = require('../transcriptCorrections');
    app.use('/api/transcript-corrections', router);
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

  async function seedTranscript({ transcriptFileId, conversationId, text }) {
    const File = mongoose.models.File;
    const Conversation = mongoose.models.Conversation;
    await File.create({
      user: userId,
      file_id: transcriptFileId,
      filename: 'meeting-transcript.md',
      filepath: `transcript://${transcriptFileId}`,
      source: 'text',
      type: 'text/markdown',
      bytes: text.length,
      text,
      embedded: true,
      transcriptVersion: 1,
      indexVersion: 1,
      indexStatus: 'indexed',
      conversationId,
    });
    await Conversation.create({
      conversationId,
      user: userId,
      endpoint: 'agents',
      files: [transcriptFileId],
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('bumps transcriptVersion and converges to indexed after a correction, via the manual reindex endpoint', async () => {
    const conversationId = `convo-${Date.now()}`;
    const transcriptFileId = `transcript-${Date.now()}`;
    await seedTranscript({
      transcriptFileId,
      conversationId,
      text: 'Speaker 1: Hello there.',
    });
    mockEmbedTranscript.mockResolvedValue(true);

    const renameResponse = await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/speaker-rename`)
      .send({ conversationId, speakerId: 'Speaker 1', toName: 'Alicia' });
    expect(renameResponse.status).toBe(200);
    expect(renameResponse.body.type).toBe('speaker_rename');

    // The correction-triggered reembed is fire-and-forget - awaiting the
    // manual reindex endpoint (same per-transcript queue) is what guarantees
    // it has settled before we check the resulting status.
    const reindexResponse = await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/reindex`)
      .send({ conversationId });
    expect(reindexResponse.status).toBe(200);
    expect(reindexResponse.body.indexStatus).toBe('indexed');
    expect(reindexResponse.body.transcriptVersion).toBe(2);
    expect(reindexResponse.body.indexVersion).toBe(2);

    // The corrected text is what actually got sent to embedTranscript, not
    // the original base text.
    expect(mockEmbedTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Alicia: Hello there.') }),
    );

    const statusResponse = await request(app)
      .get(`/api/transcript-corrections/${transcriptFileId}/index-status`)
      .query({ conversationId });
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toEqual({
      transcriptVersion: 2,
      indexVersion: 2,
      indexStatus: 'indexed',
    });
  });

  it('marks the index index_failed (without losing the previous indexVersion) when re-embedding fails', async () => {
    const conversationId = `convo-${Date.now()}`;
    const transcriptFileId = `transcript-${Date.now()}`;
    await seedTranscript({
      transcriptFileId,
      conversationId,
      text: 'Speaker 1: Hello there.',
    });
    mockEmbedTranscript.mockResolvedValue(false);

    await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/text-edit`)
      .send({ conversationId, lineIndex: 0, toText: 'Hello there, everyone.' });

    const reindexResponse = await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/reindex`)
      .send({ conversationId });

    expect(reindexResponse.status).toBe(200);
    expect(reindexResponse.body.indexStatus).toBe('index_failed');
    expect(reindexResponse.body.transcriptVersion).toBe(2);
    // The last known good index was version 1 (seeded) - a failed re-embed
    // must not silently claim version 2 is indexed when it never was.
    expect(reindexResponse.body.indexVersion).toBe(1);
  });

  // I5 (transcription/ARCHITECTURE.md §8): `embedded` only ever upgrades
  // false -> true, never the reverse. A file that was successfully embedded
  // once must stay `embedded: true` even after a later re-embed attempt
  // fails - otherwise a transient RAG hiccup would make the (still valid,
  // still-searchable) previous embedding look like it never happened,
  // pulling in the much bigger regression of raw unembedded text riding
  // along as a fallback in every future prompt. `GET .../index-status`
  // doesn't surface `embedded` in its response shape, so this reads the
  // Mongo document directly rather than relying on that endpoint.
  it('never reverts embedded to false when a re-embed fails after a prior success (I5)', async () => {
    const conversationId = `convo-${Date.now()}`;
    const transcriptFileId = `transcript-${Date.now()}`;
    await seedTranscript({
      transcriptFileId,
      conversationId,
      text: 'Speaker 1: Hello there.',
    });

    const File = mongoose.models.File;
    expect((await File.findOne({ file_id: transcriptFileId })).embedded).toBe(true);

    // A later correction whose re-embed fails.
    mockEmbedTranscript.mockResolvedValue(false);
    await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/text-edit`)
      .send({ conversationId, lineIndex: 0, toText: 'Hello there, everyone.' });
    const failedReindex = await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/reindex`)
      .send({ conversationId });
    expect(failedReindex.body.indexStatus).toBe('index_failed');

    const afterFailure = await File.findOne({ file_id: transcriptFileId });
    expect(afterFailure.embedded).toBe(true);

    // A second correction whose re-embed also fails - still never flips.
    await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/text-edit`)
      .send({ conversationId, lineIndex: 0, toText: 'Hello there, everyone, again.' });
    await request(app)
      .post(`/api/transcript-corrections/${transcriptFileId}/reindex`)
      .send({ conversationId });

    const afterSecondFailure = await File.findOne({ file_id: transcriptFileId });
    expect(afterSecondFailure.embedded).toBe(true);
  });

  it('404s index-status for an unknown transcript file', async () => {
    const conversationId = `convo-${Date.now()}`;
    const Conversation = mongoose.models.Conversation;
    await Conversation.create({
      conversationId,
      user: userId,
      endpoint: 'agents',
      files: [],
    });

    const response = await request(app)
      .get('/api/transcript-corrections/does-not-exist/index-status')
      .query({ conversationId });
    expect(response.status).toBe(404);
  });
});
