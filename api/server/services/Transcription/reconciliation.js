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

/** Marker written on a job the owning process abandoned mid-run, rather than
 *  one that genuinely failed. `resumeInterruptedTranscriptions` matches on
 *  exactly this to tell the two apart, so it is a shared constant instead of
 *  a string literal repeated in two files. */
const INTERRUPTED_ERROR = 'Transcription was interrupted. Retry to resume.';

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
          'transcription.error': INTERRUPTED_ERROR,
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
async function startTranscriptionReconciliation(onReconciled) {
  // Every sweep, not only the one at boot: a job abandoned seconds before a
  // restart still has a fresh heartbeat, so the boot sweep does not yet see
  // it as stale. Without running the follow-up after each later sweep too,
  // that job would stay failed until some future restart happened to catch
  // it - exactly the case this recovery exists for.
  const sweep = async (label, { always = false } = {}) => {
    let reconciled = 0;
    try {
      ({ reconciled } = await reconcileStaleTranscriptionJobs());
    } catch (error) {
      logger.error(`[transcription/reconciliation] ${label} failed`, error);
      if (!always) {
        return;
      }
    }
    if ((always || reconciled > 0) && typeof onReconciled === 'function') {
      try {
        await onReconciled();
      } catch (error) {
        logger.error('[transcription/reconciliation] Follow-up after sweep failed', error);
      }
    }
  };

  // The boot sweep always runs the follow-up, even having reconciled nothing:
  // a job abandoned by a previous process was already marked failed by that
  // process's own sweep, so this one finds nothing stale while the job still
  // needs recovering. Later sweeps only follow up on what they just marked,
  // so an idle server is not re-checking storage every five minutes.
  await sweep('Initial sweep', { always: true });
  if (sweepInterval) {
    return;
  }
  sweepInterval = setInterval(() => {
    void sweep('Sweep');
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
  INTERRUPTED_ERROR,
  STALE_THRESHOLD_MS,
  SWEEP_INTERVAL_MS,
  reconcileStaleTranscriptionJobs,
  startTranscriptionReconciliation,
  stopTranscriptionReconciliation,
};
