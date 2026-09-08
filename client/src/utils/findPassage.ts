export interface PassageMatch {
  start: number;
  end: number;
}

/** Escapes regex metacharacters and collapses whitespace runs into `\s+`, so
 *  line-wrap/paragraph-spacing differences between a RAG chunk's extracted
 *  text and the same passage as rendered in the previewed file don't defeat
 *  an otherwise-exact match. */
function buildFuzzyPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

/**
 * Locates a retrieved RAG chunk's text inside the full text of the file it
 * was retrieved from, for `FilePreviewDialog` to scroll to and highlight.
 *
 * Tries the whole chunk first, then progressively shorter prefixes of it -
 * a long chunk only needs one stray extraction difference near its end
 * (a hyphenation, a table cell reordered by the PDF extractor, etc.) to
 * defeat a single exact-match attempt outright, and the start of the chunk
 * is what actually anchors the useful jump-to-location anyway. Returns
 * `null`, never a guess, when nothing matches even at the shortest prefix:
 * this is a client-side text search with no character-offset ground truth
 * from ingestion, so a missed highlight (the file still opens, just without
 * a highlight) is the honest outcome - a wrong one would point the user at
 * the wrong passage with the same visual confidence as a right one.
 */
export function findPassage(haystack: string, needle: string): PassageMatch | null {
  const trimmed = needle.trim();
  if (!trimmed || !haystack) {
    return null;
  }

  const tried = new Set<number>();
  for (const rawLength of [trimmed.length, 300, 120]) {
    const length = Math.min(rawLength, trimmed.length);
    if (tried.has(length)) {
      continue;
    }
    tried.add(length);

    let regex: RegExp;
    try {
      regex = new RegExp(buildFuzzyPattern(trimmed.slice(0, length)), 'i');
    } catch {
      continue;
    }

    const match = regex.exec(haystack);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  return null;
}
