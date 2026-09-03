const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Mock the config/connect module to prevent connection attempts during tests
jest.mock('../connect', () => jest.fn().mockResolvedValue(true));

// Disable console for tests
logger.silent = true;

describe('migrate-transcription-to-file (transcription/ARCHITECTURE.md §4.4)', () => {
  let mongoServer;
  let Conversation, File;
  let migrateTranscriptionToFile;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const dbModels = require('~/db/models');
    Conversation = dbModels.Conversation;
    File = dbModels.File;

    ({ migrateTranscriptionToFile } = require('../migrate-transcription-to-file'));
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Conversation.deleteMany({});
    await File.deleteMany({});
  });

  const userId = () => new mongoose.Types.ObjectId();

  async function seedTranscribedConversation({
    conversationId,
    tenantId,
    transcription = { model: 'large-v3-turbo', language: 'en', diarize: true },
  }) {
    const uid = userId();
    const sourceFileId = `source-${conversationId}`;
    const transcriptFileId = `${sourceFileId}-transcript`;
    const diarizationDetailFileId = `${sourceFileId}-diarization-detail`;

    await File.create({
      user: uid,
      file_id: sourceFileId,
      filename: 'meeting.m4a',
      filepath: `/tmp/${sourceFileId}`,
      type: 'audio/mp4',
      bytes: 1,
      source: 'local',
      context: 'transcript_rag',
      conversationId,
      tenantId,
    });
    await File.create({
      user: uid,
      file_id: transcriptFileId,
      filename: 'meeting-transcript.md',
      filepath: `transcript://${transcriptFileId}`,
      type: 'text/markdown',
      bytes: 1,
      source: 'text',
      text: 'Speaker 1: hi',
      context: 'transcript_rag',
      conversationId,
      tenantId,
    });
    await File.create({
      user: uid,
      file_id: diarizationDetailFileId,
      filename: 'meeting-diarization-detail.json',
      filepath: `transcript-diarization-detail://${diarizationDetailFileId}`,
      type: 'application/json',
      bytes: 1,
      source: 'text',
      text: '{}',
      context: 'transcript_diarization_detail',
      conversationId,
      tenantId,
    });
    await Conversation.create({
      conversationId,
      user: uid,
      endpoint: 'agents',
      tenantId,
      files: [sourceFileId, transcriptFileId, diarizationDetailFileId],
      transcription,
    });

    return { sourceFileId, transcriptFileId, diarizationDetailFileId };
  }

  it('dry-run reports what it would migrate without writing anything', async () => {
    const { sourceFileId } = await seedTranscribedConversation({ conversationId: 'convo-1' });

    const result = await migrateTranscriptionToFile({ dryRun: true });

    expect(result.scannedConversations).toBe(1);
    expect(result.migrated).toBe(1);
    expect(result.errors).toBe(0);

    const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
    expect(sourceFile.transcription).toBeUndefined();
  });

  it('apply mode backfills transcription onto the source file and sourceFileId onto the transcript', async () => {
    const { sourceFileId, transcriptFileId, diarizationDetailFileId } =
      await seedTranscribedConversation({
        conversationId: 'convo-2',
        transcription: { model: 'large-v3-turbo', language: 'en', diarize: true, minSpeakers: 2 },
      });

    const result = await migrateTranscriptionToFile({ dryRun: false });

    expect(result.migrated).toBe(1);

    const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
    expect(sourceFile.transcription).toMatchObject({
      status: 'ready',
      transcriptFileId,
      diarizationDetailFileId,
      effectiveOptions: expect.objectContaining({ model: 'large-v3-turbo', minSpeakers: 2 }),
    });
    // The original request was never captured historically - only the
    // server-resolved values survived. Deliberately omitted rather than set
    // to `{}` (which Mongoose's `minimize` would strip anyway) - see
    // IFileTranscriptionJob.requestedOptions's own comment.
    expect(sourceFile.transcription.requestedOptions).toBeUndefined();
    expect(sourceFile.transcription.jobId).toEqual(expect.any(String));

    const transcriptFile = await File.findOne({ file_id: transcriptFileId }).lean();
    expect(transcriptFile.sourceFileId).toBe(sourceFileId);
  });

  it('is idempotent - a second run leaves an already-migrated file untouched', async () => {
    const { sourceFileId } = await seedTranscribedConversation({ conversationId: 'convo-3' });

    await migrateTranscriptionToFile({ dryRun: false });
    const firstPass = await File.findOne({ file_id: sourceFileId }).lean();

    const result = await migrateTranscriptionToFile({ dryRun: false });
    expect(result.migrated).toBe(0);
    expect(result.alreadyMigrated).toBe(1);

    const secondPass = await File.findOne({ file_id: sourceFileId }).lean();
    expect(secondPass.transcription.jobId).toBe(firstPass.transcription.jobId);
  });

  it('logs unresolved conversations (no source file id) instead of guessing', async () => {
    await Conversation.create({
      conversationId: 'convo-unresolvable',
      user: userId(),
      endpoint: 'agents',
      files: [],
      transcription: { model: 'large-v3-turbo' },
    });

    const result = await migrateTranscriptionToFile({ dryRun: true });

    expect(result.unresolved).toBe(1);
    expect(result.details[0]).toMatchObject({ conversationId: 'convo-unresolvable' });
  });

  it('scopes to one tenant via --tenant, leaving other tenants untouched', async () => {
    const { sourceFileId: sourceA } = await seedTranscribedConversation({
      conversationId: 'convo-tenant-a',
      tenantId: 'tenant-a',
    });
    const { sourceFileId: sourceB } = await seedTranscribedConversation({
      conversationId: 'convo-tenant-b',
      tenantId: 'tenant-b',
    });

    const result = await migrateTranscriptionToFile({ dryRun: false, tenant: 'tenant-a' });
    expect(result.scannedConversations).toBe(1);

    const sourceFileA = await File.findOne({ file_id: sourceA }).lean();
    expect(sourceFileA.transcription).toBeDefined();

    const sourceFileB = await File.findOne({ file_id: sourceB }).lean();
    expect(sourceFileB.transcription).toBeUndefined();
  });

  it('rollback undoes exactly what the migration wrote', async () => {
    const { sourceFileId, transcriptFileId } = await seedTranscribedConversation({
      conversationId: 'convo-rollback',
    });
    await migrateTranscriptionToFile({ dryRun: false });

    const result = await migrateTranscriptionToFile({ dryRun: false, rollback: true });
    expect(result.sourcesRolledBack).toBe(1);
    expect(result.transcriptsRolledBack).toBe(1);

    const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
    expect(sourceFile.transcription).toBeUndefined();
    const transcriptFile = await File.findOne({ file_id: transcriptFileId }).lean();
    expect(transcriptFile.sourceFileId).toBeUndefined();
  });

  it('rollback never touches a live (non-migration) transcription record', async () => {
    const { sourceFileId } = await seedTranscribedConversation({ conversationId: 'convo-live' });
    // Simulate what the live route writes (§5.1) - a real instanceId, not
    // the migration sentinel.
    await File.updateOne(
      { file_id: sourceFileId },
      {
        $set: {
          transcription: {
            status: 'ready',
            jobId: 'live-job',
            instanceId: 'some-real-host',
            heartbeatAt: new Date(),
            requestedOptions: {},
          },
        },
      },
    );

    const result = await migrateTranscriptionToFile({ dryRun: false, rollback: true });
    expect(result.sourcesRolledBack).toBe(0);

    const sourceFile = await File.findOne({ file_id: sourceFileId }).lean();
    expect(sourceFile.transcription.jobId).toBe('live-job');
  });
});
