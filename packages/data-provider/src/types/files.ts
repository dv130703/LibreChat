import type { CodeEnvRef } from '../codeEnvRef';
import { EToolResources } from './assistants';

export enum FileSources {
  local = 'local',
  firebase = 'firebase',
  azure = 'azure',
  azure_blob = 'azure_blob',
  openai = 'openai',
  s3 = 's3',
  cloudfront = 'cloudfront',
  vectordb = 'vectordb',
  execute_code = 'execute_code',
  mistral_ocr = 'mistral_ocr',
  azure_mistral_ocr = 'azure_mistral_ocr',
  vertexai_mistral_ocr = 'vertexai_mistral_ocr',
  ollama_vision = 'ollama_vision',
  text = 'text',
  document_parser = 'document_parser',
}

export const checkOpenAIStorage = (source: string) =>
  source === FileSources.openai || source === FileSources.azure;

export enum FileContext {
  avatar = 'avatar',
  unknown = 'unknown',
  agents = 'agents',
  assistants = 'assistants',
  execute_code = 'execute_code',
  image_generation = 'image_generation',
  assistants_output = 'assistants_output',
  message_attachment = 'message_attachment',
  skill_file = 'skill_file',
  /** Transcript embedded into RAG for one conversation only - never listed in
   *  the general file library, deleted along with the conversation. */
  transcript_rag = 'transcript_rag',
  /** The full diarization/ASR detail record for one transcription - raw
   *  pyannote turns, speaker embeddings, and per-word speaker assignments -
   *  never embedded into RAG or shown in the transcript pane; a forensic/audit
   *  artifact only. See `TTranscriptionDiarizationDetail`. */
  transcript_diarization_detail = 'transcript_diarization_detail',
  filename = 'filename',
  updatedAt = 'updatedAt',
  source = 'source',
  filterSource = 'filterSource',
  context = 'context',
  bytes = 'bytes',
}

export type EndpointFileConfig = {
  disabled?: boolean;
  fileLimit?: number;
  fileSizeLimit?: number;
  totalSizeLimit?: number;
  supportedMimeTypes?: RegExp[];
};

export type FileConfig = {
  endpoints: {
    [key: string]: EndpointFileConfig;
  };
  skills?: {
    fileSizeLimit?: number;
  };
  fileTokenLimit?: number;
  serverFileSizeLimit?: number;
  avatarSizeLimit?: number;
  clientImageResize?: {
    enabled?: boolean;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
  };
  ocr?: {
    supportedMimeTypes?: RegExp[];
  };
  text?: {
    supportedMimeTypes?: RegExp[];
  };
  stt?: {
    supportedMimeTypes?: RegExp[];
  };
  checkType?: (fileType: string, supportedTypes: RegExp[]) => boolean;
};

export type FileConfigInput = {
  endpoints?: {
    [key: string]: EndpointFileConfig;
  };
  skills?: {
    fileSizeLimit?: number;
  };
  serverFileSizeLimit?: number;
  avatarSizeLimit?: number;
  clientImageResize?: {
    enabled?: boolean;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
  };
  ocr?: {
    supportedMimeTypes?: string[];
  };
  text?: {
    supportedMimeTypes?: string[];
  };
  stt?: {
    supportedMimeTypes?: string[];
  };
  checkType?: (fileType: string, supportedTypes: RegExp[]) => boolean;
};

