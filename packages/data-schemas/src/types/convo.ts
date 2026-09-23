import type { Document, Types } from 'mongoose';

/**
 * @deprecated As of the transcription-to-file migration (see
 * `transcription/ARCHITECTURE.md` D3/D4/§4.3), this now lives on the
 * *source audio* `File` doc as `IFileTranscriptionJob['effectiveOptions']`
 * instead - a single-conversation sub-document can't represent more than
 * one recording, and Audio Transcriber conversations may now hold several.
 * Kept, and still written, for one release as a dual-write/dual-read
 * fallback for conversations transcribed before the migration; slated for
 * removal in Phase 6.
 */
export interface ITranscriptionMeta {
  model?: string;
  requestedModel?: string;
  language?: string;
  diarize?: boolean;
  speakerCount?: number;
  clusteringThreshold?: number;
  includeTimestamps?: boolean;
  contextTerms?: string;
  voiceRecognition?: boolean;
  suppressNumerals?: boolean;
  channelSplit?: boolean;
  diarizationBackend?: string;
}

// @ts-ignore
export interface IConversation extends Document {
  conversationId: string;
  title?: string;
  user?: string;
  messages?: Types.ObjectId[];
  isTemporary?: boolean;
  // Fields provided by conversationPreset (adjust types as needed)
  endpoint?: string;
  endpointType?: string;
  model?: string;
  region?: string;
  chatGptLabel?: string;
  examples?: unknown[];
  modelLabel?: string;
  promptPrefix?: string;
  temperature?: number;
  top_p?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  file_ids?: string[];
  resendImages?: boolean;
  promptCache?: boolean;
  promptCacheTtl?: '5m' | '1h';
  thinking?: boolean;
  thinkingBudget?: number;
  effort?: string;
  system?: string;
  resendFiles?: boolean;
  imageDetail?: string;
  agent_id?: string;
  assistant_id?: string;
  instructions?: string;
  stop?: string[];
  isArchived?: boolean;
  pinned?: boolean;
  iconURL?: string;
  greeting?: string;
  spec?: string;
  tags?: string[];
  chatProjectId?: string | null;
  tools?: string[];
  maxContextTokens?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  reasoning_summary?: string;
  reasoning_mode?: string;
  reasoning_context?: string;
  verbosity?: string;
  useResponsesApi?: boolean;
  web_search?: boolean;
  url_context?: boolean;
  disableStreaming?: boolean;
  fileTokenLimit?: number;
  // Additional fields
  files?: string[];
  transcription?: ITranscriptionMeta;
  expiredAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}
