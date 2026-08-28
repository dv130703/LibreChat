/**
 * "Black box" crash logger - a second, independent way to see what happened
 * right before the tab freezes, for the case DevTools itself has already
 * stopped responding by the time anyone notices. It does not depend on the
 * console being open, does not depend on the tab staying alive long enough
 * to react to a click, and is cheap enough at every step that it can't
 * plausibly be the thing causing the freeze it's trying to explain:
 *
 *  - `console.error` is wrapped, not polled - every JS error that already
 *    logs is captured for free, stack trace included.
 *  - A `PerformanceObserver` on `"longtask"` entries reports any single
 *    script block over 50ms along with whatever attribution the browser
 *    can offer for it - no timers, no busy-polling.
 *  - A once-a-second heartbeat measures the gap since its own last tick;
 *    if a `setInterval` callback that should fire every 1000ms instead
 *    fires after 1500ms+, the main thread was blocked for the difference,
 *    which is exactly the shape of the freeze this exists to catch.
 *  - Everything is buffered locally and flushed in batches (never one
 *    `fetch` per event), with `navigator.sendBeacon` used specifically for
 *    the moment the tab is going away, since a normal `fetch` there is not
 *    guaranteed to complete.
 *
 * Logs land in `api/logs/crash-YYYY-MM-DD.log` (see
 * `packages/api/src/blackBox/logger.ts`), one JSON object per line. Run
 * `npm run analyze-crash-log` after a freeze/crash to get a report from
 * that file without ever needing to have had DevTools open.
 */

import axios from 'axios';

const ENDPOINT = '/api/blackbox/logs';
const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_STALL_THRESHOLD_MS = 1500;
const FLUSH_INTERVAL_MS = 5000;
/** Caps memory if the backend is unreachable for a while - old entries are
 *  dropped first, since the most recent activity is the most diagnostic. */
const MAX_BUFFERED_ENTRIES = 300;
const MAX_STACK_LENGTH = 4000;
const MAX_MESSAGE_LENGTH = 1000;

type BlackBoxEntryKind = 'error' | 'longtask' | 'heartbeat-gap' | 'session-start' | 'session-end';

interface BlackBoxEntry {
  kind: BlackBoxEntryKind;
  sessionId: string;
  timestamp: number;
  message?: string;
  stack?: string;
  duration?: number;
  name?: string;
  attribution?: string;
  gapMs?: number;
  url?: string;
}

interface LongTaskAttribution {
  containerType?: string;
  containerSrc?: string;
  containerId?: string;
  containerName?: string;
}

interface LongTaskEntry extends PerformanceEntry {
  attribution?: LongTaskAttribution[];
}

let sessionId: string | null = null;
let buffer: BlackBoxEntry[] = [];
let initialized = false;

function getSessionId(): string {
  if (sessionId != null) {
    return sessionId;
  }
  sessionId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return sessionId;
}

function enqueue(entry: BlackBoxEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFERED_ENTRIES) {
    // Drop the oldest half rather than one at a time - under a sustained
    // flood (an error loop, a stuck heartbeat) this avoids doing an O(n)
    // shift on every single push.
    buffer = buffer.slice(buffer.length - MAX_BUFFERED_ENTRIES / 2);
  }
}

function flush(useBeacon: boolean): void {
  if (buffer.length === 0) {
    return;
  }
  const payload = buffer;
  buffer = [];
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    return;
  }

  try {
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      // `sendBeacon` cannot attach custom headers, so this request reaches
      // the backend without the app's Authorization header - the endpoint
      // accepts that (see `api/server/routes/blackBox.js`) and logs it
      // without a userId rather than rejecting it, since this is precisely
      // the one flush that MUST survive the tab closing.
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Reuses whatever the app's own request layer has already set on the
    // shared `axios` instance - the same in-memory token every other
    // authenticated `fetch`/SSE call in this app attaches, read live so a
    // token refresh is picked up automatically without this module needing
    // any React/auth-context wiring of its own.
    const authorization = axios.defaults.headers.common['Authorization'];
    if (typeof authorization === 'string' && authorization) {
      headers['Authorization'] = authorization;
    }
    void fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body,
      keepalive: true,
    }).catch(() => {
      // A dropped batch during a freeze/crash is expected and not worth
      // retrying - retrying would just add more work on a page that's
      // already struggling, and the next scheduled flush will pick up
      // whatever gets buffered next.
    });
  } catch {
    // Telemetry must never become a second source of instability.
  }
}

function overrideConsoleError(): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const error = args.find((arg): arg is Error => arg instanceof Error);
      const message = args
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join(' ')
        .slice(0, MAX_MESSAGE_LENGTH);
      enqueue({
        kind: 'error',
        sessionId: getSessionId(),
        timestamp: Date.now(),
        message,
        stack: error?.stack?.slice(0, MAX_STACK_LENGTH),
      });
    } catch {
      // Never let capturing an error throw a second one.
    }
    original(...args);
  };
}

function formatAttribution(attribution: LongTaskAttribution | undefined): string | undefined {
  if (!attribution) {
    return undefined;
  }
  const parts = [attribution.containerType, attribution.containerSrc, attribution.containerName]
    .filter((part): part is string => Boolean(part))
    .join(' ');
  return parts || undefined;
}

function observeLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined') {
    return;
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LongTaskEntry[]) {
        enqueue({
          kind: 'longtask',
          sessionId: getSessionId(),
          timestamp: Date.now(),
          duration: Math.round(entry.duration),
          name: entry.name,
          attribution: formatAttribution(entry.attribution?.[0]),
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // The "longtask" entry type isn't supported in every browser - nothing
    // to fall back to; the heartbeat still catches the same freezes.
  }
}

function startHeartbeat(): void {
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (gap > HEARTBEAT_STALL_THRESHOLD_MS) {
      enqueue({
        kind: 'heartbeat-gap',
        sessionId: getSessionId(),
        timestamp: Date.now(),
        gapMs: Math.round(gap),
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/** Call once, as early as possible in app bootstrap - see `client/src/main.jsx`. */
export function initBlackBox(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  enqueue({
    kind: 'session-start',
    sessionId: getSessionId(),
    timestamp: Date.now(),
    url: window.location.href,
  });

  overrideConsoleError();
  observeLongTasks();
  startHeartbeat();

  setInterval(() => flush(false), FLUSH_INTERVAL_MS);

  window.addEventListener('pagehide', () => {
    enqueue({
      kind: 'session-end',
      sessionId: getSessionId(),
      timestamp: Date.now(),
      url: window.location.href,
    });
    flush(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush(true);
    }
  });
}
