import { formatTranscriptTimestamp, parseTranscriptText } from 'librechat-data-provider';
import type { ParsedTranscriptLine, TTranscriptCorrection } from 'librechat-data-provider';

/**
 * Regenerates the Audio Transcriber's RAG-embedded transcript from its
 * correction log, so `file_search` retrieval (and anyone re-reading the
 * embedded text) reflects renamed speakers, reassigned lines, edited text,
 * and inserted lines instead of the stale pipeline output. Mirrors the
 * client's own replay logic (`client/src/components/AudioTranscriber/corrections.ts`
 * `reduceCorrections` + `TranscriptPanel.tsx`'s `effectiveLines`) exactly, so the
 * text handed to the model matches what the reviewer actually sees on screen.
 *
 * The line-level format (`[start-end] Speaker N: text`) and its parser live
 * in `librechat-data-provider`'s `transcript` module - the one place all
 * three consumers (this file, the Node bridge in
 * `api/server/services/Transcription/index.js`, and the client's
 * `TranscriptPanel.tsx`) can share, since `packages/api` can depend on
 * `librechat-data-provider` but not on `/api` or `client` (see workspace
 * boundaries in CLAUDE.md). `parseTranscriptText`/`ParsedTranscriptLine` are
 * re-exported below so `interviewDocx.ts`/`meetingMinutesDocx.ts` don't need
 * to change their own imports.
 */

export type { ParsedTranscriptLine } from 'librechat-data-provider';
export { parseTranscriptText };

/** Same replay rule as `reduceCorrections` on the client - chronological,
 *  last write per key wins, log itself never mutated. */
function applyCorrectionsToLines(
  baseLines: ParsedTranscriptLine[],
  corrections: TTranscriptCorrection[],
): ParsedTranscriptLine[] {
  const segmentReassignments: Record<number, string> = {};
  const textEdits: Record<number, string> = {};
  const insertedLines: Record<number, ParsedTranscriptLine> = {};
  const timeEdits: Record<number, { seconds: number; endSeconds: number }> = {};
  const deletedLines = new Set<number>();

  for (const correction of corrections) {
    if (
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
        seconds: correction.seconds,
        endSeconds: correction.endSeconds,
        speaker: correction.speaker,
        text: correction.text,
      };
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
    } else if (correction.type === 'line_delete' && correction.lineIndex != null) {
      deletedLines.add(correction.lineIndex);
    }
  }

  // A time_edit against a line `line_insert` also touched in this same log
  // replays onto the already-inserted line, the same way a `text_edit` does -
  // both are just further corrections layered onto whatever `insertedLines`
  // already produced for that lineIndex.
  for (const [lineIndex, edit] of Object.entries(timeEdits)) {
    const inserted = insertedLines[Number(lineIndex)];
    if (inserted) {
      insertedLines[Number(lineIndex)] = { ...inserted, ...edit };
    }
  }

  const merged = baseLines
    .filter((line) => !deletedLines.has(line.lineIndex))
    .map((line) => {
      const reassignedTo = segmentReassignments[line.lineIndex];
      const editedText = textEdits[line.lineIndex];
      const editedTime = timeEdits[line.lineIndex];
      if (reassignedTo == null && editedText == null && editedTime == null) {
        return line;
      }
      return {
        ...line,
        speaker: reassignedTo ?? line.speaker,
        text: editedText ?? line.text,
        seconds: editedTime?.seconds ?? line.seconds,
        endSeconds: editedTime?.endSeconds ?? line.endSeconds,
      };
    });

  // A hand-inserted line is deletable exactly like a pipeline one: drop it
  // here rather than never adding it, so the delete works the same whichever
  // kind of line it targets.
  const inserted = Object.values(insertedLines).filter((line) => !deletedLines.has(line.lineIndex));
  if (inserted.length === 0) {
    return merged;
  }
  // Original lines are already in time order; only re-sort once a fractional
  // inserted-line index needs merging in (matches `effectiveLines`).
  return [...merged, ...inserted].sort((a, b) => a.lineIndex - b.lineIndex);
}

/** speaker_rename affects every line attributed to that speaker id at once -
 *  applied last, over the id each line ends up with after reassignment/insertion. */
function applySpeakerNames(
  lines: ParsedTranscriptLine[],
  corrections: TTranscriptCorrection[],
): ParsedTranscriptLine[] {
  const speakerNames: Record<string, string> = {};
  for (const correction of corrections) {
    if (correction.type === 'speaker_rename' && correction.speakerId != null && correction.toName) {
      speakerNames[correction.speakerId] = correction.toName;
    }
  }
  if (Object.keys(speakerNames).length === 0) {
    return lines;
  }
  return lines.map((line) =>
    line.speaker != null && speakerNames[line.speaker] != null
      ? { ...line, speaker: speakerNames[line.speaker] }
      : line,
  );
}

