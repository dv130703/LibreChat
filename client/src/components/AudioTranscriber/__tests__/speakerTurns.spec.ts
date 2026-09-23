import type { ParsedTranscriptLine } from 'librechat-data-provider';
import { getTurnPosition } from '../speakerTurns';

function line(lineIndex: number, speaker: string | undefined, text = 'x'): ParsedTranscriptLine {
  return { lineIndex, speaker, text };
}

describe('getTurnPosition', () => {
  it('marks a lone line as both the start and the end of its turn', () => {
    const lines = [line(0, 'Speaker 1')];
    expect(getTurnPosition(lines, 0)).toEqual({ isTurnStart: true, isTurnEnd: true });
  });

  it('spans consecutive lines from the same speaker as one turn', () => {
    const lines = [line(0, 'Speaker 1'), line(1, 'Speaker 1'), line(2, 'Speaker 1')];

    expect(getTurnPosition(lines, 0)).toEqual({ isTurnStart: true, isTurnEnd: false });
    expect(getTurnPosition(lines, 1)).toEqual({ isTurnStart: false, isTurnEnd: false });
    expect(getTurnPosition(lines, 2)).toEqual({ isTurnStart: false, isTurnEnd: true });
  });

  it('closes the turn and opens a new one when the speaker changes', () => {
    const lines = [line(0, 'Speaker 1'), line(1, 'Speaker 2')];

    expect(getTurnPosition(lines, 0)).toEqual({ isTurnStart: true, isTurnEnd: true });
    expect(getTurnPosition(lines, 1)).toEqual({ isTurnStart: true, isTurnEnd: true });
  });

  it('handles a speaker returning after another speaker as a fresh turn', () => {
    const lines = [line(0, 'Speaker 1'), line(1, 'Speaker 2'), line(2, 'Speaker 1')];

    expect(getTurnPosition(lines, 2)).toEqual({ isTurnStart: true, isTurnEnd: true });
  });

  /** A long same-speaker run is exactly the case the backend's own block
   *  splitter creates (it cuts a turn on a 0.6s pause or every 25 words), so
   *  the UI must re-join those pieces rather than show a box per fragment. */
  it('joins a long run of same-speaker fragments into a single turn', () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(i, 'Speaker 1'));

    expect(getTurnPosition(lines, 0).isTurnStart).toBe(true);
    for (let i = 1; i < 29; i += 1) {
      expect(getTurnPosition(lines, i)).toEqual({ isTurnStart: false, isTurnEnd: false });
    }
    expect(getTurnPosition(lines, 29).isTurnEnd).toBe(true);
  });

  /** An unlabelled line must never silently merge into a neighbouring
   *  speaker's box - that would attribute speech to the wrong person. */
  it('never merges lines with no speaker into an adjacent speaker turn', () => {
    const lines = [line(0, 'Speaker 1'), line(1, undefined), line(2, 'Speaker 1')];

    expect(getTurnPosition(lines, 0)).toEqual({ isTurnStart: true, isTurnEnd: true });
    expect(getTurnPosition(lines, 1)).toEqual({ isTurnStart: true, isTurnEnd: true });
    expect(getTurnPosition(lines, 2)).toEqual({ isTurnStart: true, isTurnEnd: true });
  });

  it('keeps consecutive unlabelled lines separate from each other too', () => {
    const lines = [line(0, undefined), line(1, undefined)];

    expect(getTurnPosition(lines, 0)).toEqual({ isTurnStart: true, isTurnEnd: true });
    expect(getTurnPosition(lines, 1)).toEqual({ isTurnStart: true, isTurnEnd: true });
  });

  it('treats an out-of-range index as a standalone turn rather than throwing', () => {
    expect(getTurnPosition([], 0)).toEqual({ isTurnStart: true, isTurnEnd: true });
  });
});
