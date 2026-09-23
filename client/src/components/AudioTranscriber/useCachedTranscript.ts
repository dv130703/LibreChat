import { useEffect, useState } from 'react';
import { getTranscriptCache } from './transcriptCache';

/**
 * Offline/reload fallback for a transcript's text.
 *
 * Stale-while-revalidate: returns whatever was last cached for this
 * transcript so the panel can paint immediately (or at all, with no
 * connection), while the caller's own network query runs unchanged
 * alongside it. `freshText` always wins once it arrives, and is what gets
 * written back - the cache never becomes the source of truth, so an edit
 * made on another device can be masked for at most one refetch.
 *
 * Returns `undefined` until a cached value is actually found, so the caller
 * can distinguish "nothing cached" from "cached empty transcript".
 */
export function useCachedTranscript(
  userId: string | undefined,
  transcriptFileId: string | undefined,
  freshText: string | undefined,
): string | undefined {
  const [cachedText, setCachedText] = useState<string | undefined>(undefined);

  // Hydrate from disk. Re-runs per transcript, and drops its result if the
  // panel moved to a different recording while the read was in flight -
  // otherwise a slow read could paint one recording's transcript over
  // another's.
  useEffect(() => {
    if (!userId || !transcriptFileId) {
      setCachedText(undefined);
      return;
    }
    let cancelled = false;
    setCachedText(undefined);
    void getTranscriptCache()
      .read(userId, transcriptFileId)
      .then((text) => {
        if (!cancelled) {
          setCachedText(text);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, transcriptFileId]);

  // Persist whatever the network last returned. Not awaited and not gating
  // any render: a transcript the user is already looking at must never wait
  // on a disk write, and a failed write only costs the next reload its
  // instant paint.
  useEffect(() => {
    if (!userId || !transcriptFileId || freshText == null) {
      return;
    }
    void getTranscriptCache().write(userId, transcriptFileId, freshText);
  }, [userId, transcriptFileId, freshText]);

  return cachedText;
}
