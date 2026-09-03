const { enqueueTranscriptionJob, getQueueDepth, onIdle } = require('./jobQueue');

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
});
