import { logger } from '@librechat/data-schemas';
import { FileContext, FileSources, mergeFileConfig } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { processTextWithTokenLimit } from '~/utils/text';
import type { TokenCountFn } from '~/utils/text';

/**
 * Extracts text context from attachments and returns formatted text.
 * This handles text that was already extracted from files (OCR, transcriptions, document text, etc.)
 * @param params - The parameters object
 * @param params.attachments - Array of file attachments
 * @param params.req - Express request object for config access
 * @param params.tokenCountFn - Function to count tokens in text
 * @returns The formatted file context text, or undefined if no text found
 */
/**
 * File kinds that must never be pasted into a prompt, whatever their
 * `embedded` flag happens to say.
 *
 * A transcript is retrieved through `file_search`, one relevant chunk at a
 * time. Its full text is also stored inline on the File record, which makes
 * it eligible for the "not embedded, so ride along in context" fallback
 * below - and that fallback is a trap for exactly this file kind. A failed or
 * stale embed flips `embedded` to false, at which point an entire recording's
 * transcript (tens of KB, and unbounded in principle) would silently start
 * being prepended to every prompt in the conversation. Against a local model
 * served at Ollama's 4096-token default that alone overflows the window
 * before the user's question is even appended, and the truncation that
 * follows is silent.
 *
 * The diarization-detail record is worse: raw pyannote turns, speaker
 * embeddings and per-word assignments, up to 14MB of inline JSON, of no use
 * to a model at all.
 *
 * So the rule is structural rather than conventional: a transcript is either
 * retrievable via RAG or it is honestly reported as unavailable (see
 * `buildUnavailableTranscriptNotice`). It is never inlined. Previously this
 * was held only by every write site remembering to keep `embedded` true -
 * see the comment in `transcriptCorrections.js` on why one missed update
 * would have been "a much bigger regression".
 */
const NEVER_INLINED_CONTEXTS: ReadonlySet<string> = new Set([
  FileContext.transcript_rag,
  FileContext.transcript_diarization_detail,
]);

/**
 * Whether a file's full text must never be pasted into a prompt unmediated -
 * see `NEVER_INLINED_CONTEXTS`. Exported so every place that can inject raw
 * file text (`extractFileContext` below, and `createContextHandlers.js`'s
 * `RAG_USE_FULL_CONTEXT` path, which fetches a file's whole reassembled text
 * as a fallback to chunk-level search) shares one rule instead of each
 * keeping its own copy that can drift.
 */
export function isNeverInlinedFileContext(context: string | null | undefined): boolean {
  return context != null && NEVER_INLINED_CONTEXTS.has(context);
}

export async function extractFileContext({
  attachments,
  req,
  tokenCountFn,
}: {
  attachments: IMongoFile[];
  req?: ServerRequest;
  tokenCountFn: TokenCountFn;
}): Promise<string | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const fileConfig = mergeFileConfig(req?.config?.fileConfig);
  const fileTokenLimit = req?.body?.fileTokenLimit ?? fileConfig.fileTokenLimit;

  if (!fileTokenLimit) {
    // If no token limit, return undefined (no processing)
    return undefined;
  }

  let resultText = '';

  for (const file of attachments) {
    if (isNeverInlinedFileContext(file.context)) {
      logger.debug(
        `[extractFileContext] Skipping ${file.context} file "${file.filename}" - retrieved via file_search, never inlined.`,
      );
      continue;
    }

    const source = file.source ?? FileSources.local;
    // A file that's already embedded is retrieved through `file_search`, not
    // blind inclusion - baking its full text into every prompt on top of that
    // would double-deliver it (once via the tool, once unconditionally here)
    // and, for something the size of a full transcript, can alone overflow the
    // context window before the user has typed anything. Only text extracted
    // for files that were NOT embedded (too small to warrant RAG, or embedding
    // failed) is meant to ride along in context this way.
    if (source === FileSources.text && file.text && !file.embedded) {
      const { text: limitedText, wasTruncated } = await processTextWithTokenLimit({
        text: file.text,
        tokenLimit: fileTokenLimit,
        tokenCountFn,
      });

      if (wasTruncated) {
        logger.debug(
          `[extractFileContext] Text content truncated for file: ${file.filename} due to token limits`,
        );
      }

      resultText += `${!resultText ? 'Attached document(s):\n```md' : '\n\n---\n\n'}# "${file.filename}"\n${limitedText}\n`;
    }
  }

  if (resultText) {
    resultText += '\n```';
    return resultText;
  }

  return undefined;
}
