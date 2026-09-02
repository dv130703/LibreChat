import { Document, Types } from 'mongoose';
import type { CodeEnvRef } from 'librechat-data-provider';

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
