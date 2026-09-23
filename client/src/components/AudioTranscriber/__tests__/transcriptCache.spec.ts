import {
  TranscriptCache,
  type CachedTranscript,
  type TranscriptCacheBackend,
} from '../transcriptCache';

/** In-memory stand-in for the IndexedDB backend. The cache's real logic -
 *  user scoping, byte budget, LRU eviction, oversize rejection - is all
 *  storage-agnostic, so it is exercised for real here; only the IndexedDB
 *  binding itself is swapped out (jsdom provides no IndexedDB, and this
 *  avoids adding a dev dependency purely to fake one). */
function makeBackend(): TranscriptCacheBackend & { entries: Map<string, CachedTranscript> } {
  const entries = new Map<string, CachedTranscript>();
  return {
    entries,
    get: async (key) => entries.get(key),
    put: async (entry) => {
      entries.set(entry.key, entry);
    },
    delete: async (key) => {
      entries.delete(key);
    },
    list: async () => Array.from(entries.values()),
    clear: async () => {
      entries.clear();
    },
  };
}

const USER = 'user-1';

describe('TranscriptCache', () => {
  it('returns what was written for the same user and transcript', async () => {
    const cache = new TranscriptCache(makeBackend());
    await cache.write(USER, 'transcript-1', 'hello world');

    expect(await cache.read(USER, 'transcript-1')).toBe('hello world');
  });

  it('returns undefined for a transcript that was never cached', async () => {
    const cache = new TranscriptCache(makeBackend());
    expect(await cache.read(USER, 'missing')).toBeUndefined();
  });

  /** Interview transcripts are sensitive: a second account signing in on the
   *  same machine must never read the first account's cached content. */
  it("never returns one user's transcript to another user", async () => {
    const cache = new TranscriptCache(makeBackend());
    await cache.write(USER, 'transcript-1', 'confidential interview');

    expect(await cache.read('user-2', 'transcript-1')).toBeUndefined();
  });

  it('clears everything on logout', async () => {
    const backend = makeBackend();
    const cache = new TranscriptCache(backend);
    await cache.write(USER, 'transcript-1', 'a');
    await cache.write(USER, 'transcript-2', 'b');

    await cache.clear();

    expect(backend.entries.size).toBe(0);
    expect(await cache.read(USER, 'transcript-1')).toBeUndefined();
  });

  /** The OOM guard: one pathologically large transcript must not be allowed
   *  to consume the whole budget (or blow past it on its own). */
  it('refuses to cache a single transcript larger than the per-entry cap', async () => {
    const backend = makeBackend();
    const cache = new TranscriptCache(backend, { maxCacheBytes: 100, maxEntryBytes: 40 });

    await cache.write(USER, 'huge', 'x'.repeat(100));

    expect(backend.entries.size).toBe(0);
    expect(await cache.read(USER, 'huge')).toBeUndefined();
  });

  it('keeps total stored bytes within the budget by evicting', async () => {
    const backend = makeBackend();
    // Tiny budget: 100 bytes total, 100 per entry. Each 20-char chunk costs
    // 40 bytes, so a fourth write cannot fit alongside the first three.
    const cache = new TranscriptCache(backend, { maxCacheBytes: 100, maxEntryBytes: 100 });
    const chunk = 'x'.repeat(20);

    for (const id of ['t1', 't2', 't3', 't4']) {
      await cache.write(USER, id, chunk);
    }

    const total = (await backend.list()).reduce((sum, entry) => sum + entry.bytes, 0);
    expect(total).toBeLessThanOrEqual(100);
    expect(backend.entries.size).toBeGreaterThan(0);
  });

  it('evicts least-recently-read first, keeping what was read most recently', async () => {
    const backend = makeBackend();
    // Room for exactly two 40-byte entries, so the third write must evict one.
    const cache = new TranscriptCache(backend, { maxCacheBytes: 100, maxEntryBytes: 100 });
    const chunk = 'x'.repeat(20);

    await cache.write(USER, 'old', chunk);
    await cache.write(USER, 'recent', chunk);
    // Touching 'old' makes it the most recently used, so the next write
    // must evict 'recent' instead of it.
    await cache.read(USER, 'old');
    await cache.write(USER, 'newest', chunk);

    expect(await cache.read(USER, 'old')).toBe(chunk);
    expect(await cache.read(USER, 'recent')).toBeUndefined();
  });

  /** The cache is a convenience, never a correctness dependency - a browser
   *  with IndexedDB blocked (private mode, storage disabled) must degrade to
   *  "no cache", not break the panel. */
  it('degrades quietly when the backend throws', async () => {
    const failing: TranscriptCacheBackend = {
      get: async () => {
        throw new Error('storage blocked');
      },
      put: async () => {
        throw new Error('storage blocked');
      },
      delete: async () => {
        throw new Error('storage blocked');
      },
      list: async () => {
        throw new Error('storage blocked');
      },
      clear: async () => {
        throw new Error('storage blocked');
      },
    };
    const cache = new TranscriptCache(failing);

    await expect(cache.write(USER, 't1', 'text')).resolves.toBeUndefined();
    await expect(cache.read(USER, 't1')).resolves.toBeUndefined();
    await expect(cache.clear()).resolves.toBeUndefined();
  });
});
