const { logger, runAsSystem } = require('@librechat/data-schemas');
const { File } = require('~/db/models');

/** How often the worker refreshes `transcription.heartbeatAt` on the source
 *  File doc while a job is actively running - see `jobQueue.js`. */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/** A job whose heartbeat is older than this is considered abandoned (the
 *  process that owned it died or restarted mid-run) rather than merely
 *  slow. Kept at least 4x `HEARTBEAT_INTERVAL_MS` so a GC pause or one slow
 *  write can't get a still-live job reaped - see
 *  `transcription/ARCHITECTURE.md` §5.3. Asserted below rather than left as
 *  two loose constants nobody re-checks after editing one of them. */
const STALE_THRESHOLD_MS = 3 * 60 * 1000;

if (STALE_THRESHOLD_MS < HEARTBEAT_INTERVAL_MS * 4) {
  throw new Error(
    '[transcription/reconciliation] STALE_THRESHOLD_MS must be at least 4x HEARTBEAT_INTERVAL_MS ' +
      `(got ${STALE_THRESHOLD_MS}ms vs ${HEARTBEAT_INTERVAL_MS}ms heartbeat).`,
  );
}

/** How often the sweep itself runs, in addition to once at boot. A process
 *  that's been up for days needs the same protection a freshly-restarted
 *  one does - a stale job isn't only created by a restart, a worker can
 *  also simply crash mid-run without the process itself going down. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Fails any source-audio File doc whose `transcription.status` is still
 * `'transcribing'` but whose heartbeat has gone stale - the durable half of
 * the job-recovery story (`jobQueue.js`'s in-memory FIFO is the other half,
 * and does not survive a process restart on its own). Confirmed
 * single-instance topology (transcription/ARCHITECTURE.md D4) means there
 * is no "which instance owns this job" ambiguity to resolve here - any
 * stale `'transcribing'` record was abandoned by *this* process, in a
 * previous life.
 *
 * Idempotent and safe to call concurrently with itself - the `$set` only
 * ever moves a record from `'transcribing'` to `'failed'`, and the query
 * filter re-checks `status: 'transcribing'` on every call, so a job that
 * legitimately completes (or starts fresh) between two sweeps is never
 * touched.
 *
 * Runs via `runAsSystem` - this is a background sweep with no per-request
 * tenant context of its own, and needs to reconcile stale jobs across every
 * tenant, not just whichever one (if any) happened to be active on the
 * calling async context. `File` carries `applyTenantIsolation`, which
 * throws under `TENANT_ISOLATION_STRICT=true` for any unscoped query - see
 * `sweepOrphanedPreviews` in `api/server/index.js` for the identical
 * pattern on the same collection.
 *
 * @returns {Promise<{ reconciled: number }>}
 */
async function reconcileStaleTranscriptionJobs() {
  const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await runAsSystem(() =>
    File.updateMany(
      {
        'transcription.status': 'transcribing',
        'transcription.heartbeatAt': { $lt: staleBefore },
      },
      {
        $set: {
          'transcription.status': 'failed',
          'transcription.error': 'Transcription was interrupted. Retry to resume.',
        },
      },
    ),
  );
  const reconciled = result.modifiedCount ?? 0;
  if (reconciled > 0) {
    logger.warn(
      `[transcription/reconciliation] Reconciled ${reconciled} stale transcription job(s)`,
    );
  }
  return { reconciled };
}

let sweepInterval = null;

/** Runs the sweep once immediately, then on `SWEEP_INTERVAL_MS`. Called once
 *  at server boot (`api/server/index.js`) - see that file's post-listen
 *  initialization block. `unref()` so a lingering interval never keeps the
 *  process alive on its own during shutdown. */
async function startTranscriptionReconciliation() {
  await reconcileStaleTranscriptionJobs().catch((error) => {
    logger.error('[transcription/reconciliation] Initial sweep failed', error);
  });
  if (sweepInterval) {
    return;
  }
  sweepInterval = setInterval(() => {
    reconcileStaleTranscriptionJobs().catch((error) => {
      logger.error('[transcription/reconciliation] Sweep failed', error);
    });
  }, SWEEP_INTERVAL_MS);
  sweepInterval.unref();
}

/** Test-only: stops the interval so a test suite doesn't leak an open handle. */
function stopTranscriptionReconciliation() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  SWEEP_INTERVAL_MS,
  reconcileStaleTranscriptionJobs,
  startTranscriptionReconciliation,
  stopTranscriptionReconciliation,
};
