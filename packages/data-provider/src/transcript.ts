/** Canonical Audio Transcriber line format, shared by every consumer that
 *  writes or reads it: the WhisperX Node bridge (`api/server/services/Transcription/index.js`,
 *  the producer), the correction-replay engine (`packages/api/src/transcription/corrections.ts`),
 *  and the transcript panel (`client/src/components/AudioTranscriber/TranscriptPanel.tsx`,
 *  a re-parser/consumer). Each of the three used to carry its own independent copy of this
 *  regex and timestamp math, kept in sync only by a comment asking nicely not to drift - a
 *  single missed edit would silently corrupt every correction replay and desync what a
 *  reviewer sees from what gets embedded into RAG. One implementation, imported everywhere,
 *  makes that drift structurally impossible instead of just discouraged.
 */

import type { TTranscriptIndexStatus, TTranscriptUnqueryableReason } from './types/files';

export interface TranscriptLineSegment {
  start: number;
  end: number;
  speaker?: string;
  text: string;
}

export interface ParsedTranscriptLine {
  lineIndex: number;
  timestamp?: string;
  seconds?: number;
  /** This segment's own end time - the real boundary for bounded playback.
   *  Absent on transcripts saved before end timestamps were persisted. */
  endSeconds?: number;
  speaker?: string;
  text: string;
}

/** `[start-end] Speaker N: text`, with `[start-end]` and `Speaker N:` each
 *  independently optional (either, both, or neither may be present) and a
 *  greedy `text` capture last. The label matches the transcription service's
 *  own human-readable rewrite of the raw diarization ids (e.g. "Speaker 1"),
 *  not raw `SPEAKER_00`-style output, so this can't false-match an ordinary
 *  sentence that happens to contain a colon. `Unknown` is matched alongside
 *  `Speaker \d+` because the pipeline substitutes that literal label for a
 *  segment/word whose assignment was too far from any diarization turn to
 *  trust - without it, exactly the least-trustworthy lines would silently
 *  fail to parse their own speaker prefix back out, corrupting correction
 *  replay and display for those lines specifically. This is a hard contract
 *  with whatever service TRANSCRIPTION_API_URL points at: it must keep
 *  emitting exactly "Speaker N" or "Unknown", never a raw diarization id. */
export const TRANSCRIPT_LINE_PATTERN =
  /^(?:\[([0-9:.]+)(?:-([0-9:.]+))?\] )?(?:(Speaker \d+|Unknown): )?(.*)$/;

/** "125.34" seconds -> "02:05.3". Tenths-of-a-second precision (not rounded
 *  to a whole second) so bounded single-line/turn playback can stop exactly
 *  at a segment's boundary without cutting into, or leaking audio from, the
 *  next line - whole-second precision leaves up to half a second of audible
 *  slack on either side. All-integer tenths math avoids float rollover bugs
 *  (59.96s must become 01:00.0, not 00:59.10). Segments run well past an
 *  hour on long recordings, hence the conditional `h:` prefix. */
export function formatTranscriptTimestamp(seconds: number): string {
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

/** Inverse of `formatTranscriptTimestamp`: "02:05.3" or "1:02:05.0" -> seconds. */
export function parseTranscriptTimestamp(timestamp: string): number | undefined {
  const parts = timestamp.split(':').map(Number);
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) {
    return undefined;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Renders one transcript line, honoring the timestamp/diarization choices
 *  independently - either, both, or neither may be on. Both the segment's
 *  start AND its own end are written out so bounded playback can target this
 *  segment's real end rather than the next segment's (possibly later) start. */
export function formatTranscriptLine(
  segment: TranscriptLineSegment,
  { includeTimestamps, diarize }: { includeTimestamps: boolean; diarize: boolean },
): string {
  const parts: string[] = [];
  if (includeTimestamps) {
    parts.push(
      `[${formatTranscriptTimestamp(segment.start)}-${formatTranscriptTimestamp(segment.end)}]`,
    );
  }
  if (diarize) {
    parts.push(`${segment.speaker}:`);
  }
  parts.push(segment.text);
  return parts.join(' ');
}

/** Parses one already-split line via `TRANSCRIPT_LINE_PATTERN`. The pattern's
 *  groups are all optional, so it always matches - the fallback here only
 *  guards a `null` from `exec` in the type system, not a real runtime case. */
export function parseTranscriptLine(line: string, lineIndex: number): ParsedTranscriptLine {
  const match = TRANSCRIPT_LINE_PATTERN.exec(line);
  if (!match) {
    return { lineIndex, text: line };
  }
  const [, timestamp, endTimestamp, speaker, rest] = match;
  return {
    lineIndex,
    timestamp,
    seconds: timestamp ? parseTranscriptTimestamp(timestamp) : undefined,
    endSeconds: endTimestamp ? parseTranscriptTimestamp(endTimestamp) : undefined,
    speaker,
    text: rest,
  };
}

/** Splits a full transcript body into parsed lines, skipping blank lines -
 *  a blank line carries no correction-addressable content and would
 *  otherwise consume a `lineIndex` no correction could ever target. */
export function parseTranscriptText(text: string): ParsedTranscriptLine[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, lineIndex) => parseTranscriptLine(line, lineIndex));
}

