const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');

const {
  HEARTBEAT_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  reconcileOrphanedQueuedJobs,
  reconcileStaleTranscriptionJobs,
  startTranscriptionReconciliation,
  stopTranscriptionReconciliation,
  INTERRUPTED_ERROR,
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

  describe('resume follow-up', () => {
    afterEach(() => stopTranscriptionReconciliation());

    /** A restart abandons the job, the sweep marks it failed, and the
     *  follow-up is what actually re-queues it - without being invoked, an
     *  interrupted transcription just sits failed. */
    it('runs the follow-up after a sweep that reconciled something', async () => {
      await seedSourceFile('interrupted-1', {
        status: 'transcribing',
        jobId: 'r1',
        instanceId: 'host-1',
        requestedOptions: {},
        heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      });
      const onReconciled = jest.fn();

      await startTranscriptionReconciliation(onReconciled);

      expect(onReconciled).toHaveBeenCalledTimes(1);
      const file = await File.findOne({ file_id: 'interrupted-1' }).lean();
      expect(file.transcription.error).toBe(INTERRUPTED_ERROR);
    });

    /** A job abandoned by a previous process was already marked failed by
     *  that process's sweep, so this boot finds nothing stale while the job
     *  still needs recovering - recovery cannot be conditional on this
     *  sweep having done something. */
    it('runs the follow-up at boot even when nothing was stale', async () => {
      await seedSourceFile('healthy-1', {
        status: 'transcribing',
        jobId: 'r2',
        instanceId: 'host-1',
        requestedOptions: {},
        heartbeatAt: new Date(),
      });
      const onReconciled = jest.fn();

      await startTranscriptionReconciliation(onReconciled);

      expect(onReconciled).toHaveBeenCalledTimes(1);
    });

    /** A resume that throws must not take the sweep down with it, or one bad
     *  job would stop every later sweep from reconciling anything. */
    it('survives a follow-up that throws', async () => {
      await seedSourceFile('interrupted-2', {
        status: 'transcribing',
        jobId: 'r3',
        instanceId: 'host-1',
        requestedOptions: {},
        heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      });

      await expect(
        startTranscriptionReconciliation(() => {
          throw new Error('download failed');
        }),
      ).resolves.not.toThrow();

      const file = await File.findOne({ file_id: 'interrupted-2' }).lean();
      expect(file.transcription.status).toBe('failed');
    });

    it('works with no follow-up supplied', async () => {
      await seedSourceFile('interrupted-3', {
        status: 'transcribing',
        jobId: 'r4',
        instanceId: 'host-1',
        requestedOptions: {},
        heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000),
      });

      await expect(startTranscriptionReconciliation()).resolves.not.toThrow();

      const file = await File.findOne({ file_id: 'interrupted-3' }).lean();
      expect(file.transcription.status).toBe('failed');
    });
  });

  describe('reconcileOrphanedQueuedJobs', () => {
    /** The in-process queue is empty at boot, so a surviving `queued` row is a
     *  job nothing will ever run. Before this it stayed queued for good: the
     *  heartbeat sweep only matches `transcribing`, and retry only accepts a
     *  failed job, so the recording had no route out at all. */
    it('fails a queued job that no in-process queue is holding any more', async () => {
      await seedSourceFile('orphaned-queued', {
        status: 'queued',
        jobId: 'j-queued',
        instanceId: 'host-1',
        heartbeatAt: new Date(),
        requestedOptions: {},
      });

      const { reconciled } = await reconcileOrphanedQueuedJobs();

      expect(reconciled).toBe(1);
      const after = await File.findOne({ file_id: 'orphaned-queued' }).lean();
      expect(after.transcription.status).toBe('failed');
      expect(after.transcription.error).toBe(INTERRUPTED_ERROR);
    });

    /** A fresh heartbeat is no defence here and must not be treated as one -
     *  the whole point is that this only ever runs when nothing can be queued. */
    it('leaves a running job alone no matter how it is heartbeating', async () => {
      await seedSourceFile('still-running', {
        status: 'transcribing',
        jobId: 'j-running',
        instanceId: 'host-1',
        heartbeatAt: new Date(),
        requestedOptions: {},
      });

      await reconcileOrphanedQueuedJobs();

      const after = await File.findOne({ file_id: 'still-running' }).lean();
      expect(after.transcription.status).toBe('transcribing');
    });
  });
});
