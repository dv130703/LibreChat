import type { TTranscriptCorrection } from 'librechat-data-provider';

/**
 * Regenerates the Audio Transcriber's RAG-embedded transcript from its
 * correction log, so `file_search` retrieval (and anyone re-reading the
 * embedded text) reflects renamed speakers, reassigned lines, edited text,
 * and inserted lines instead of the stale pipeline output. Mirrors the
 * client's own replay logic (`client/src/components/AudioTranscriber/corrections.ts`
 * `reduceCorrections` + `TranscriptPanel.tsx`'s `effectiveLines`) exactly, so the
 * text handed to the model matches what the reviewer actually sees on screen.
 *
 * The line-level format (`[start-end] Speaker N: text`) is unchanged from
 * `formatLine` in `api/server/services/Transcription/index.js` - only the
 * lines an actual correction touches differ from the base parse.
 */

/** Mirrors `LINE_PATTERN` in `TranscriptPanel.tsx` exactly - any drift between
 *  the two would silently desync what the reviewer sees from what gets embedded. */
const LINE_PATTERN = /^(?:\[([0-9:.]+)(?:-([0-9:.]+))?\] )?(?:(Speaker \d+): )?(.*)$/;

export interface ParsedTranscriptLine {
  lineIndex: number;
  seconds?: number;
  endSeconds?: number;
  speaker?: string;
  text: string;
}

function parseTimestampToSeconds(timestamp: string): number | undefined {
  const parts = timestamp.split(':').map(Number);
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) {
    return undefined;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Ports `formatTimestamp` from `api/server/services/Transcription/index.js` -
 *  duplicated rather than imported since `packages/api` can't depend on `/api`
 *  (see workspace boundaries), and it's a tiny, self-contained pure function. */
function formatTimestamp(seconds: number): string {
  const totalTenths = Math.max(0, Math.round(seconds * 10));
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = `${String(secs).padStart(2, '0')}.${tenths}`;
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function parseTranscriptText(text: string): ParsedTranscriptLine[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, lineIndex) => {
      const match = LINE_PATTERN.exec(line);
      if (!match) {
        return { lineIndex, text: line };
      }
      const [, timestamp, endTimestamp, speaker, rest] = match;
      return {
        lineIndex,
        seconds: timestamp ? parseTimestampToSeconds(timestamp) : undefined,
        endSeconds: endTimestamp ? parseTimestampToSeconds(endTimestamp) : undefined,
        speaker,
        text: rest,
      };
    });
}

/** Same replay rule as `reduceCorrections` on the client - chronological,
 *  last write per key wins, log itself never mutated. */
function applyCorrectionsToLines(
  baseLines: ParsedTranscriptLine[],
  corrections: TTranscriptCorrection[],
): ParsedTranscriptLine[] {
  const segmentReassignments: Record<number, string> = {};
  const textEdits: Record<number, string> = {};
  const insertedLines: Record<number, ParsedTranscriptLine> = {};

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
    }
  }

  const merged = baseLines.map((line) => {
    const reassignedTo = segmentReassignments[line.lineIndex];
    const editedText = textEdits[line.lineIndex];
    if (reassignedTo == null && editedText == null) {
      return line;
    }
    return { ...line, speaker: reassignedTo ?? line.speaker, text: editedText ?? line.text };
  });

  const inserted = Object.values(insertedLines);
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
        const end = line.endSeconds != null ? `-${formatTimestamp(line.endSeconds)}` : '';
        parts.push(`[${formatTimestamp(line.seconds)}${end}]`);
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
 * The one entry point the correction routes need: base pipeline text in,
 * corrected text out, ready to re-embed under the transcript's existing
 * `file_id` (re-uploading the same id replaces its RAG chunks rather than
 * duplicating them - see `rag_server/app.py`'s `/embed`).
 */
export function applyTranscriptCorrections(
  baseText: string,
  corrections: TTranscriptCorrection[],
): string {
  const baseLines = parseTranscriptText(baseText);
  const withEdits = applyCorrectionsToLines(baseLines, corrections);
  const withNames = applySpeakerNames(withEdits, corrections);
  return serializeTranscriptLines(withNames);
}
