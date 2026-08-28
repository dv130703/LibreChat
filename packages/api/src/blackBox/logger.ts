import fs from 'fs';
import path from 'path';
import { logger } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';

/**
 * "Black box" crash logging - a second, independent channel for capturing
 * what's happening in a tab right before it freezes solid enough that
 * DevTools itself stops responding. Everything here optimizes for one
 * property above all others: this logger must never be the reason anything
 * else breaks. Every write is fire-and-forget, every failure is swallowed
 * (and reported through the app's own logger, not thrown), and the request
 * handler responds before the disk write even starts.
 */

export type BlackBoxEntryKind =
  | 'error'
  | 'longtask'
  | 'heartbeat-gap'
  | 'session-start'
  | 'session-end';

export interface BlackBoxLogEntry {
  kind: BlackBoxEntryKind;
  sessionId: string;
  /** `Date.now()` (or `performance.now()`-derived epoch ms) at the client. */
  timestamp: number;
  message?: string;
  stack?: string;
  /** Long-task duration in ms, or the heartbeat gap in ms. */
  duration?: number;
  name?: string;
  attribution?: string;
  gapMs?: number;
  url?: string;
}

type BlackBoxRequest = Request<unknown, unknown, unknown> & { user?: IUser };

const MAX_ENTRIES_PER_REQUEST = 500;
const MAX_LONG_STRING = 8000;
const MAX_SHORT_STRING = 500;

const VALID_KINDS: ReadonlySet<string> = new Set<BlackBoxEntryKind>([
  'error',
  'longtask',
  'heartbeat-gap',
  'session-start',
  'session-end',
]);

function truncate(value: string | undefined, max: number): string | undefined {
  if (value == null) {
    return undefined;
  }
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Accepts whatever the client sent and keeps only what's actually usable -
 * a truncated or malformed beacon (plausible from a tab that's already mid-
 * freeze) should degrade to "drop the bad entries," never throw and lose
 * the whole batch along with it.
 */
export function sanitizeBlackBoxEntries(body: unknown): BlackBoxLogEntry[] {
  const rawEntries = Array.isArray(body) ? body : [body];
  const entries: BlackBoxLogEntry[] = [];

  for (const raw of rawEntries.slice(0, MAX_ENTRIES_PER_REQUEST)) {
    if (raw == null || typeof raw !== 'object') {
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const kind = candidate.kind;
    const sessionId = candidate.sessionId;
    const timestamp = candidate.timestamp;
    if (
      typeof kind !== 'string' ||
      !VALID_KINDS.has(kind) ||
      typeof sessionId !== 'string' ||
      typeof timestamp !== 'number'
    ) {
      continue;
    }
    entries.push({
      kind: kind as BlackBoxEntryKind,
      sessionId,
      timestamp,
      message: truncate(
        typeof candidate.message === 'string' ? candidate.message : undefined,
        MAX_LONG_STRING,
      ),
      stack: truncate(
        typeof candidate.stack === 'string' ? candidate.stack : undefined,
        MAX_LONG_STRING,
      ),
      duration: typeof candidate.duration === 'number' ? candidate.duration : undefined,
      name: truncate(
        typeof candidate.name === 'string' ? candidate.name : undefined,
        MAX_SHORT_STRING,
      ),
      attribution: truncate(
        typeof candidate.attribution === 'string' ? candidate.attribution : undefined,
        MAX_SHORT_STRING,
      ),
      gapMs: typeof candidate.gapMs === 'number' ? candidate.gapMs : undefined,
      url: truncate(typeof candidate.url === 'string' ? candidate.url : undefined, MAX_LONG_STRING),
    });
  }

  return entries;
}

interface BlackBoxWriteContext {
  userId?: string;
  ip?: string;
}

interface BlackBoxWriter {
  write: (entry: BlackBoxLogEntry, context: BlackBoxWriteContext) => void;
}

function currentDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One append-mode stream, reused across requests and rotated by UTC date -
 * opening a fresh `fs.createWriteStream` per entry would mean this (already
 * best-effort) logger adds file-descriptor churn on top of whatever's
 * already making the app struggle.
 */
export function createBlackBoxWriter(logDir: string): BlackBoxWriter {
  let stream: fs.WriteStream | null = null;
  let streamDate = '';

  function ensureStream(): fs.WriteStream | null {
    const today = currentDateStamp();
    if (stream && streamDate === today) {
      return stream;
    }
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const filePath = path.join(logDir, `crash-${today}.log`);
      const nextStream = fs.createWriteStream(filePath, { flags: 'a' });
      // An unhandled 'error' on a stream is an uncaught exception by default -
      // the one failure mode a "never crash the server" logger cannot afford,
      // however unlikely (disk full, permission denied, ...).
      nextStream.on('error', (error) => {
        logger.warn('[blackBox] crash log stream error', { error: error.message });
      });
      stream?.end();
      stream = nextStream;
      streamDate = today;
    } catch (error) {
      logger.warn('[blackBox] failed to open crash log file', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    return stream;
  }

  return {
    write(entry, context) {
      try {
        const target = ensureStream();
        if (!target) {
          return;
        }
        const line = JSON.stringify({
          ...entry,
          receivedAt: new Date().toISOString(),
          ...context,
        });
        target.write(line + '\n');
      } catch (error) {
        logger.warn('[blackBox] failed to serialize crash log entry', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * Express handler factory. `logDir` is supplied by the caller (the `api/`
 * layer, which knows where `api/logs` actually lives on disk) rather than
 * resolved here - this package has no stable relative path to it once
 * compiled to `dist/`. The handler responds as soon as the batch is
 * validated; the disk write happens after, fire-and-forget.
 */
export function createBlackBoxRequestHandler(logDir: string) {
  const writer = createBlackBoxWriter(logDir);

  return function handleBlackBoxLogs(req: Request, res: Response): void {
    const typedReq = req as BlackBoxRequest;
    try {
      const entries = sanitizeBlackBoxEntries(typedReq.body);
      res.status(202).json({ received: entries.length });

      const context: BlackBoxWriteContext = {
        userId: typedReq.user?.id,
        ip: typedReq.ip,
      };
      for (const entry of entries) {
        writer.write(entry, context);
      }
    } catch (error) {
      // Still never throw - a failure here, after the response may already
      // be in flight, would otherwise surface as an unhandled rejection.
      logger.warn('[blackBox] failed to handle crash log batch', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(202).json({ received: 0 });
      }
    }
  };
}