function serializeTranscriptLines(lines: ParsedTranscriptLine[]): string {
  return lines
    .map((line) => {
      const parts: string[] = [];
      if (line.seconds != null) {
        const end = line.endSeconds != null ? `-${formatTranscriptTimestamp(line.endSeconds)}` : '';
        parts.push(`[${formatTranscriptTimestamp(line.seconds)}${end}]`);
      }
      if (line.speaker != null) {
        parts.push(`${line.speaker}:`);
      }
      parts.push(line.text);
      return parts.join(' ');
    })
    .join('\n');
}

/**
 * The corrected transcript as structured lines - final speaker (renamed
 * where applicable), final text, final timing, one entry per turn segment.
 * The entry point for anything that needs to tell speakers apart
 * programmatically (see `interviewDocx.ts`'s `turnParagraphs`): re-parsing
 * `applyTranscriptCorrections`'s serialized string output cannot recover
 * this, because `LINE_PATTERN` only recognizes the raw pipeline's literal
 * `Speaker N` shape - a renamed speaker's actual name would fail that match
 * and fall into the free-text tail instead, silently losing the speaker
 * boundary. Structured lines never round-trip through that regex at all.
 */
export function applyTranscriptCorrectionsStructured(
  baseText: string,
  corrections: TTranscriptCorrection[],
): ParsedTranscriptLine[] {
  const baseLines = parseTranscriptText(baseText);
  const withEdits = applyCorrectionsToLines(baseLines, corrections);
  return applySpeakerNames(withEdits, corrections);
}

/**
 * The one entry point the correction routes need: base pipeline text in,
 * corrected text out, ready to re-embed under the transcript's existing
 * `file_id` (re-uploading the same id replaces its RAG chunks rather than
 * duplicating them - see `rag_server/app.py`'s `/embed`).
 */
export function applyTranscriptCorrections(
  baseText: string,
  corrections: TTranscriptCorrection[],
): string {
  return serializeTranscriptLines(applyTranscriptCorrectionsStructured(baseText, corrections));
}

/** What a delete must write: the removal itself, plus the neighbor edit that
 *  takes over the removed line's time range. */
export interface LineDeletionPlan {
  deleted: {
    lineIndex: number;
    speaker?: string;
    fromText: string;
    fromSeconds?: number;
    fromEndSeconds?: number;
  };
  timeEdit?: {
    lineIndex: number;
    fromSeconds: number;
    fromEndSeconds: number;
    seconds: number;
    endSeconds: number;
  };
}

function isTimed(
  line: ParsedTranscriptLine | undefined,
): line is ParsedTranscriptLine & { seconds: number; endSeconds: number } {
  return line?.seconds != null && line.endSeconds != null;
}

/**
 * Works out both writes a deletion needs, from the transcript as currently
 * corrected.
 *
 * The time range of a deleted line would otherwise become unreachable - no
 * box covers it, so that audio can no longer be played or re-timed from the
 * panel at all. Instead the following line takes it over by extending its
 * start backward. Deleting the last line has no following box, so the
 * previous one extends its end forward instead; the range is preserved
 * either way, only the direction changes.
 *
 * Computed here rather than on the client because the neighbor depends on
 * every correction already applied, and because doing both writes from one
 * request is what stops a delete from landing without its reabsorption.
 *
 * @returns `null` when no line carries that index - a delete racing another
 *   reviewer's delete of the same line, which is a no-op rather than an error.
 */
export function planLineDeletion(
  lines: ParsedTranscriptLine[],
  lineIndex: number,
): LineDeletionPlan | null {
  const position = lines.findIndex((line) => line.lineIndex === lineIndex);
  if (position === -1) {
    return null;
  }

  const target = lines[position];
  const deleted: LineDeletionPlan['deleted'] = {
    lineIndex,
    speaker: target.speaker,
    fromText: target.text,
    fromSeconds: target.seconds,
    fromEndSeconds: target.endSeconds,
  };
  if (!isTimed(target)) {
    return { deleted };
  }

  const next = lines[position + 1];
  if (isTimed(next)) {
    return {
      deleted,
      timeEdit: {
        lineIndex: next.lineIndex,
        fromSeconds: next.seconds,
        fromEndSeconds: next.endSeconds,
        seconds: target.seconds,
        endSeconds: next.endSeconds,
      },
    };
  }

  const previous = lines[position - 1];
  if (isTimed(previous)) {
    return {
      deleted,
      timeEdit: {
        lineIndex: previous.lineIndex,
        fromSeconds: previous.seconds,
        fromEndSeconds: previous.endSeconds,
        seconds: previous.seconds,
        endSeconds: target.endSeconds,
      },
    };
  }
  return { deleted };
}
