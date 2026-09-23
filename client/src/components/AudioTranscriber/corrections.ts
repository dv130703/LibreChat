import type { TTranscriptCorrection } from 'librechat-data-provider';
import { formatSlotTimestamp } from './lineInsert';
import type { ParsedLine } from './types';

interface EffectiveCorrections {
  /** speakerId -> current display name. */
  speakerNames: Record<string, string>;
  /** lineIndex -> speakerId this line is currently attributed to. */
  segmentReassignments: Record<number, string>;
  /** lineIndex -> this line's current (edited) text. */
  textEdits: Record<number, string>;
  /** lineIndex -> this line's current (corrected) start/end time. */
  timeEdits: Record<number, { seconds: number; endSeconds: number }>;
  /** lineIndex (fractional - see `computeInsertionSlots`) -> a line the
   *  pipeline missed, added after the fact. Keyed the same way as the other
   *  two maps so a later `segment_reassign`/`text_edit`/`time_edit` against
   *  one of these replays exactly like it would against any
   *  pipeline-produced line. */
  insertedLines: Record<number, ParsedLine>;
  /** lineIndex -> removed. Held as a set of indices rather than by filtering
   *  here, because a line can be deleted before the log even reaches the
   *  `line_insert` that created it is irrelevant - order is chronological, so
   *  the delete simply wins whenever it lands. */
  deletedLines: Set<number>;
}

/** Replays an append-only correction log (chronological, oldest first - see
 *  `GET /api/transcript-corrections`) into current state: last write per key
 *  wins. The log itself is never mutated, so the original pipeline output
 *  (a line's raw parsed `speaker`/`text`, and a speaker id's raw pipeline
 *  label) stays recoverable underneath any correction. */
export function reduceCorrections(corrections: TTranscriptCorrection[]): EffectiveCorrections {
  const speakerNames: Record<string, string> = {};
  const segmentReassignments: Record<number, string> = {};
  const textEdits: Record<number, string> = {};
  const timeEdits: Record<number, { seconds: number; endSeconds: number }> = {};
  const insertedLines: Record<number, ParsedLine> = {};
  const deletedLines = new Set<number>();
  for (const correction of corrections) {
    if (correction.type === 'speaker_rename' && correction.speakerId != null && correction.toName) {
      speakerNames[correction.speakerId] = correction.toName;
    } else if (
      correction.type === 'segment_reassign' &&
      correction.lineIndex != null &&
      correction.toSpeakerId
    ) {
      segmentReassignments[correction.lineIndex] = correction.toSpeakerId;
    } else if (
      correction.type === 'text_edit' &&
      correction.lineIndex != null &&
      correction.toText != null
    ) {
      textEdits[correction.lineIndex] = correction.toText;
    } else if (
      correction.type === 'time_edit' &&
      correction.lineIndex != null &&
      correction.seconds != null &&
      correction.endSeconds != null
    ) {
      timeEdits[correction.lineIndex] = {
        seconds: correction.seconds,
        endSeconds: correction.endSeconds,
      };
      // A time_edit against an already-inserted line (one this same log
      // already produced via line_insert) replays onto it directly, the
      // same way the server's `applyCorrectionsToLines` does - otherwise an
      // inserted line's corrected time would be dropped on the floor here
      // while still counting as "current" everywhere else that reads
      // `timeEdits` by lineIndex.
      const inserted = insertedLines[correction.lineIndex];
      if (inserted) {
        insertedLines[correction.lineIndex] = {
          ...inserted,
          timestamp: formatSlotTimestamp(correction.seconds),
          seconds: correction.seconds,
          endSeconds: correction.endSeconds,
        };
      }
    } else if (
      correction.type === 'line_insert' &&
      correction.lineIndex != null &&
      correction.text != null &&
      correction.seconds != null &&
      correction.endSeconds != null
    ) {
      insertedLines[correction.lineIndex] = {
        lineIndex: correction.lineIndex,
        timestamp: formatSlotTimestamp(correction.seconds),
        seconds: correction.seconds,
        endSeconds: correction.endSeconds,
        speaker: correction.speaker,
        text: correction.text,
      };
    } else if (correction.type === 'line_delete' && correction.lineIndex != null) {
      deletedLines.add(correction.lineIndex);
      // A line added and then removed leaves nothing behind: dropping it here
      // means every consumer of `insertedLines` sees it gone, rather than each
      // having to remember to subtract `deletedLines` itself.
      delete insertedLines[correction.lineIndex];
    }
  }
  return { speakerNames, segmentReassignments, textEdits, timeEdits, insertedLines, deletedLines };
}

/** A fresh, collision-free id for a speaker the pipeline never detected -
 *  the reviewer names it immediately after via a `speaker_rename` correction. */
export function createCustomSpeakerId(): string {
  return `custom-${crypto.randomUUID()}`;
}
