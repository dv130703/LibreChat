const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');

const {
  HEARTBEAT_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  reconcileStaleTranscriptionJobs,
} = require('./reconciliation');

describe('transcription reconciliation sweep (transcription/ARCHITECTURE.md §5.3)', () => {
  let mongoServer;
  let File;
  let modelsToCleanup = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    const models = createModels(mongoose);
    modelsToCleanup = Object.keys(models);
    Object.assign(mongoose.models, models);
    File = mongoose.models.File;
  }, 30000);

  afterAll(async () => {
    for (const modelName of modelsToCleanup) {
      if (mongoose.models[modelName]) {
        delete mongoose.models[modelName];
      }
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await File.deleteMany({});
  });

  const seedSourceFile = (file_id, transcription) =>
    File.create({
      user: new mongoose.Types.ObjectId(),
      file_id,
      filename: 'a.m4a',
      filepath: '/tmp/a',
      type: 'audio/mp4',
      bytes: 1,
      source: 'local',
      context: 'transcript_rag',
      transcription,
    });

  it('keeps the heartbeat/staleness ratio at least 4x', () => {
    expect(STALE_THRESHOLD_MS / HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(4);
  });

  it('fails a transcribing job whose heartbeat has gone stale', async () => {
    await seedSourceFile('stale-job', {
      status: 'transcribing',
      jobId: 'j1',
      instanceId: 'host-1',
      heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      requestedOptions: {},
    });

    const { reconciled } = await reconcileStaleTranscriptionJobs();
    expect(reconciled).toBe(1);

    const file = await File.findOne({ file_id: 'stale-job' }).lean();
    expect(file.transcription.status).toBe('failed');
    expect(file.transcription.error).toMatch(/interrupted/i);
  });

  it('does not touch a transcribing job whose heartbeat is still fresh', async () => {
    await seedSourceFile('fresh-job', {
      status: 'transcribing',
      jobId: 'j2',
      instanceId: 'host-1',
      heartbeatAt: new Date(),
      requestedOptions: {},
    });

    const { reconciled } = await reconcileStaleTranscriptionJobs();
    expect(reconciled).toBe(0);

    const file = await File.findOne({ file_id: 'fresh-job' }).lean();
    expect(file.transcription.status).toBe('transcribing');
  });

  it('never touches a job that already reached a terminal state (ready/failed/queued)', async () => {
    await seedSourceFile('already-ready', {
      status: 'ready',
      jobId: 'j3',
      instanceId: 'host-1',
      heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      requestedOptions: {},
    });
    await seedSourceFile('already-failed', {
      status: 'failed',
      error: 'previous failure',
      jobId: 'j4',
      instanceId: 'host-1',
      heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      requestedOptions: {},
    });
    await seedSourceFile('still-queued', {
      status: 'queued',
      jobId: 'j5',
      instanceId: 'host-1',
      heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      requestedOptions: {},
    });

    const { reconciled } = await reconcileStaleTranscriptionJobs();
    expect(reconciled).toBe(0);

    expect((await File.findOne({ file_id: 'already-ready' }).lean()).transcription.status).toBe(
      'ready',
    );
    expect((await File.findOne({ file_id: 'already-failed' }).lean()).transcription.error).toBe(
      'previous failure',
    );
    expect((await File.findOne({ file_id: 'still-queued' }).lean()).transcription.status).toBe(
      'queued',
    );
  });

  it('is idempotent - running twice in a row only reconciles the same job once', async () => {
    await seedSourceFile('stale-again', {
      status: 'transcribing',
      jobId: 'j6',
      instanceId: 'host-1',
      heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      requestedOptions: {},
    });

    const first = await reconcileStaleTranscriptionJobs();
    expect(first.reconciled).toBe(1);

    const second = await reconcileStaleTranscriptionJobs();
    expect(second.reconciled).toBe(0);
  });
});
