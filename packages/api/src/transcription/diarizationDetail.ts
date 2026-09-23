import type {
  TWordSpan,
  TTranscriptSegment,
  TDiarizationTurn,
  TRecordingProfile,
  TSpeakerAssignmentMethod,
  TRecordingClassification,
  TTranscriptionDiarizationDetail,
} from 'librechat-data-provider';

/**
 * Shapes actually returned by the RAG server's Python `/transcribe` endpoint -
 * pydantic's default snake_case field names, not this app's camelCase. Kept
 * distinct from `TTranscriptSegment`/`TWordSpan` (the shapes used everywhere
 * else in this app) so only this one file has to know about the wire format.
 */
interface RawWordSpan {
  word: string;
  start?: number | null;
  end?: number | null;
  speaker?: string | null;
  assignment_method?: string;
  assignment_distance_s?: number | null;
}

interface RawTranscriptSegment {
  id: string;
  start: number;
  end: number;
  speaker: string;
  text: string;
  assignment_method?: string;
  assignment_distance_s?: number | null;
  words?: RawWordSpan[];
}

export interface RawDiarizationTurn {
  start: number;
  end: number;
  speaker: string;
}

interface RawRecordingProfile {
  speaker_count: number;
  turn_count: number;
  median_turn_duration_s: number;
  mean_turn_duration_s: number;
  p95_turn_duration_s: number;
  longest_turn_s: number;
  speaker_switches_per_minute: number;
  speaker_time_distribution_s: Record<string, number>;
  overlap_ratio: number;
  unassigned_audio_ratio: number;
  short_turn_ratio: number;
  diarization_coverage_ratio: number;
  boundary_conflict_ratio: number;
  word_segment_disagreement_ratio: number;
  suspicious_segment_ratio: number;
  suspicious_segment_ids: string[];
  classification: string;
}

function toWordSpan(word: RawWordSpan): TWordSpan {
  return {
    word: word.word,
    start: word.start ?? undefined,
    end: word.end ?? undefined,
    speaker: word.speaker ?? undefined,
    assignmentMethod: (word.assignment_method as TSpeakerAssignmentMethod) ?? 'none',
    assignmentDistanceS: word.assignment_distance_s ?? undefined,
  };
}

/** Matches `RecordingProfile()`'s Python defaults - what an empty/no-speech
 *  transcription (or a response from before this field existed) resolves to. */
const EMPTY_RECORDING_PROFILE: TRecordingProfile = {
  speakerCount: 0,
  turnCount: 0,
  medianTurnDurationS: 0,
  meanTurnDurationS: 0,
  p95TurnDurationS: 0,
  longestTurnS: 0,
  speakerSwitchesPerMinute: 0,
  speakerTimeDistributionS: {},
  overlapRatio: 0,
  unassignedAudioRatio: 0,
  shortTurnRatio: 0,
  diarizationCoverageRatio: 0,
  boundaryConflictRatio: 0,
  wordSegmentDisagreementRatio: 0,
  suspiciousSegmentRatio: 0,
  suspiciousSegmentIds: [],
  classification: 'insufficient_data',
};

function toRecordingProfile(profile: RawRecordingProfile | null): TRecordingProfile {
  if (!profile) {
    return EMPTY_RECORDING_PROFILE;
  }
  return {
    speakerCount: profile.speaker_count,
    turnCount: profile.turn_count,
    medianTurnDurationS: profile.median_turn_duration_s,
    meanTurnDurationS: profile.mean_turn_duration_s,
    p95TurnDurationS: profile.p95_turn_duration_s,
    longestTurnS: profile.longest_turn_s,
    speakerSwitchesPerMinute: profile.speaker_switches_per_minute,
    speakerTimeDistributionS: profile.speaker_time_distribution_s,
    overlapRatio: profile.overlap_ratio,
    unassignedAudioRatio: profile.unassigned_audio_ratio,
    shortTurnRatio: profile.short_turn_ratio,
    diarizationCoverageRatio: profile.diarization_coverage_ratio,
    boundaryConflictRatio: profile.boundary_conflict_ratio,
    wordSegmentDisagreementRatio: profile.word_segment_disagreement_ratio,
    suspiciousSegmentRatio: profile.suspicious_segment_ratio,
    suspiciousSegmentIds: profile.suspicious_segment_ids,
    classification: profile.classification as TRecordingClassification,
  };
}

function toTranscriptSegment(segment: RawTranscriptSegment): TTranscriptSegment {
  return {
    start: segment.start,
    end: segment.end,
    speaker: segment.speaker,
    text: segment.text,
    assignmentMethod: (segment.assignment_method as TSpeakerAssignmentMethod) ?? 'none',
    assignmentDistanceS: segment.assignment_distance_s ?? undefined,
    words: (segment.words ?? []).map(toWordSpan),
  };
}

/**
 * Strips the diarization-detail-only fields (`words`, `assignment_method`)
 * back down to the plain shape the client's transcript view has always
 * received. The transcription service's response now always includes the
 * richer per-segment fields, so word-level data is available to persist, but
 * the normal transcription response - what the client actually renders -
 * stays exactly the size and shape it always was; only the separate
 * diarization-detail file carries the rest.
 */
export function stripSegmentDetail<T extends RawTranscriptSegment>(
  segments: T[],
): Array<{ id: string; start: number; end: number; speaker: string; text: string }> {
  return segments.map(({ id, start, end, speaker, text }) => ({ id, start, end, speaker, text }));
}

export interface BuildDiarizationDetailParams {
  segments: RawTranscriptSegment[];
  diarizationTurns: RawDiarizationTurn[];
  speakerEmbeddings: Record<string, number[]> | null;
  diagnostics: Record<string, unknown>;
  recordingProfile: RawRecordingProfile | null;
}

/**
 * The full forensic/audit record for one transcription, in this app's own
 * camelCase shape - the one place that translates the RAG server's raw
 * pydantic field names into `TTranscriptionDiarizationDetail`. Persisted
 * verbatim (JSON-stringified) as a `transcript_diarization_detail` file;
 * never embedded into RAG, never shown in the transcript pane.
 */
export function buildDiarizationDetail({
  segments,
  diarizationTurns,
  speakerEmbeddings,
  diagnostics,
  recordingProfile,
}: BuildDiarizationDetailParams): TTranscriptionDiarizationDetail {
  const speakerLabelMap = diagnostics.speaker_label_map;
  return {
    segments: segments.map(toTranscriptSegment),
    diarizationTurns: diarizationTurns.map(
      (turn): TDiarizationTurn => ({
        start: turn.start,
        end: turn.end,
        speaker: turn.speaker,
      }),
    ),
    speakerEmbeddings,
    speakerLabelMap: speakerLabelMap != null ? (speakerLabelMap as Record<string, string>) : {},
    diagnostics,
    recordingProfile: toRecordingProfile(recordingProfile),
  };
}
