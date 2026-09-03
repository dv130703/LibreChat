import type { IFileTranscriptionJob, ITranscriptionMeta } from '@librechat/data-schemas';

/**
 * Resolves a conversation's effective transcription metadata during the
 * migration window opened by `transcription/ARCHITECTURE.md` §4.3/Phase 1:
 * prefers the source audio File's own job state
 * (`IFileTranscriptionJob.effectiveOptions`, written live as of Phase 1,
 * backfilled for historical conversations by
 * `config/migrate-transcription-to-file.js`), falling back to the
 * deprecated `Conversation.transcription` sub-document only when the File
 * doc hasn't been migrated yet or wasn't found.
 *
 * Not yet wired into a live route - Phase 2 ("route rekeying", §5.2) is
 * where callers actually switch from reading `Conversation.transcription`
 * to calling this. Exists now, tested now, so Phase 2 has a single
 * correct implementation to reach for instead of each call site
 * reinventing the fallback order.
 */
export function resolveTranscriptionMeta(
  sourceFile: { transcription?: IFileTranscriptionJob } | null | undefined,
  conversation: { transcription?: ITranscriptionMeta } | null | undefined,
): ITranscriptionMeta | undefined {
  return sourceFile?.transcription?.effectiveOptions ?? conversation?.transcription;
}
