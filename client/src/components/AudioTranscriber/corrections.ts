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
  /** lineIndex (fractional - see `computeInsertionSlots`) -> a line the
   *  pipeline missed, added after the fact. Keyed the same way as the other
   *  two maps so a later `segment_reassign`/`text_edit` against one of these
   *  replays exactly like it would against any pipeline-produced line. */
  insertedLines: Record<number, ParsedLine>;
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
  const insertedLines: Record<number, ParsedLine> = {};
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
    }
  }
  return { speakerNames, segmentReassignments, textEdits, insertedLines };
}

/** A fresh, collision-free id for a speaker the pipeline never detected -
 *  the reviewer names it immediately after via a `speaker_rename` correction. */
export function createCustomSpeakerId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
