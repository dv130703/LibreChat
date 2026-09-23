const { execFile } = require('child_process');

// Time given to a `SIGTERM`'d tree to exit cleanly before `SIGKILL` - long
// enough for a real in-progress GPU job (or sandboxed subprocess) to
// actually release its resources, not just receive the signal.
const GRACE_PERIOD_MS = 10 * 1000;

// How often to check whether our parent died without signalling us - see the
// parent-death watch in `killTreeOnExit`. Frequent enough that an orphaned
// GPU-holding tree is reclaimed in seconds, cheap enough to ignore (one
// integer compare).
const PARENT_CHECK_INTERVAL_MS = 2000;

/**
 * Wires up SIGINT/SIGTERM/SIGHUP handlers on this process that kill `child`
 * and its whole descendant tree, not just `child` itself - the difference
 * that matters when `child` spawns its own subprocesses (a per-job
 * subprocess, a sandboxed execution) that would otherwise survive `child`
 * exiting and become orphaned, still holding whatever resource (a GPU lock,
 * a sandbox) they were using. Requires `child` to have been spawned with
 * `detached: true` (POSIX) so it leads its own process group - every
 * descendant inherits that group automatically, which is what lets a single
 * signal to the negative pid reach all of them at once.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {string} logLabel - prefixes any signal-delivery error, e.g. '[llm-server]'.
 */
function killTreeOnExit(child, logLabel) {
  let shuttingDown = false;

  function killTree(signal) {
    if (child.pid == null) {
      return;
    }
    if (process.platform === 'win32') {
      // No POSIX process groups on Windows - `/T` recurses the kill
      // through the whole child tree instead.
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      return;
    }
    try {
      // Negative pid = signal the whole process group `child` leads, not
      // just `child` itself.
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        console.error(`${logLabel} Failed to signal the process group`, error);
      }
    }
  }

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    killTree(signal);
    const forceKillTimer = setTimeout(() => killTree('SIGKILL'), GRACE_PERIOD_MS);
    forceKillTimer.unref();
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => shutdown(signal));
  }

  // Orphan watch. Every handler above needs a signal to actually arrive,
  // which covers the normal paths: Ctrl+C and closing the terminal both
  // signal the whole foreground process GROUP, so this process is included
  // and tears its tree down. What they miss is the orchestrator
  // (concurrently) dying WITHOUT signalling us - killed by pid from another
  // terminal, SIGKILLed, or crashing - leaving this wrapper holding a
  // detached tree that pins the GPU indefinitely.
  //
  // Watching our own ppid does NOT detect that: npm inserts a `sh` layer
  // between concurrently and this script, and that `sh` survives, so ppid
  // never changes (verified against a real process tree). What does change
  // is that our process-group LEADER - concurrently, whose pid is our pgid
  // - stops existing. Checking for that catches the orphaning regardless of
  // how many intermediate layers npm adds.
  const initialParentPid = process.ppid;
  const groupLeaderPid = readProcessGroupId();
  const orphanWatch = setInterval(() => {
    if (process.ppid !== initialParentPid || !isGroupLeaderAlive(groupLeaderPid)) {
      shutdown('SIGTERM');
    }
  }, PARENT_CHECK_INTERVAL_MS);
  orphanWatch.unref();
}

/** This process's process-group id, or `null` where it can't be read (a
 *  non-Linux platform, or no /proc) - callers then skip the group check and
 *  fall back to the signal handlers alone. */
function readProcessGroupId() {
  try {
    const stat = require('fs').readFileSync('/proc/self/stat', 'utf8');
    // The comm field is parenthesised and may itself contain spaces or
    // parens, so everything before the LAST ')' has to be discarded before
    // the remaining fields line up: state, ppid, pgrp, ...
    const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    const pgrp = Number(fields[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

/** Whether the process-group leader is still running. `true` when unknown,
 *  so an unreadable pgid can never cause a spurious shutdown. A process that
 *  is its own group leader trivially passes.
 *
 *  Deliberately reads the leader's state rather than using `kill(pid, 0)`:
 *  a process that has exited but not yet been reaped by its own parent is a
 *  ZOMBIE, and `kill(pid, 0)` succeeds on zombies (the pid entry still
 *  exists). That made the check pass forever against a concurrently that
 *  was already dead - verified in a real harness - which is precisely the
 *  case this watch exists to catch. */
function isGroupLeaderAlive(groupLeaderPid) {
  if (groupLeaderPid == null || groupLeaderPid === process.pid) {
    return true;
  }
  let stat;
  try {
    stat = require('fs').readFileSync(`/proc/${groupLeaderPid}/stat`, 'utf8');
  } catch {
    // No /proc entry at all: definitively gone on Linux. On a platform
    // without /proc, fall back to the weaker liveness probe rather than
    // declaring a live leader dead.
    if (process.platform !== 'linux') {
      try {
        process.kill(groupLeaderPid, 0);
        return true;
      } catch (error) {
        return error.code !== 'ESRCH';
      }
    }
    return false;
  }
  // Fields line up only after the parenthesised comm field, which may itself
  // contain spaces or parens. First field after it is the state character.
  const state = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .charAt(0);
  return state !== 'Z' && state !== '';
}

module.exports = { killTreeOnExit };