/** The one place the derived-file id scheme is written down. A recording's
 *  three files are always `sourceFileId`, `${sourceFileId}-transcript`, and
 *  `${sourceFileId}-diarization-detail`, so no filename lookup is ever
 *  needed to tell them apart or to pair them back up. */
export const TRANSCRIPT_FILE_SUFFIX = '-transcript';
export const DIARIZATION_DETAIL_FILE_SUFFIX = '-diarization-detail';

export function transcriptFileIdFor(sourceFileId: string): string {
  return `${sourceFileId}${TRANSCRIPT_FILE_SUFFIX}`;
}

export function diarizationDetailFileIdFor(sourceFileId: string): string {
  return `${sourceFileId}${DIARIZATION_DETAIL_FILE_SUFFIX}`;
}

/** The source recording a derived file belongs to, or `null` if the id
 *  carries neither suffix (i.e. it is already a source id, or unrelated).
 *  Checks the longer suffix first: `-diarization-detail` does not end with
 *  `-transcript`, but keeping the order explicit means adding a future
 *  suffix that does can't silently mis-attribute a file to the wrong
 *  recording. */
export function sourceFileIdFromDerived(fileId: string): string | null {
  if (fileId.endsWith(DIARIZATION_DETAIL_FILE_SUFFIX)) {
    return fileId.slice(0, -DIARIZATION_DETAIL_FILE_SUFFIX.length);
  }
  if (fileId.endsWith(TRANSCRIPT_FILE_SUFFIX)) {
    return fileId.slice(0, -TRANSCRIPT_FILE_SUFFIX.length);
  }
  return null;
}

/** The subset of a transcript File record `isTranscriptQueryable` needs.
 *  Deliberately structural rather than the full `IMongoFile`: the same
 *  decision has to be reachable from `packages/data-schemas` (Mongo docs)
 *  and from anything holding a serialized copy, without either importing
 *  the other's model type. */
export interface TranscriptIndexState {
  indexStatus?: TTranscriptIndexStatus | null;
  /** Which `transcriptVersion` the RAG index actually reflects. */
  indexVersion?: number | null;
  /** How many times the transcript text has been revised. */
  transcriptVersion?: number | null;
  /** The pre-`indexStatus` signal: whether an embed ever succeeded. Read
   *  only as a legacy fallback - see below. */
  embedded?: boolean | null;
}

/**
 * Whether a transcript can be searched *right now*, and if not, why.
 *
 * This is the single decision retrieval is allowed to gate on. It replaces
 * the previous gate, a bare `embedded: true` - which answers "did an embed
 * ever succeed", not "does the index reflect the text we would be citing".
 * Those diverge every time a transcript is corrected: `markTranscriptStale`
 * bumps `transcriptVersion` and sets `indexStatus: 'stale'` while leaving
 * `embedded` true, so the old gate would keep serving superseded chunks and
 * cite them as current.
 *
 * Legacy fallback: transcript records written before `indexStatus` existed
 * carry only `embedded`. Requiring `indexStatus === 'indexed'` outright
 * would silently make every one of those conversations unsearchable, so an
 * absent `indexStatus` defers to `embedded`. New records always set it.
 */
export function isTranscriptQueryable(state: TranscriptIndexState): {
  isQueryable: boolean;
  reason: TTranscriptUnqueryableReason | null;
} {
  if (state.indexStatus == null) {
    return state.embedded === true
      ? { isQueryable: true, reason: null }
      : { isQueryable: false, reason: 'not_indexed' };
  }
  if (state.indexStatus === 'index_failed') {
    return { isQueryable: false, reason: 'index_failed' };
  }
  if (state.indexStatus === 'stale') {
    return { isQueryable: false, reason: 'stale_index' };
  }
  if (state.indexStatus !== 'indexed') {
    return { isQueryable: false, reason: 'not_indexed' };
  }
  // `indexed` is written together with `indexVersion = transcriptVersion`,
  // so a mismatch here means a later revision landed without the status
  // being updated with it. Trusting the status alone would cite superseded
  // text; the version pair is the tiebreaker.
  if (
    state.indexVersion != null &&
    state.transcriptVersion != null &&
    state.indexVersion !== state.transcriptVersion
  ) {
    return { isQueryable: false, reason: 'stale_index' };
  }
  return { isQueryable: true, reason: null };
}
