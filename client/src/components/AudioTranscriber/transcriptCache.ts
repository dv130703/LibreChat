/**
 * Local, offline-capable cache for transcript text.
 *
 * Exists so reopening a recording - after a reload, a browser restart, or
 * with no connection - paints the transcript immediately instead of waiting
 * on (or failing) a refetch. Deliberately stale-while-revalidate: the
 * network is always authoritative and overwrites whatever is cached the
 * moment it lands, so this can never mask an edit made elsewhere for longer
 * than one refetch.
 *
 * Only the transcript TEXT is cached (~110-150KB for a 2.5-hour interview),
 * never the diarization detail that accompanies it (~2MB for the same
 * recording, and only ever needed server-side for exports) - caching that
 * instead would cost ~13x more for something the panel never reads.
 *
 * IndexedDB rather than localStorage: localStorage is synchronous, so every
 * write of a 150KB transcript would block the main thread mid-interaction,
 * and its ~5MB ceiling would be exhausted by a handful of recordings.
 *
 * The backend is injected rather than hard-wired so the budget/eviction/
 * scoping logic above it is testable without an IndexedDB implementation
 * (jsdom has none).
 */

/** Total bytes this cache may hold across every entry. Past this, the
 *  least-recently-read entries are evicted - the bound that keeps storage
 *  from growing with every recording a user ever opens. */
export const MAX_CACHE_BYTES = 25 * 1024 * 1024;

/** Ceiling for one entry. A transcript beyond this is not cached at all
 *  rather than being allowed to evict everything else to fit: at ~150KB for
 *  a 2.5-hour recording, anything this large is pathological, and the panel
 *  works fine without a cache entry. */
export const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

export interface CachedTranscript {
  /** User-scoped composite key - see `entryKey`. */
  key: string;
  text: string;
  bytes: number;
  cachedAt: number;
  /** Drives LRU eviction; refreshed on every successful read. */
  lastReadAt: number;
}

export interface TranscriptCacheBackend {
  get(key: string): Promise<CachedTranscript | undefined>;
  put(entry: CachedTranscript): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<CachedTranscript[]>;
  clear(): Promise<void>;
}

/** Namespaced by user id so a second account signing in on a shared machine
 *  can never read the first account's cached interview content. Paired with
 *  `clear()` on logout, which removes it from disk entirely. */
function entryKey(userId: string, transcriptFileId: string): string {
  return `${userId}::${transcriptFileId}`;
}

let lastStamp = 0;

/** A wall-clock timestamp guaranteed to differ from the previous one.
 *  Several cache operations can land inside the same millisecond, and plain
 *  `Date.now()` ties leave the eviction order down to sort stability rather
 *  than actual recency - which is how a just-read entry can get evicted
 *  ahead of an older one. Still a real timestamp, so values stay meaningful
 *  across sessions, unlike a bare counter that would reset to zero on
 *  reload and make every persisted entry look ancient. */
function nextStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

function byteLength(text: string): number {
  // Close enough for a budget, and far cheaper than constructing a Blob or
  // a TextEncoder result purely to measure: worst case for UTF-16 content
  // this under-counts, which the per-entry cap already guards against.
  return text.length * 2;
}

export interface TranscriptCacheLimits {
  maxCacheBytes: number;
  maxEntryBytes: number;
}

export class TranscriptCache {
  private readonly limits: TranscriptCacheLimits;

  /** `limits` is overridable so tests can exercise eviction with tiny
   *  budgets instead of allocating tens of megabytes of strings to cross
   *  the real one. */
  constructor(
    private readonly backend: TranscriptCacheBackend,
    limits: Partial<TranscriptCacheLimits> = {},
  ) {
    this.limits = {
      maxCacheBytes: limits.maxCacheBytes ?? MAX_CACHE_BYTES,
      maxEntryBytes: limits.maxEntryBytes ?? MAX_ENTRY_BYTES,
    };
  }