export type TFile = {
  _id?: string;
  __v?: number;
  user: string;
  tenantId?: string;
  storageRegion?: string;
  storageKey?: string;
  conversationId?: string;
  message?: string;
  file_id: string;
  temp_file_id?: string;
  bytes: number;
  embedded: boolean;
  filename: string;
  filepath: string;
  object: 'file';
  type: string;
  usage: number;
  context?: FileContext;
  source?: FileSources;
  filterSource?: FileSources;
  width?: number;
  height?: number;
  expiresAt?: string | Date;
  preview?: string;
  text?: string;
  /**
   * Format of the `text` field. `'html'` means the backend produced
   * a sanitized full-document HTML preview the client may inject as
   * `index.html` inside the office artifact iframe. `'text'` (or
   * `undefined` for legacy records) is plain text and MUST NOT be
   * injected as HTML — render through the markdown/escaping path.
   * See Codex P1 review on PR #12934.
   */
  textFormat?: 'html' | 'text' | null;
  /**
   * Lifecycle of the inline preview rendered from `text`. `'pending'`
   * while background HTML extraction is in flight (deferred-preview
   * code-execution flow), `'ready'` once `text`/`textFormat` are set,
   * `'failed'` if extraction errored or hit the 60s ceiling. `undefined`
   * for legacy records and for files that never expect a preview —
   * clients MUST treat that as `'ready'`.
   */
  status?: 'pending' | 'ready' | 'failed';
  /**
   * Short machine-readable failure reason when `status === 'failed'`.
   * Suitable for tooltip text but not user-facing prose.
   */
  previewError?: string;
  metadata?: {
    fileIdentifier?: string;
    /**
     * Structured form of `fileIdentifier`. Persisted alongside the
     * legacy string during the dual-write transition; readers should
     * resolve via `resolveCodeEnvRef`.
     */
    codeEnvRef?: CodeEnvRef;
  };
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

export type TFileUpload = TFile & {
  temp_file_id: string;
};

/**
 * Shape returned by `GET /api/files/:file_id/preview`. The deferred-
 * preview code-execution flow polls this until status is terminal:
 *   - `pending`: HTML extraction is still running. No `text`.
 *   - `ready`: extraction succeeded; `text` + `textFormat` populated
 *     iff the file produced inline preview content (binary/oversized
 *     files reach `ready` with no text — render download-only).
 *   - `failed`: extraction errored or hit the 60s ceiling;
 *     `previewError` carries the short reason (`timeout`,
 *     `parser-error`, `orphaned`, etc.).
 *
 * Legacy records pre-dating the field are surfaced as `'ready'` server-
 * side so existing attachments keep rendering normally.
 */
export type TFilePreview = {
  file_id: string;
  status: 'pending' | 'ready' | 'failed';
  text?: string;
  textFormat?: 'html' | 'text' | null;
  previewError?: string;
};

export type AvatarUploadResponse = {
  url: string;
};

/** How a segment/word's `speaker` was actually decided - resolved by the
 *  transcription service, not this repo. `"overlap"`: a diarization turn
 *  genuinely overlapped this span, and the speaker with the most overlapping
 *  duration was used (pyannote's own `assign_word_speakers`). `"nearest"`:
 *  no turn overlapped this span, but the nearest one was within
 *  `MAX_NEAREST_FALLBACK_DISTANCE_S` - a real but lower-confidence fallback.
 *  `"unknown"`: no turn overlapped this span and the nearest one was too far
 *  away to trust - `speaker` is the literal string `"Unknown"`, not a guess.
 *  `"channel_split"`: no pyannote clustering was involved - the speaker is
 *  simply which audio channel this word/segment came from. `"none"`:
 *  diarization wasn't run at all. */
export type TSpeakerAssignmentMethod = 'overlap' | 'nearest' | 'unknown' | 'channel_split' | 'none';

/** One aligned word within a `TTranscriptSegment` - present only on the
 *  diarization-detail record (`transcript_diarization_detail`), never on the
 *  plain transcript shown in the UI. */
export type TWordSpan = {
  word: string;
  start?: number;
  end?: number;
  speaker?: string;
  assignmentMethod: TSpeakerAssignmentMethod;
  /** Seconds from the nearest diarization turn - `0` for `"overlap"`,
   *  `undefined` for `"channel_split"`/`"none"` (not applicable), a real gap
   *  for `"nearest"`/`"unknown"`. */
  assignmentDistanceS?: number;
};

/** One raw pyannote speaker turn, before this app's own sequential
 *  "Speaker N" renumbering - the ground truth `TTranscriptSegment.speaker`
 *  and `TWordSpan.speaker` are ultimately derived from. Empty for
 *  `channel_split` transcriptions, which never call pyannote. */
export type TDiarizationTurn = {
  start: number;
  end: number;
  /** Pyannote's own raw label, e.g. `"SPEAKER_00"` - not renumbered. */
  speaker: string;
};

/** One WhisperX segment, as returned by `POST /api/transcribe`. `words` and
 *  `assignmentMethod` are populated on the diarization-detail record only -
 *  the plain transcript response omits them to keep normal payloads small. */
export type TTranscriptSegment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
  assignmentMethod?: TSpeakerAssignmentMethod;
  assignmentDistanceS?: number;
  words?: TWordSpan[];
};

/** How a recording's turn-taking was classified - computed by the
 *  transcription service. `"insufficient_data"` when there are no segments
 *  at all. Thresholds are illustrative starting points, not calibrated
 *  against labelled data. */
export type TRecordingClassification =
  | 'monologue'
  | 'conversation'
  | 'rapid_dialogue'
  | 'difficult'
  | 'insufficient_data';

