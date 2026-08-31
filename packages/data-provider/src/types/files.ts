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

/** One WhisperX segment, as returned by `POST /api/transcribe`. */
export type TTranscriptSegment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
};

/** Per-recording transcription settings sent by the Audio Transcriber. Every
 *  field is optional: an absent one means "use the server's configured
 *  default", which is why the response reports the model that actually ran. */
export type TTranscribeOptions = {
  includeTimestamps?: boolean;
  diarize?: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  clusteringThreshold?: number;
  language?: string;
  contextTerms?: string;
  context?: string;
  model?: string;
  /** Whether digits are suppressed at the decoder. Absent takes the server's
   *  configured default; `false` is a real instruction, not an absent option. */
  suppressNumerals?: boolean;
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
};

/** Response shape for `POST /api/transcribe` (Audio Transcriber section). */
export type TTranscribeResponse = {
  conversationId: string;
  segments: TTranscriptSegment[];
  language?: string;
  diagnostics?: Record<string, unknown>;
  sourceFile: { file_id: string; filename: string };
  transcriptFile: { file_id: string; filename: string } | null;
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
