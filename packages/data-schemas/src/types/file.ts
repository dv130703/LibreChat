import { Document, Types } from 'mongoose';
import type { CodeEnvRef, TTranscribeOptions } from 'librechat-data-provider';
import type { ITranscriptionMeta } from './convo';

/**
 * Per-recording transcription job state, carried on the *source audio*
 * File doc (not the transcript file, and not `Conversation.transcription` -
 * see `transcription/ARCHITECTURE.md` D3/D4). Anchoring here means a
 * Audio Transcriber card always has something to read the instant an
 * upload lands, before any transcript exists, and still has something to
 * read in a failure state where no transcript will ever exist.
 *
 * `Conversation.transcription` (`ITranscriptionMeta`) is deprecated in
 * favor of this field as of the same migration - see
 * `IConversation.transcription`'s own doc comment.
 */
export interface IFileTranscriptionJob {
  status: 'queued' | 'transcribing' | 'ready' | 'failed';
  /** uuid, for log correlation - not a Mongo `_id`. */
  jobId: string;
  /** Which process last held this job. Meaningful once dispatch is
   *  coordinated across more than one instance; until then it identifies
   *  the single instance every job runs on. */
  instanceId: string;
  /** Updated while `status === 'transcribing'`; the reconciliation sweep
   *  (Phase 2) uses staleness here to detect a job an instance abandoned
   *  mid-run (e.g. a process restart) rather than one still in progress. */
  heartbeatAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Server diagnosis text, shown on the card - set only when `status === 'failed'`. */
  error?: string;
  /** The options this job was asked to run with. Optional, not just in the
   *  historical-migration case (`Conversation.transcription` never captured
   *  the original request, only the server-resolved values) but in general:
   *  every field of `TTranscribeOptions` is itself optional, so a caller
   *  requesting every default produces `{}` - and Mongoose's default
   *  `minimize` behavior strips an empty object out of a `Mixed` field
   *  entirely before it's ever persisted, so "no options were requested"
   *  and "this field is absent" are the same observable state on read.
   *  Absence should be read as "nothing beyond defaults was requested",
   *  not as missing data. */
  requestedOptions?: TTranscribeOptions;
  /** The options the pipeline actually resolved and ran under - seeds
   *  Re-transcribe's option dialog with what really produced the current
   *  transcript rather than the request's possibly-"auto" values. */
  effectiveOptions?: ITranscriptionMeta;
  transcriptFileId?: string;
  diarizationDetailFileId?: string;
  durationS?: number;
  speakerCount?: number;
}

export interface IMongoFile extends Omit<Document, 'model'> {
  user: Types.ObjectId;
  conversationId?: string;
  messageId?: string;
  file_id: string;
  temp_file_id?: string;
  bytes: number;
  text?: string;
  /**
   * Format of the `text` field — `'html'` when the backend produced
   * a sanitized full-document HTML preview (e.g. office types via
   * `bufferToOfficeHtml`), `'text'` for plain-text extracts (e.g.
   * RAG mammoth/pdf-parse output), `undefined` for legacy records
   * that pre-date the field. Clients MUST treat `undefined` as
   * `'text'` and refuse to inject the value into HTML contexts —
   * otherwise plain document text containing `<script>` tags would
   * become executable markup. See Codex P1 review on PR #12934.
   */
  textFormat?: 'html' | 'text';
  /**
   * Lifecycle of the inline preview rendered from `text`. Tracks the
   * deferred-preview code-execution flow (PR #12951 follow-up): the
   * immediate persist step saves the file blob and emits the attachment
   * record with `status: 'pending'`; a background render runs HTML
   * extraction and updates the record to `'ready'` (with `text` +
   * `textFormat`) or `'failed'` (with `previewError`). Decouples the
   * agent's final response from CPU-heavy office-format rendering.
   *
   * Absent for legacy records and for files that never expect a preview
   * (RAG uploads, images, plain-text artifacts). Clients MUST treat
   * `undefined` as `'ready'` so prior-version records render normally.
   */
  status?: 'pending' | 'ready' | 'failed';
  /**
   * Short machine-readable reason when `status === 'failed'` —
   * `'timeout'`, `'parser-error'`, `'oversized'`, `'orphaned'`. UI hint
   * for tooltip text; not user-facing prose. Absent otherwise.
   */
  previewError?: string;
  /**
   * Generation marker for the deferred-preview lifecycle. The
   * immediate persist step stamps a fresh UUID on every emit; the
   * deferred render's update only commits when the marker still
   * matches. Guards against an older render overwriting a newer
   * record on cross-turn filename reuse. Absent for legacy records
   * and for files that never expect a preview.
   */
  previewRevision?: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  object: 'file';
  embedded?: boolean;
  /**
   * How many times this file's canonical text has changed - the Audio
   * Transcriber bumps this on every correction and every re-transcribe (see
   * `db.markTranscriptStale`). Absent for file kinds that never revise their
   * own text after creation.
   */
  transcriptVersion?: number;
  /**
   * Which `transcriptVersion` is actually reflected in this file's RAG
   * index right now - compare against `transcriptVersion` to detect a stale
   * index without inferring it from `indexStatus` alone (a transient
   * 'indexing'/'index_failed' status doesn't by itself say which version,
   * if any, was last successfully indexed).
   */
  indexVersion?: number | null;
  /**
   * Lifecycle of this file's RAG index relative to `transcriptVersion`.
   * `'stale'`: a newer `transcriptVersion` exists than what `indexVersion`
   * reflects, and re-indexing hasn't started yet. `'indexing'`: an embed
   * call is in flight. `'indexed'`: the last embed succeeded and
   * `indexVersion === transcriptVersion`. `'index_failed'`: the last embed
   * attempt (including retries) failed. Absent/`'not_indexed'` for file
   * kinds that were never meant to be indexed, or before the first attempt.
   */
  indexStatus?: 'not_indexed' | 'stale' | 'indexing' | 'indexed' | 'index_failed';
  /** Audio Transcriber: present only on a *source audio* File doc, present
   *  from the moment the upload is accepted through job completion or
   *  failure. See `IFileTranscriptionJob`. */
  transcription?: IFileTranscriptionJob;
  /** Audio Transcriber: present only on a *transcript* File doc - explicit
   *  back-reference to the source audio File this transcript belongs to.
   *  Replaces inferring it by elimination (transcript/diarization-detail
   *  ids are known suffixes; whatever file id remains on the conversation
   *  was assumed to be the source) - see `transcription/ARCHITECTURE.md` I3. */
  sourceFileId?: string;
  type: string;
  context?: string;
  usage: number;
  source: string;
  model?: string;
  width?: number;
  height?: number;
  metadata?: {
    /**
     * Code-environment cache pointer for files re-uploadable to
     * codeapi (chat attachments, agent tool resources, code-output
     * files). Carries the resource kind + identity so codeapi can
     * derive the sessionKey explicitly.
     */
    codeEnvRef?: CodeEnvRef;
  };
  expiresAt?: Date;
  expiredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}
