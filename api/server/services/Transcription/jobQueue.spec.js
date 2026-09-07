const {
  enqueueTranscriptionJob,
  dequeueTranscriptionJob,
  registerActiveController,
  requestCancel,
  wasJobCancelled,
  getQueueDepth,
  onIdle,
} = require('./jobQueue');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('transcription job queue (transcription/ARCHITECTURE.md D5)', () => {
  it('runs a single job and resolves with its result', async () => {
    const result = await enqueueTranscriptionJob(async () => 'done');
    expect(result).toBe('done');
  });

  it("propagates a job's rejection to its own caller, not to other jobs", async () => {
    await expect(
      enqueueTranscriptionJob(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('never runs two jobs concurrently - the second only starts once the first settles', async () => {
    const first = deferred();
    let secondStarted = false;

    const firstJob = enqueueTranscriptionJob(async () => {
      await first.promise;
      return 'first';
    });
    const secondJob = enqueueTranscriptionJob(async () => {
      secondStarted = true;
      return 'second';
    });

    // Give the queue a tick to (incorrectly, if buggy) start the second job.
    await new Promise((r) => setTimeout(r, 20));
    expect(secondStarted).toBe(false);

    first.resolve();
    await expect(firstJob).resolves.toBe('first');
    await expect(secondJob).resolves.toBe('second');
    expect(secondStarted).toBe(true);
  });

  it('runs jobs in FIFO order', async () => {
    const order = [];
    const jobs = [1, 2, 3].map((n) =>
      enqueueTranscriptionJob(async () => {
        order.push(n);
        return n;
      }),
    );
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a failed job does not block the queue - the next job still runs', async () => {
    const failing = enqueueTranscriptionJob(async () => {
      throw new Error('job 1 failed');
    });
    const succeeding = enqueueTranscriptionJob(async () => 'job 2 ok');

    await expect(failing).rejects.toThrow('job 1 failed');
    await expect(succeeding).resolves.toBe('job 2 ok');
  });

  it('getQueueDepth reflects pending + in-flight jobs', async () => {
    const blocker = deferred();
    expect(getQueueDepth()).toBe(0);

    const job1 = enqueueTranscriptionJob(async () => {
      await blocker.promise;
      return 1;
    });
    // job1 is now running (processing=true) - depth should be 1.
    await new Promise((r) => setTimeout(r, 10));
    expect(getQueueDepth()).toBe(1);

    const job2 = enqueueTranscriptionJob(async () => 2);
    expect(getQueueDepth()).toBe(2);

    blocker.resolve();
    await Promise.all([job1, job2]);
    expect(getQueueDepth()).toBe(0);
  });

  describe('onIdle', () => {
    it('resolves immediately when the queue is already empty', async () => {
      await expect(onIdle()).resolves.toBeUndefined();
    });

    it('resolves only once every enqueued job (including one in flight) has settled', async () => {
      const blocker = deferred();
      let idleResolved = false;

      const job = enqueueTranscriptionJob(async () => {
        await blocker.promise;
        return 'done';
      });
      const idle = onIdle().then(() => {
        idleResolved = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(idleResolved).toBe(false);

      blocker.resolve();
      await job;
      await idle;
      expect(idleResolved).toBe(true);
    });

    it('still resolves even if the job it waited on rejected', async () => {
      const job = enqueueTranscriptionJob(async () => {
        throw new Error('boom');
      });
      await expect(job).rejects.toThrow('boom');
      await expect(onIdle()).resolves.toBeUndefined();
    });
  });

  describe('cancellation', () => {
    it('a job enqueued with no jobId is unaffected - existing single-arg callers keep working', async () => {
      const result = await enqueueTranscriptionJob(async () => 'done');
      expect(result).toBe('done');
      // Nothing to cancel - never registered, so this is just a no-op.
      expect(requestCancel('never-enqueued')).toBe(false);
    });

    it('dequeueTranscriptionJob removes a job that has not started yet, rejecting its promise', async () => {
      const blocker = deferred();
      const running = enqueueTranscriptionJob(async () => {
        await blocker.promise;
        return 'running';
      }, 'job-running');
      const queued = enqueueTranscriptionJob(async () => 'should never run', 'job-queued');

      expect(dequeueTranscriptionJob('job-queued')).toBe(true);
      await expect(queued).rejects.toThrow('Job cancelled before it started');

      blocker.resolve();
      await expect(running).resolves.toBe('running');
    });

    it('dequeueTranscriptionJob is a no-op once the job has already started running', async () => {
      const blocker = deferred();
      const running = enqueueTranscriptionJob(async () => {
        await blocker.promise;
        return 'done';
      }, 'already-running');
      await new Promise((r) => setTimeout(r, 10));

      expect(dequeueTranscriptionJob('already-running')).toBe(false);

      blocker.resolve();
      await expect(running).resolves.toBe('done');
    });

    it('requestCancel aborts the registered controller of an already-running job', async () => {
      const blocker = deferred();
      let abortSignalWasAborted = false;

      const job = enqueueTranscriptionJob(async () => {
        const controller = new AbortController();
        registerActiveController('running-with-controller', controller);
        controller.signal.addEventListener('abort', () => {
          abortSignalWasAborted = true;
        });
        await blocker.promise;
        return wasJobCancelled('running-with-controller') ? 'cancelled-outcome' : 'normal-outcome';
      }, 'running-with-controller');

      await new Promise((r) => setTimeout(r, 10));
      expect(requestCancel('running-with-controller')).toBe(true);
      expect(abortSignalWasAborted).toBe(true);
      expect(wasJobCancelled('running-with-controller')).toBe(true);

      blocker.resolve();
      // The job itself decides what to do about being cancelled (here,
      // returning a different value) - `requestCancel` only signals it.
      await expect(job).resolves.toBe('cancelled-outcome');
    });

    it('requestCancel on a still-queued job removes it from the queue instead of trying to abort anything', async () => {
      const blocker = deferred();
      const running = enqueueTranscriptionJob(async () => {
        await blocker.promise;
        return 'running';
      }, 'blocking-job');
      const queued = enqueueTranscriptionJob(async () => 'should never run', 'queued-job');

      expect(requestCancel('queued-job')).toBe(true);
      await expect(queued).rejects.toThrow('Job cancelled before it started');

      blocker.resolve();
      await expect(running).resolves.toBe('running');
    });

    it('wasJobCancelled is false for a job that was never cancelled, and stops being tracked once settled', async () => {
      const jobId = 'settles-normally';
      expect(wasJobCancelled(jobId)).toBe(false);
      await enqueueTranscriptionJob(async () => 'done', jobId);
      // The job's entry in the internal map is cleaned up once it settles -
      // asking about a job id that already finished reports "not cancelled",
      // not a leaked stale record.
      expect(wasJobCancelled(jobId)).toBe(false);
    });
  });
});
