/**
 * In-process FIFO, capped at 1 job in flight - correct for the confirmed
 * single-instance deployment topology (transcription/ARCHITECTURE.md D4/D5).
 * The Python WhisperX service is itself a process-wide singleton with one
 * resident ASR model and its own locks (`_lock`/`_options_lock`/
 * `_diarize_lock`) - without this cap, two concurrent Node requests don't
 * get two transcriptions, they get one transcription and one request
 * blocked on a Python-side lock, silently burning its own timeout instead
 * of visibly waiting its turn.
 *
 * If a future deployment mode reintroduces multiple Node instances against
 * one shared Python service, this in-process queue stops being sufficient
 * on its own - see D5's note on exactly that failure mode - and needs
 * cross-instance coordination (a Redis job store or `LeaderElection`)
 * instead of (or in front of) this.
 */

const queue = [];
let processing = false;

/**
 * One entry per job currently "in the system" - queued or running - keyed by
 * the `jobId` an enqueue call opts into (typically a `sourceFileId`; omitted
 * entirely by callers, like the existing test suite, that have no need for
 * cancellation). Lives from `enqueueTranscriptionJob` through to the job
 * settling (`processQueue`'s `finally`), independent of whether `queue.shift()`
 * has physically dequeued it yet - `dequeueTranscriptionJob` and
 * `requestCancel` both act on this same entry regardless of which side of
 * that transition the job is on, closing what would otherwise be a race
 * between "cancel this" and "the queue just started running it."
 */
const jobState = new Map();

/**
 * Jobs currently pending or running, including the one in flight (if any).
 * What a caller enqueuing right now would wait behind. A one-time estimate
 * at enqueue time, not a value that ticks down live as a job's position
 * improves.
 */
function getQueueDepth() {
  return queue.length + (processing ? 1 : 0);
}

/**
 * Enqueues one transcription job. `run` is invoked with no arguments once
 * every job ahead of it has settled (resolved or rejected - either way the
 * queue moves on). Returns a promise that settles with `run`'s own
 * result/rejection, so a caller can `await enqueueTranscriptionJob(run)`
 * exactly as it would `await run()` directly - enqueuing changes *when*
 * the work happens, never how its outcome is observed.
 *
 * `jobId`, when given, registers this job for cancellation
 * (`dequeueTranscriptionJob`/`requestCancel`/`wasJobCancelled`) - optional so
 * a caller with no cancellation need (or no natural id, like the existing
 * unit tests) is unaffected.
 */
function enqueueTranscriptionJob(run, jobId) {
  if (jobId != null) {
    jobState.set(jobId, { controller: null, cancelled: false });
  }
  return new Promise((resolve, reject) => {
    queue.push({ jobId, run, resolve, reject });
    processQueue();
  });
}

/**
 * Removes a job from the queue before it's had a chance to run - a no-op
 * (returning `false`) if it's already running, already settled, or was
 * never registered with a `jobId` at all. The removed job's own promise
 * rejects, same as any other job that never gets to run.
 */
function dequeueTranscriptionJob(jobId) {
  const index = queue.findIndex((job) => job.jobId === jobId);
  if (index === -1) {
    return false;
  }
  const [job] = queue.splice(index, 1);
  jobState.delete(jobId);
  job.reject(new Error('Job cancelled before it started'));
  return true;
}

/**
 * Called by the running job itself once it has something abortable (the
 * in-flight HTTP call to the RAG/WhisperX service) - `requestCancel` aborts
 * this if cancellation is requested while the job is already running, rather
 * than only being able to stop a job that hasn't started yet.
 */
function registerActiveController(jobId, controller) {
  const state = jobState.get(jobId);
  if (state) {
    state.controller = controller;
  }
}

/**
 * Best-effort cancel: removes the job from the queue if it hasn't started,
 * or aborts its registered controller if it has. Either way marks it
 * cancelled so the job's own success/failure handling (`wasJobCancelled`)
 * knows not to persist a result that arrives after the fact - the RAG
 * service itself doesn't act on the abort and may keep working briefly, but
 * nothing here waits on or trusts whatever it eventually returns. Returns
 * `false` if `jobId` was never registered (already settled, or enqueued
 * without one).
 */
function requestCancel(jobId) {
  const state = jobState.get(jobId);
  if (!state) {
    return false;
  }
  state.cancelled = true;
  dequeueTranscriptionJob(jobId);
  state.controller?.abort();
  return true;
}

function wasJobCancelled(jobId) {
  return jobState.get(jobId)?.cancelled === true;
}

let idleWaiters = [];

/**
 * Resolves once every currently-enqueued job (including one in flight) has
 * settled - resolves immediately if the queue is already idle. Not just a
 * test seam: the same primitive a graceful-shutdown path would use to drain
 * in-flight work before exiting, rather than abandoning a job mid-run.
 */
function onIdle() {
  if (!processing && queue.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => idleWaiters.push(resolve));
}

async function processQueue() {
  if (processing) {
    return;
  }
  processing = true;
  while (queue.length > 0) {
    const job = queue.shift();
    try {
      const result = await job.run();
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    } finally {
      if (job.jobId != null) {
        jobState.delete(job.jobId);
      }
    }
  }
  processing = false;
  const waiters = idleWaiters;
  idleWaiters = [];
  waiters.forEach((resolve) => resolve());
}

module.exports = {
  enqueueTranscriptionJob,
  dequeueTranscriptionJob,
  registerActiveController,
  requestCancel,
  wasJobCancelled,
  getQueueDepth,
  onIdle,
};
