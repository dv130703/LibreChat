import type { ParsedLine } from './types';

/** Whichever line the playhead currently falls within - drives both the
 *  "follow along" highlight/auto-scroll and, while playing, the previewing
 *  line's own progress bar.
 *
 *  Deliberately compares `seconds`/`endSeconds` directly across every line,
 *  rather than scanning `lines` in reverse array order looking for the first
 *  match: callers pass `lines` sorted by `lineIndex` (a stable identity),
 *  which only happens to match chronological order for an untouched
 *  transcript. Once a line's timestamp has been hand-corrected via the row's
 *  inline time editor (which only validates `endSeconds > seconds` for that
 *  one line, never against its neighbors), `lineIndex` order and
 *  chronological order can diverge - an array-position scan would then
 *  follow the wrong line instead of the one the playhead is actually inside.
 *  Ties (two lines both starting at-or-before `currentTime`) resolve to
 *  whichever started most recently, the same "closest wrapping segment" a
 *  correctly-ordered scan would have returned.
 */
export function findFollowedLineIndex(lines: ParsedLine[], currentTime: number): number {
  let bestLineIndex = -1;
  let bestSeconds = -Infinity;
  for (const line of lines) {
    if (
      line.seconds != null &&
      currentTime >= line.seconds &&
      (line.endSeconds == null || currentTime < line.endSeconds) &&
      line.seconds > bestSeconds
    ) {
      bestSeconds = line.seconds;
      bestLineIndex = line.lineIndex;
    }
  }
  return bestLineIndex;
}
