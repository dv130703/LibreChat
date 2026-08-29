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
 * Either bound may be `null` - `nextLine` for an insert after the last line,
 * `prevLine` for an insert before the first one - since neither side has a
 * real neighbor to anchor to there; a fallback duration is used instead of an
 * unbounded range. At least one of the two is always a real line in practice
 * (the context menu is always opened on one), so both being `null` is not a
 * case this needs to produce a meaningful result for. Calling this again
 * later with a previously-inserted line as one of the two neighbors (a
 * second insert landing between an original line and one just added)
 * subdivides the same gap further - nothing here treats an inserted line
 * differently from an original one.
 */
export function computeInsertionSlots(
  prevLine: ParsedLine | null,
  nextLine: ParsedLine | null,
  count: number,
): GapSlot[] {
  const nextIndex = nextLine?.lineIndex ?? (prevLine?.lineIndex ?? 0) + count + 1;
  const prevIndex = prevLine?.lineIndex ?? nextIndex - count - 1;

  const rawEnd = nextLine?.seconds;
  let start: number;
  let totalDuration: number;
  if (prevLine != null) {
    start = prevLine.endSeconds ?? prevLine.seconds ?? 0;
    totalDuration =
      rawEnd != null && rawEnd > start ? rawEnd - start : FALLBACK_SLOT_DURATION_SECONDS * count;
  } else if (rawEnd != null) {
    // No real line before this one (inserting above the very first line) -
    // anchor to a fixed-size window ending exactly where `nextLine` starts,
    // clamped so it never starts before the recording itself does. When
    // `nextLine` starts within that window of 0 (a recording with
    // essentially no lead-in), this degrades to a zero-length slot rather
    // than overlapping into `nextLine`'s own time range.
    start = Math.max(0, rawEnd - FALLBACK_SLOT_DURATION_SECONDS * count);
    totalDuration = rawEnd - start;
  } else {
    start = 0;
    totalDuration = FALLBACK_SLOT_DURATION_SECONDS * count;
  }

  const indexStep = (nextIndex - prevIndex) / (count + 1);
  const sliceDuration = totalDuration / count;

  return Array.from({ length: count }, (_, i) => ({
    lineIndex: prevIndex + indexStep * (i + 1),
    seconds: start + sliceDuration * i,
    endSeconds: start + sliceDuration * (i + 1),
  }));
}