/** A statistical fingerprint of the recording's turn-taking - purely
 *  descriptive, computed once per transcription by the transcription service
 *  from the segments and raw diarization turns already produced; changes
 *  nothing about what got transcribed. */
export type TRecordingProfile = {
  speakerCount: number;
  turnCount: number;
  medianTurnDurationS: number;
  meanTurnDurationS: number;
  p95TurnDurationS: number;
  longestTurnS: number;
  speakerSwitchesPerMinute: number;
  /** Keyed by this transcript's renumbered `"Speaker N"` label. */
  speakerTimeDistributionS: Record<string, number>;
  /** Fraction of the diarized timeline where more than one speaker's turn
   *  overlaps - 0 whenever there were no raw diarization turns (e.g.
   *  channel_split), not necessarily "no overlap occurred." */
  overlapRatio: number;
  /** Fraction of total segment duration whose speaker came from a
   *  `"nearest"`/`"none"` assignment rather than direct diarization overlap -
   *  see `TSpeakerAssignmentMethod`. */
  unassignedAudioRatio: number;
  shortTurnRatio: number;
  /** Fraction of the recording's own time span that at least one raw
   *  diarization turn actually covers - distinct from `overlapRatio` (how
   *  much turns overlap EACH OTHER). A low value alongside a high
   *  `unassignedAudioRatio` points at real gaps in diarization coverage,
   *  not just noisy assignment. */
  diarizationCoverageRatio: number;
  /** Fraction of segments whose own span is covered by more than one
   *  distinct raw-diarization speaker - a segment straddling a turn
   *  boundary pyannote itself drew. */
  boundaryConflictRatio: number;
  /** Fraction of word-bearing segments where the segment's own `speaker`
   *  disagrees with the majority speaker among its own `words` - the two
   *  are computed independently, so this is a real diagnostic signal. */
  wordSegmentDisagreementRatio: number;
  /** Fraction of segments flagged for any of: a `"nearest"`-fallback
   *  assignment, a boundary conflict, or a word/segment disagreement. */
  suspiciousSegmentRatio: number;
  /** Which segment `id`s were actually flagged - a ratio alone tells you a
   *  recording is worth reviewing; this tells you where to look. */
  suspiciousSegmentIds: string[];
  classification: TRecordingClassification;
};

/** The full, persisted forensic/audit record for one transcription - see
 *  `FileContext.transcript_diarization_detail`. Fetched separately from the
 *  plain transcript; not part of the normal `/api/transcribe` response body. */
export type TTranscriptionDiarizationDetail = {
  segments: TTranscriptSegment[];
  diarizationTurns: TDiarizationTurn[];
  /** Keyed by pyannote's raw label (matches `TDiarizationTurn.speaker`), one
   *  vector per detected speaker cluster - not per word/segment. `null` for
   *  `channel_split` transcriptions. */
  speakerEmbeddings: Record<string, number[]> | null;
  /** Raw pyannote label -> this transcript's renumbered `"Speaker N"` (or
   *  `"Channel N"`) label, so an auditor can trace a displayed name back to
   *  the diarizer's own identity for it. */
  speakerLabelMap: Record<string, string>;
  diagnostics: Record<string, unknown>;
  recordingProfile: TRecordingProfile;
};

/** Per-recording transcription settings sent by the Audio Transcriber. Every
 *  field is optional: an absent one means "use the server's configured
 *  default", which is why the response reports the model that actually ran. */
export type TTranscribeOptions = {
  includeTimestamps?: boolean;
  diarize?: boolean;
  speakerCount?: number;
  clusteringThreshold?: number;
  language?: string;
  contextTerms?: string;
  model?: string;
  /** Whether digits are suppressed at the decoder. Absent takes the server's
   *  configured default; `false` is a real instruction, not an absent option. */
  suppressNumerals?: boolean;
  /** True once the caller has confirmed splitting by audio channel instead
   *  of pyannote clustering, after being notified the file has more than one
   *  channel (see `MultiChannelDialog`). Each channel is transcribed and
   *  labelled as its own speaker; `speakerCount` is ignored when this is set. */
  channelSplit?: boolean;
};

/** This deployment's effective transcription defaults - what each "auto"
 *  option actually resolves to, so the UI can name it rather than hide it. */
