import type { ParsedLine } from './types';

/** One new line's sort position and time range within a gap being filled. */
export interface GapSlot {
  lineIndex: number;
  seconds: number;
  endSeconds: number;
}

/** Matches `TranscriptRow`'s own end-timestamp formatting, for visual
 *  consistency between an inserted line's displayed start time and the
 *  original lines' around it. Purely for display - unlike the pipeline's own
 *  `[mm:ss.s]` prefixes, an inserted line's timestamp is never re-parsed out
 *  of transcript text, so this doesn't need to match `LINE_PATTERN`'s format
 *  exactly, just read the same way. */
export function formatSlotTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
}

/** Duration (seconds) used for a time bound that has no real neighbor to
 *  anchor to - inserting after the very last line, or into a
 *  degenerate/overlapping gap. Long enough to be usable, short enough that
 *  it obviously invites the reviewer to adjust it rather than looking like
 *  it came from the pipeline itself. */
const FALLBACK_SLOT_DURATION_SECONDS = 3;

/**
 * Computes `count` evenly-spaced slots strictly between `prevLine` and
 * `nextLine` - both a fractional `lineIndex` (so each new line sorts into
 * exactly the right place without renumbering any existing line's identity)
 * and a share of the real time gap between them, so "where it actually
 * happened" comes from the transcript's own surrounding timestamps rather
 * than a guess.
 *
 * `nextLine` is `null` for an insert after the last line - there's no real
 * bound on that side, so a fallback duration is used instead of an unbounded
 * range. Calling this again later with a previously-inserted line as one of
 * the two neighbors (a second insert landing between an original line and
 * one just added) subdivides the same gap further - nothing here treats an
 * inserted line differently from an original one.
 */
export function computeInsertionSlots(
  prevLine: ParsedLine,
  nextLine: ParsedLine | null,
  count: number,
): GapSlot[] {
  const prevIndex = prevLine.lineIndex;
  const nextIndex = nextLine?.lineIndex ?? prevIndex + count + 1;

  const start = prevLine.endSeconds ?? prevLine.seconds ?? 0;
  const rawEnd = nextLine?.seconds;
  const totalDuration =
    rawEnd != null && rawEnd > start ? rawEnd - start : FALLBACK_SLOT_DURATION_SECONDS * count;

  const indexStep = (nextIndex - prevIndex) / (count + 1);
  const sliceDuration = totalDuration / count;

  return Array.from({ length: count }, (_, i) => ({
    lineIndex: prevIndex + indexStep * (i + 1),
    seconds: start + sliceDuration * i,
    endSeconds: start + sliceDuration * (i + 1),
  }));
}
