#!/usr/bin/env node

/**
 * LibreChat Black Box Crash Log Analyzer
 *
 * Reads a crash log written by the frontend "black box" logger
 * (`client/src/blackBox`) via its backend endpoint
 * (`packages/api/src/blackBox/logger.ts`) and produces a plain-text report -
 * no DevTools, no live server, no browser needed. Run this after the tab
 * has frozen or the process has been killed.
 *
 * Usage:
 *   npm run analyze-crash-log
 *   node config/analyze-crash-log.js [path-to-log-file]
 *   node config/analyze-crash-log.js --help
 *
 * With no path given, it picks the most recent `api/logs/crash-*.log` file.
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CONTEXT_WINDOW_MS = 2000;
const LONG_FREEZE_THRESHOLD_MS = 5000;
const TOP_N = 10;

function getLogDir() {
  if (process.env.LIBRECHAT_LOG_DIR) {
    return process.env.LIBRECHAT_LOG_DIR;
  }
  return path.join(__dirname, '..', 'api', 'logs');
}

function findLatestCrashLog(logDir) {
  if (!fs.existsSync(logDir)) {
    return null;
  }
  const files = fs
    .readdirSync(logDir)
    .filter((file) => /^crash-\d{4}-\d{2}-\d{2}\.log$/.test(file));
  if (files.length === 0) {
    return null;
  }
  // `crash-YYYY-MM-DD.log` filenames sort chronologically as plain strings.
  files.sort();
  return path.join(logDir, files[files.length - 1]);
}

async function readEntries(filePath) {
  const entries = [];
  let malformedCount = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      malformedCount += 1;
    }
  }
  return { entries, malformedCount };
}

function formatMs(ms) {
  if (ms == null) {
    return 'unknown';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function formatTimestamp(ms) {
  return ms != null ? new Date(ms).toISOString() : 'unknown';
}

function errorSignature(entry) {
  const firstStackLine = entry.stack ? entry.stack.split('\n')[1]?.trim() : undefined;
  return `${entry.message || '(no message)'}${firstStackLine ? ` @ ${firstStackLine}` : ''}`;
}

function analyzeHeartbeatGaps(entries) {
  const gaps = entries.filter((entry) => entry.kind === 'heartbeat-gap');
  gaps.sort((a, b) => (b.gapMs || 0) - (a.gapMs || 0));
  return gaps;
}

function analyzeErrors(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'error') {
      continue;
    }
    const signature = errorSignature(entry);
    const existing = groups.get(signature);
    if (existing) {
      existing.count += 1;
      existing.first = Math.min(existing.first, entry.timestamp);
      existing.last = Math.max(existing.last, entry.timestamp);
    } else {
      groups.set(signature, {
        signature,
        count: 1,
        message: entry.message,
        stack: entry.stack,
        first: entry.timestamp,
        last: entry.timestamp,
      });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

function analyzeLongTasks(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'longtask') {
      continue;
    }
    const key = entry.attribution || entry.name || '(unattributed script)';
    const existing = groups.get(key);
    const duration = entry.duration || 0;
    if (existing) {
      existing.count += 1;
      existing.totalDuration += duration;
      existing.maxDuration = Math.max(existing.maxDuration, duration);
    } else {
      groups.set(key, { key, count: 1, totalDuration: duration, maxDuration: duration });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.totalDuration - a.totalDuration);
}

function countSessionsWithoutEnd(entries) {
  const started = new Set();
  const ended = new Set();
  for (const entry of entries) {
    if (entry.kind === 'session-start') {
      started.add(entry.sessionId);
    } else if (entry.kind === 'session-end') {
      ended.add(entry.sessionId);
    }
  }
  let unended = 0;
  for (const sessionId of started) {
    if (!ended.has(sessionId)) {
      unended += 1;
    }
  }
  return unended;
}

function describeContextEntry(entry) {
  if (entry.kind === 'error') {
    return entry.message;
  }
  if (entry.kind === 'longtask') {
    return `${formatMs(entry.duration)} - ${entry.attribution || entry.name || '(unattributed)'}`;
  }
  return entry.url || '';
}

function findContextAround(entries, timestamp) {
  return entries
    .filter(
      (entry) =>
        entry.kind !== 'heartbeat-gap' &&
        entry.timestamp != null &&
        Math.abs(entry.timestamp - timestamp) <= CONTEXT_WINDOW_MS,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

function buildRecommendations({ worstGap, errorGroups, longTaskGroups, sessionsWithoutEnd }) {
  const recommendations = [];

  if (errorGroups.length > 0) {
    const top = errorGroups[0];
    if (/maximum update depth exceeded/i.test(top.message || '')) {
      recommendations.push(
        `Infinite re-render loop detected (${top.count}x): "${top.message}". This is a classic ` +
          'progressive-slowdown cause in React - a component sets state inside a render/effect ' +
          'that re-triggers itself every cycle, and it gets worse the longer the tab stays open. ' +
          "Fix the component named at the top of that error's stack trace first - it alone can " +
          'fully explain a freeze like this.',
      );
    } else {
      recommendations.push(
        `Most frequent error (${top.count}x): "${top.message}". This is the single highest-signal ` +
          'item in this log - fix it first, then re-run this analyzer against a fresh session.',
      );
    }
  }

  if (worstGap && worstGap.gapMs > LONG_FREEZE_THRESHOLD_MS) {
    recommendations.push(
      `The main thread froze for ${formatMs(worstGap.gapMs)} at ${formatTimestamp(worstGap.timestamp)}. ` +
        'A single block this long usually means a synchronous loop, a large JSON.parse/stringify, ' +
        'or an unbounded operation over a large array (e.g. re-rendering an unvirtualized list on ' +
        'every keystroke or every playback tick). Check the "Context around the worst freeze" ' +
        'section below for what else was happening in that window.',
    );
  }

  if (longTaskGroups.length > 0) {
    const top = longTaskGroups[0];
    recommendations.push(
      `"${top.key}" accounts for the most total main-thread blocking time ` +
        `(${formatMs(top.totalDuration)} across ${top.count} task(s), longest single task ` +
        `${formatMs(top.maxDuration)}). Profile this script/component specifically - it's the ` +
        'best-supported "what to optimize next" answer this log can give.',
    );
  }

  if (sessionsWithoutEnd > 0) {
    recommendations.push(
      `${sessionsWithoutEnd} session(s) in this log have a "session-start" but no matching ` +
        '"session-end" - the tab was very likely force-killed or hard-froze rather than closing ' +
        'normally, which matches the "DevTools itself stopped responding" symptom.',
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'No errors, long tasks, or heartbeat gaps were captured in this log. Either the freeze ' +
        "wasn't reproduced during this session, or it happened after the black box's last flush " +
        'right before the tab died. Try reproducing the freeze again with the black box active, ' +
        'and check that the browser actually reached the crash-logging endpoint (network tab, or ' +
        'server logs for POST /api/blackbox/logs).',
    );
  }

  return recommendations;
}

function printSeparator() {
  console.log('─'.repeat(72));
}

function printReport(filePath, entries, malformedCount) {
  const sessionIds = new Set(entries.map((entry) => entry.sessionId).filter(Boolean));
  const timestamps = entries.map((entry) => entry.timestamp).filter((value) => value != null);
  const earliest = timestamps.length ? Math.min(...timestamps) : null;
  const latest = timestamps.length ? Math.max(...timestamps) : null;

  console.log('📼 LIBRECHAT BLACK BOX - CRASH REPORT');
  printSeparator();
  console.log(`Log file:        ${filePath}`);
  console.log(
    `Entries read:    ${entries.length}${malformedCount ? ` (${malformedCount} malformed lines skipped)` : ''}`,
  );
  console.log(`Sessions:        ${sessionIds.size}`);
  console.log(`Time range:      ${formatTimestamp(earliest)} → ${formatTimestamp(latest)}`);
  console.log('');

  const gaps = analyzeHeartbeatGaps(entries);
  const worstGap = gaps[0] || null;

  console.log('🧊 LONGEST MAIN-THREAD FREEZE');
  printSeparator();
  if (worstGap) {
    console.log(`Duration:   ${formatMs(worstGap.gapMs)}`);
    console.log(`Timestamp:  ${formatTimestamp(worstGap.timestamp)}`);
    console.log(`Session:    ${worstGap.sessionId}`);
    if (gaps.length > 1) {
      console.log(`\nNext ${Math.min(4, gaps.length - 1)} worst gaps:`);
      for (const gap of gaps.slice(1, 5)) {
        console.log(`  - ${formatMs(gap.gapMs)} at ${formatTimestamp(gap.timestamp)}`);
      }
    }

    const context = findContextAround(entries, worstGap.timestamp);
    if (context.length > 0) {
      console.log(`\nContext within ${CONTEXT_WINDOW_MS}ms of the worst freeze:`);
      for (const entry of context) {
        console.log(
          `  [${formatTimestamp(entry.timestamp)}] ${entry.kind}: ${describeContextEntry(entry)}`,
        );
      }
    }
  } else {
    console.log('No heartbeat gaps over the stall threshold were recorded.');
  }
  console.log('');

  const errorGroups = analyzeErrors(entries);
  console.log(`❌ UNIQUE JAVASCRIPT ERRORS (${errorGroups.length} unique, sorted by frequency)`);
  printSeparator();
  if (errorGroups.length === 0) {
    console.log('No errors were captured.');
  } else {
    for (const group of errorGroups.slice(0, TOP_N)) {
      console.log(`\n${group.count}x  ${group.message || '(no message)'}`);
      console.log(
        `     first seen: ${formatTimestamp(group.first)}  last seen: ${formatTimestamp(group.last)}`,
      );
      if (group.stack) {
        console.log('     stack:');
        for (const line of group.stack.split('\n')) {
          console.log(`       ${line}`);
        }
      }
    }
    if (errorGroups.length > TOP_N) {
      console.log(
        `\n… and ${errorGroups.length - TOP_N} more unique error(s), omitted for brevity.`,
      );
    }
  }
  console.log('');

  const longTaskGroups = analyzeLongTasks(entries);
  console.log(
    `🐌 LONGEST-RUNNING SCRIPTS (${longTaskGroups.length} unique, sorted by total blocking time)`,
  );
  printSeparator();
  if (longTaskGroups.length === 0) {
    console.log('No long tasks (>50ms) were captured.');
  } else {
    for (const group of longTaskGroups.slice(0, TOP_N)) {
      console.log(
        `${formatMs(group.totalDuration).padStart(8)} total  ` +
          `${formatMs(group.maxDuration).padStart(8)} max  ` +
          `${String(group.count).padStart(4)}x  ${group.key}`,
      );
    }
    if (longTaskGroups.length > TOP_N) {
      console.log(`\n… and ${longTaskGroups.length - TOP_N} more, omitted for brevity.`);
    }
  }
  console.log('');

  const sessionsWithoutEnd = countSessionsWithoutEnd(entries);
  console.log('💡 RECOMMENDATIONS');
  printSeparator();
  const recommendations = buildRecommendations({
    worstGap,
    errorGroups,
    longTaskGroups,
    sessionsWithoutEnd,
  });
  recommendations.forEach((recommendation, index) => {
    console.log(`${index + 1}. ${recommendation}\n`);
  });
}

function printHelp() {
  console.log(`
LibreChat Black Box Crash Log Analyzer

DESCRIPTION:
  Reads a crash log written by the frontend black box logger and prints a
  report: the longest main-thread freeze, unique JS errors sorted by
  frequency with full stack traces, the scripts causing the longest tasks,
  and concrete recommendations - all without needing DevTools.

USAGE:
  npm run analyze-crash-log
  node config/analyze-crash-log.js [path-to-log-file]
  node config/analyze-crash-log.js --help

With no path given, the most recent api/logs/crash-YYYY-MM-DD.log file is
used (or $LIBRECHAT_LOG_DIR/crash-YYYY-MM-DD.log if that env var is set).
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const explicitPath = args.find((arg) => !arg.startsWith('-'));
  const logDir = getLogDir();
  const filePath = explicitPath ? path.resolve(explicitPath) : findLatestCrashLog(logDir);

  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`❌ No crash log found in ${logDir}`);
    console.error('   Pass an explicit path: node config/analyze-crash-log.js <path-to-log>');
    process.exitCode = 1;
    return;
  }

  const { entries, malformedCount } = await readEntries(filePath);
  if (entries.length === 0) {
    console.error(`❌ ${filePath} contains no readable entries.`);
    process.exitCode = 1;
    return;
  }

  printReport(filePath, entries, malformedCount);
}

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled error:', error);
  process.exit(1);
});

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  findLatestCrashLog,
  readEntries,
  analyzeHeartbeatGaps,
  analyzeErrors,
  analyzeLongTasks,
  countSessionsWithoutEnd,
  buildRecommendations,
};