export type TTranscribeConfig = {
  models: string[];
  default_model: string;
  default_language?: string | null;
  default_suppress_numerals: boolean;
  default_clustering_threshold?: number | null;
  hotwords_configured: boolean;
  /** Vocabulary offered as one-click suggestions. Never sent on its own - a
   *  suggestion only reaches the decoder once the user confirms it. */
  suggested_terms: string[];
  /** The real server-side cap on `speakerCount` - values above this are
   *  clamped silently by the diarizer, so the UI stops the user at the same
   *  number rather than letting them type past it. */
  max_speakers: number;
};

/** Lifecycle of a transcript's RAG index relative to its own canonical text -
 *  see `IMongoFile.indexStatus` in `@librechat/data-schemas`. `'stale'`: a
 *  newer `transcriptVersion` exists than `indexVersion` reflects, and
 *  re-indexing hasn't started yet. `'indexing'`: an embed call is in flight.
 *  `'indexed'`: the last embed succeeded and `indexVersion ===
 *  transcriptVersion`. `'index_failed'`: the last embed attempt (including
 *  retries) failed - `file_search` may still be serving an older version, or
 *  nothing at all. */
export type TTranscriptIndexStatus =
  | 'not_indexed'
  | 'stale'
  | 'indexing'
  | 'indexed'
  | 'index_failed';

/** A transcript file's identity plus its indexing state - lets a caller tell
 *  "indexed and current" apart from "still indexing" or "the last index
 *  attempt failed" without a separate lookup. See `POST
 *  /api/transcript-corrections/:transcriptFileId/reindex` to retry a failed
 *  or stale index manually. */
export type TTranscriptFileStatus = {
  file_id: string;
  filename: string;
  transcriptVersion: number;
  indexVersion: number | null;
  indexStatus: TTranscriptIndexStatus;
};

/** A source-audio File's transcription job state - `IFileTranscriptionJob`
 *  on the server, transcription/ARCHITECTURE.md §4.1. */
export type TTranscribeJobStatus = 'queued' | 'transcribing' | 'ready' | 'failed';

/** Response shape for `POST /api/transcribe/probe` (Phase 4,
 *  transcription/ARCHITECTURE.md §6.2) - the server-side `ffprobe` channel
 *  count replacing the composer's old client-side Web Audio API heuristic. */
export type TAudioChannelProbeResponse = {
  channelCount: number;
};

/**
 * Response shape for `POST /api/transcribe`, `POST /:sourceFileId/retry`,
 * and `POST /:sourceFileId/retranscribe` (Phase 2, async job model - see
 * transcription/ARCHITECTURE.md §5.1). The job has been accepted and
 * queued, not completed - there are no `segments`/`diagnostics` here
 * anymore, since transcription hasn't run yet at the time this responds.
 * Poll `GET /api/transcribe/status` for the outcome.
 */
export type TTranscribeQueuedResponse = {
  conversationId: string;
  sourceFile: { file_id: string; filename: string };
  status: TTranscribeJobStatus;
  /** Jobs ahead of this one (including one already in flight), at the
   *  moment this was enqueued - a one-time estimate, not a live counter. */
  queuePosition: number;
  /** The new user message's id - only set by `POST /api/transcribe` (which
   *  creates one), not `/retry`/`/retranscribe` (which re-run an existing
   *  job with no new message). Callers use this as the `parentMessageId` for
   *  whatever gets attached to this same conversation next, so two
   *  recordings queued back-to-back chain as parent/child instead of landing
   *  as siblings under the same parent (which would leave only one visible
   *  in the message list, per LibreChat's default single-branch rendering). */
  messageId?: string;
};

/**
 * Response shape for `POST /:sourceFileId/cancel` - a best-effort cancel of
 * a `queued`/`transcribing` job. `status` is always `'failed'`: cancellation
 * reuses that terminal value (with `error: 'Cancelled by user'` and its own
 * `cancelledAt` timestamp on the underlying record) rather than a dedicated
 * status, so the existing `POST /:sourceFileId/retry` and every other
 * "is this terminal?" check need no changes to also handle a cancelled job.
 */
export type TTranscribeCancelResponse = {
  sourceFile: { file_id: string; filename: string };
  status: 'failed';
  cancelled: true;
};

/**
 * Response shape for `GET /:sourceFileId/audio-token` (transcription/
 * ARCHITECTURE.md §12 #13) - `url` is a relative, ready-to-use path
 * (`/api/transcribe/:sourceFileId/audio?token=...`) the transcript panel
 * sets directly as its `<audio src>`, carrying its own short-lived auth
 * rather than needing an `Authorization` header the element can't send.
 */
