import type { ParsedTranscriptLine } from 'librechat-data-provider';

export interface TurnPosition {
  /** This line opens a speaker turn: it carries the speaker header, and the
   *  turn box's top border and rounding. */
  isTurnStart: boolean;
  /** This line closes a speaker turn: it carries the box's bottom border and
   *  rounding. A turn one line long is both a start and an end. */
  isTurnEnd: boolean;
}

/**
 * Where `lines[index]` sits within its speaker turn - a run of consecutive
 * lines spoken by the same person, which the UI renders as a single box.
 *
 * Needed because the pipeline does not emit one segment per turn: its block
 * splitter cuts a turn on a 0.6s pause or every 25 words (see
 * `_group_into_blocks` in the Transcription Pipeline's pipeline.py), so one
 * person speaking uninterrupted arrives as many separate lines. Grouping
 * here, at render time rather than in the data, keeps every per-line
 * operation (play, reassign, text/time edit, insert) working on exactly the
 * line it always did.
 *
 * Deliberately a per-index lookup rather than a precomputed array of turns:
 * the list is virtualised, so rows are rendered individually and only the
 * immediate neighbours are ever needed.
 *
 * A line with no speaker never joins a neighbouring turn, even another
 * unlabelled one - merging those would attribute speech to a speaker the
 * data does not actually claim it belongs to.
 */
export function getTurnPosition(lines: ParsedTranscriptLine[], index: number): TurnPosition {
  const speaker = lines[index]?.speaker;
  if (speaker == null) {
    return { isTurnStart: true, isTurnEnd: true };
  }
  return {
    isTurnStart: lines[index - 1]?.speaker !== speaker,
    isTurnEnd: lines[index + 1]?.speaker !== speaker,
  };
}