  /** Cached transcript text, or `undefined` when absent, belonging to
   *  another user, or unreadable. Never throws - a browser with storage
   *  blocked (private mode, disabled site data) must degrade to "no cache",
   *  not break the panel. */
  async read(userId: string, transcriptFileId: string): Promise<string | undefined> {
    try {
      const entry = await this.backend.get(entryKey(userId, transcriptFileId));
      if (!entry) {
        return undefined;
      }
      // Touch for LRU, and awaited: leaving it in flight lets a write that
      // follows a read enumerate entries before the touch has landed, so
      // the entry just read looks like the least-recently-used one and gets
      // evicted first - the exact opposite of the intent. One extra put on
      // an already-async path is a negligible cost for a correct order.
      await this.backend.put({ ...entry, lastReadAt: nextStamp() });
      return entry.text;
    } catch {
      return undefined;
    }
  }

  /** Stores transcript text, evicting least-recently-read entries as needed
   *  to stay within `MAX_CACHE_BYTES`. Never throws, for the same reason as
   *  `read`. */
  async write(userId: string, transcriptFileId: string, text: string): Promise<void> {
    const bytes = byteLength(text);
    if (bytes > this.limits.maxEntryBytes) {
      return;
    }
    try {
      const key = entryKey(userId, transcriptFileId);
      const now = nextStamp();
      await this.evictToFit(bytes, key);
      await this.backend.put({ key, text, bytes, cachedAt: now, lastReadAt: now });
    } catch {
      return;
    }
  }

  /** Wipes every cached transcript. Called on logout so interview content
   *  does not outlive the session on a shared machine. */
  async clear(): Promise<void> {
    try {
      await this.backend.clear();
    } catch {
      return;
    }
  }

  /** Frees space for `incomingBytes`, oldest-read first. `replacingKey` is
   *  excluded from the running total since overwriting it reclaims its own
   *  bytes anyway. */
  private async evictToFit(incomingBytes: number, replacingKey: string): Promise<void> {
    const entries = await this.backend.list();
    const others = entries.filter((entry) => entry.key !== replacingKey);
    let total = others.reduce((sum, entry) => sum + entry.bytes, 0) + incomingBytes;
    if (total <= this.limits.maxCacheBytes) {
      return;
    }
    const leastRecentFirst = others.sort((a, b) => a.lastReadAt - b.lastReadAt);
    for (const entry of leastRecentFirst) {
      if (total <= this.limits.maxCacheBytes) {
        return;
      }
      await this.backend.delete(entry.key);
      total -= entry.bytes;
    }
  }
}

const DB_NAME = 'librechat-transcripts';
const DB_VERSION = 1;
const STORE = 'transcripts';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Thin IndexedDB binding. Every method rejects rather than swallowing -
 *  `TranscriptCache` is the layer that decides a storage failure means "no
 *  cache" instead of an error the panel has to handle. */
export function createIndexedDbBackend(): TranscriptCacheBackend {
  async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await openDatabase();
    try {
      return await runRequest(run(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      db.close();
    }
  }

  return {
    get: (key) => withStore('readonly', (store) => store.get(key) as IDBRequest<CachedTranscript>),
    put: async (entry) => {
      await withStore('readwrite', (store) => store.put(entry));
    },
    delete: async (key) => {
      await withStore('readwrite', (store) => store.delete(key));
    },
    list: () => withStore('readonly', (store) => store.getAll() as IDBRequest<CachedTranscript[]>),
    clear: async () => {
      await withStore('readwrite', (store) => store.clear());
    },
  };
}

/** Process-wide instance. Created lazily and tolerantly: a browser with
 *  IndexedDB unavailable entirely (some private modes) must not throw at
 *  import time - `TranscriptCache` then simply never succeeds at anything,
 *  which is the intended degraded behaviour. */
let sharedCache: TranscriptCache | undefined;

export function getTranscriptCache(): TranscriptCache {
  if (!sharedCache) {
    sharedCache = new TranscriptCache(createIndexedDbBackend());
  }
  return sharedCache;
}

/** Wipes every cached transcript. Called on logout so interview content does
 *  not outlive the session on a shared machine. Safe to call when nothing
 *  was ever cached. */
export async function clearTranscriptCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  await getTranscriptCache().clear();
}