export type TTranscribeAudioTokenResponse = {
  url: string;
  /** Seconds until `url`'s token stops working - long enough to outlast a
   *  real listening session, not meant for a countdown UI. */
  expiresIn: number;
};

/** One source file's current job state, as returned by
 *  `GET /api/transcribe/status` - the batch poll for the cards/panel of an
 *  open conversation. */
export type TTranscribeStatusEntry = {
  file_id: string;
  status: TTranscribeJobStatus;
  /** Server diagnosis text - set only when `status === 'failed'`. */
  error: string | null;
  /** `status === 'failed'` because the user cancelled it (`POST
   *  /:sourceFileId/cancel`), not because it genuinely failed - lets the UI
   *  show "Cancelled" instead of a generic failure message without having
   *  to string-match `error`. */
  cancelled: boolean;
  transcriptFileId: string | null;
  /** The forensic/audit record described by `TTranscriptionDiarizationDetail` -
   *  fetch and parse its `text` field (via the regular files API) to read it;
   *  never embedded into RAG, never shown in the transcript pane. */
  diarizationDetailFileId: string | null;
};

export type TTranscribeStatusResponse = {
  /** Only ids the caller owns are ever present - an id that doesn't resolve
   *  (not found, not owned, or not a source file) is silently omitted
   *  rather than erroring the whole poll. */
  files: TTranscribeStatusEntry[];
};

/**
 * One recording attached to a conversation, as the single read model every
 * consumer - retrieval, the transcript panel, the in-chat card - answers
 * "does this conversation have a queryable transcript?" from.
 *
 * Derived entirely from the `File` collection, which already carries
 * `conversationId` on both the source audio and its transcript. Nothing here
 * is read from `Conversation.files[]`: that array is a denormalized pointer
 * list maintained for general agent file resolution, and deriving transcript
 * state from it is what let a client cache that had never been refetched
 * since job completion decide the conversation had no transcript at all.
 */
export type TConversationTranscript = {
  /** The source audio File's id - the stable identity for this recording
   *  from upload through to answer. Its derived files are always
   *  `${sourceFileId}-transcript` and `${sourceFileId}-diarization-detail`. */
  sourceFileId: string;
  /** What to show the user for this recording. The original upload's name
   *  when it was preserved, else the stored (ffmpeg-extracted) filename. */
  displayName: string;
  /** Absent until the job produces segments - a recording that is `queued`
   *  or `transcribing` legitimately has no transcript file yet, and callers
   *  must render that as in-progress rather than as absence. */
  transcriptFileId: string | null;
  diarizationDetailFileId: string | null;
  /** Absent only for a source file whose transcription job record is
   *  missing entirely (pre-migration records). */
  jobStatus: TTranscribeJobStatus | null;
  /** Server diagnosis text - set only when `jobStatus === 'failed'`. */
  jobError: string | null;
  /** `jobStatus === 'failed'` because the user cancelled, not a real
   *  failure - mirrors `TTranscribeStatusEntry.cancelled`. */
  cancelled: boolean;
  /** This transcript's RAG index state. `null` when there is no transcript
   *  file yet, or for legacy records written before the field existed. */
  indexStatus: TTranscriptIndexStatus | null;
  /** THE authoritative answer, and the only field retrieval is allowed to
   *  gate on. True iff a transcript file exists and its RAG index reflects
   *  the current transcript text - not merely that some embed once
   *  succeeded. See `isTranscriptQueryable`. */
  isQueryable: boolean;
  /** Why `isQueryable` is false, so a caller can tell the user something
   *  true instead of "no files found" - `null` when it is true. */
  unqueryableReason: TTranscriptUnqueryableReason | null;
};

/** Why a recording cannot currently be searched. Distinguishes "not yet"
 *  from "tried and failed" from "the text moved on since it was indexed",
 *  because those are three different things to tell a user and only the
 *  middle one is a fault. */
export type TTranscriptUnqueryableReason =
  /** The job has not produced a transcript yet (`queued`/`transcribing`). */
  | 'in_progress'
  /** The job failed or was cancelled; no transcript will exist for it. */
  | 'job_failed'
  /** A transcript exists but was never submitted for embedding. */
  | 'not_indexed'
  /** Embedding was attempted and failed - the recoverable fault case. */
  | 'index_failed'
  /** The transcript has been edited since it was last indexed, so the index
   *  would answer from superseded text. */
  | 'stale_index';

