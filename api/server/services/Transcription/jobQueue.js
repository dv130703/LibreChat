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
 */
function enqueueTranscriptionJob(run) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    processQueue();
  });
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
    }
  }
  processing = false;
  const waiters = idleWaiters;
  idleWaiters = [];
  waiters.forEach((resolve) => resolve());
}

module.exports = { enqueueTranscriptionJob, getQueueDepth, onIdle };
