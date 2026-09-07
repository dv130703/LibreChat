import { findFollowedLineIndex } from '../playbackSync';
import type { ParsedLine } from '../types';

function line(lineIndex: number, seconds: number, endSeconds: number, text = ''): ParsedLine {
  return { lineIndex, seconds, endSeconds, text };
}

describe('findFollowedLineIndex', () => {
  it('returns the line whose [seconds, endSeconds) window contains currentTime', () => {
    const lines = [line(0, 0, 5), line(1, 5, 10), line(2, 10, 15)];
    expect(findFollowedLineIndex(lines, 7)).toBe(1);
  });

  it('returns -1 when currentTime falls in a silent gap between lines', () => {
    const lines = [line(0, 0, 5), line(1, 8, 10)];
    expect(findFollowedLineIndex(lines, 6)).toBe(-1);
  });

  it('returns -1 for lines with no timestamps at all', () => {
    const lines: ParsedLine[] = [{ lineIndex: 0, text: 'no timestamps' }];
    expect(findFollowedLineIndex(lines, 5)).toBe(-1);
  });

  it(
    'follows the line the playhead is actually inside even when a hand-corrected ' +
      'timestamp has put array (lineIndex) order out of sync with chronological order',
    () => {
      // Regression: the row-level time editor only validates a line's own
      // endSeconds > seconds, never against its neighbors, so lineIndex order
      // (what `displayLines` is sorted by) and chronological order can
      // diverge once a correction like this one lands. Here line 0 was
      // hand-corrected to start at 6s (overlapping into line 1's original
      // 5-10s window) - a reverse-array-position scan hits line 1 first
      // (it's checked before line 0) and would wrongly keep reporting line 1
      // as playing at t=7, even though line 0 is the segment that actually
      // started most recently by then.
      const lines = [
        line(0, 6, 20), // corrected to start at 6s, now overlapping line 1
        line(1, 5, 10),
        line(2, 20, 25),
      ];
      expect(findFollowedLineIndex(lines, 7)).toBe(0);
    },
  );

  it('breaks ties between overlapping lines by preferring whichever started most recently', () => {
    const lines = [line(0, 0, 20), line(1, 5, 15)];
    expect(findFollowedLineIndex(lines, 8)).toBe(1);
  });
});