export type TConversationTranscriptsResponse = {
  /** Every recording on the conversation, oldest first. Empty for a
   *  conversation that has never had one - which is the common case, and is
   *  not an error. */
  transcripts: TConversationTranscript[];
};

/** One append-only correction event against an Audio Transcriber transcript -
 *  see `GET/POST /api/transcript-corrections`. Never edited or deleted; the
 *  client replays the full chronological list (last write per key wins) to
 *  derive current speaker names and segment reassignments. */
export type TTranscriptCorrection = {
  _id: string;
  transcriptFileId: string;
  conversationId: string;
  user: string;
  type: 'speaker_rename' | 'segment_reassign' | 'text_edit' | 'line_insert' | 'time_edit';
  speakerId?: string;
  fromName?: string;
  toName?: string;
  lineIndex?: number;
  fromSpeakerId?: string;
  toSpeakerId?: string;
  fromText?: string;
  toText?: string;
  /** line_insert: the new line's speaker id, text, and time range - see
   *  `TLineInsertRequest`. */
  speaker?: string;
  text?: string;
  /** line_insert: the new line's start/end time. time_edit: this line's
   *  corrected start/end time - see `TLineInsertRequest`/`TTimeEditRequest`. */
  seconds?: number;
  endSeconds?: number;
  /** time_edit: this line's start/end time before this event, for audit
   *  context only - the canonical current value is still whichever time_edit
   *  event is latest. */
  fromSeconds?: number;
  fromEndSeconds?: number;
  createdAt: string;
};

export type TSpeakerRenameRequest = {
  conversationId: string;
  speakerId: string;
  fromName?: string;
  toName: string;
};

export type TSegmentReassignRequest = {
  conversationId: string;
  lineIndex: number;
  fromSpeakerId?: string;
  toSpeakerId: string;
};

export type TTextEditRequest = {
  conversationId: string;
  lineIndex: number;
  fromText?: string;
  toText: string;
};

/** Corrects a line's start/end time - the pipeline's automatic alignment can
 *  drift or land on the wrong words entirely, and there's no way to fix that
 *  except by hand. `endSeconds` must be strictly greater than `seconds`. */
export type TTimeEditRequest = {
  conversationId: string;
  lineIndex: number;
  fromSeconds?: number;
  fromEndSeconds?: number;
  seconds: number;
  endSeconds: number;
};

/** A line the pipeline missed entirely, not a correction to an existing one.
 *  `lineIndex` must be strictly between the two neighboring lines' own
 *  indices at insert time (fractional, e.g. `4.5` between lines `4` and `5`) -
 *  the client, not the server, computes it, since only the client has the
 *  currently-displayed neighbor lines to compute it from. */
export type TLineInsertRequest = {
  conversationId: string;
  lineIndex: number;
  speaker?: string;
  text: string;
  seconds: number;
  endSeconds: number;
};

export type FileDownloadURLResponse = {
  url: string;
  filename: string;
  type: string;
  metadata: Partial<TFile>;
};

export type SpeechToTextResponse = {
  text: string;
};

export type VoiceResponse = string[];

export type UploadMutationOptions = {
  onSuccess?: (data: TFileUpload, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type UploadAvatarOptions = {
  onSuccess?: (data: AvatarUploadResponse, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type SpeechToTextOptions = {
  onSuccess?: (data: SpeechToTextResponse, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type TextToSpeechOptions = {
  onSuccess?: (data: ArrayBuffer, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type VoiceOptions = {
  onSuccess?: (data: VoiceResponse, variables: unknown, context?: unknown) => void;
  onMutate?: () => void | Promise<unknown>;
  onError?: (error: unknown, variables: unknown, context?: unknown) => void;
};

export type TFilesUsageBody = {
  file_ids: string[];
};

export type TFilesUsageResponse = {
  marked: number;
};

export type DeleteFilesResponse = {
  message: string;
  result: Record<string, unknown>;
};

export type BatchFile = {
  file_id: string;
  filepath: string;
  storageRegion?: string;
  storageKey?: string;
  embedded: boolean;
  source: FileSources;
  temp_file_id?: string;
};

export type DeleteFilesBody = {
  files: BatchFile[];
  agent_id?: string;
  assistant_id?: string;
  tool_resource?: EToolResources;
};

export type DeleteMutationOptions = {
  onSuccess?: (data: DeleteFilesResponse, variables: DeleteFilesBody, context?: unknown) => void;
  onMutate?: (variables: DeleteFilesBody) => void | Promise<unknown>;
  onError?: (error: unknown, variables: DeleteFilesBody, context?: unknown) => void;
};
