const { logger } = require('@librechat/data-schemas');
const { applyTranscriptCorrections } = require('@librechat/api');
const { embedTranscript } = require('~/server/services/Transcription');
const db = require('~/models');

/**
 * One in-flight re-embed per transcript at a time. The roster modal's "Save
 * Changes" fires several corrections back-to-back (one `speaker_rename` per
 * edited row) without waiting for each to land - without this, their
 * `reembedCorrectedTranscript` calls run concurrently, and each reads
 * `getTranscriptCorrections` at its OWN start time. Whichever POST to the RAG
 * server happens to finish last wins (`/embed` replaces all chunks for the
 * file_id), which is not necessarily the one with the freshest snapshot -
 * a real, if narrow, way for a rename made in that batch to silently vanish
 * from what `file_search` actually retrieves. Chaining each call after the
 * previous one's promise settles guarantees strict in-order execution, so by
 * the time call N reads the correction log, call N-1's write has already
 * landed.
 */
const reembedQueues = new Map();

/**
 * Re-embeds the transcript's RAG index from its full correction history -
 * called after every correction lands, so `file_search` (what the model
 * actually retrieves from) reflects renamed speakers, reassigned lines,
 * edited text, and inserted lines instead of the original pipeline output
 * forever. Re-uploading under the SAME `file_id` replaces its RAG chunks
 * rather than duplicating them (see `rag_server/app.py`'s `/embed`), so this
 * is safe to call after every single edit, not just batched.
 *
 * Deliberately not awaited by callers: a correction is a small, interactive
 * edit and should feel instant, not wait on a network round-trip to the RAG
 * server. The Mongo-stored base transcript text is left untouched either way
 * - "original pipeline output stays recoverable" - only the RAG index catches
 * up to the corrected version.
 */
function reembedCorrectedTranscript(req, transcriptFileId, conversationId) {
  const previous = reembedQueues.get(transcriptFileId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => performReembed(req, transcriptFileId, conversationId));
  reembedQueues.set(transcriptFileId, next);
  next.finally(() => {
    // Only clear the entry if nothing queued behind this one - otherwise a
    // newer call's own cleanup would already be responsible for it.
    if (reembedQueues.get(transcriptFileId) === next) {
      reembedQueues.delete(transcriptFileId);
    }
  });
  // Callers that don't need to wait (every correction route) just ignore
  // this; the manual `/reindex` route still awaits it, going through the
  // same per-transcript queue as any correction-triggered re-embed so the
  // two can never race each other.
  return next;
}

async function performReembed(req, transcriptFileId, conversationId) {
  try {
    const baseFile = await db.findFileById(transcriptFileId);
    if (!baseFile?.text) {
      return;
    }
    await db.updateFile({ file_id: transcriptFileId, indexStatus: 'indexing' });

    const corrections = await db.getTranscriptCorrections(transcriptFileId);
    const correctedText = applyTranscriptCorrections(baseFile.text, corrections);

    // Read again right before the embed call itself - the closest possible
    // snapshot to what's actually about to be embedded. A correction that
    // lands in the narrow gap between the reads above and this one is still
    // captured correctly: its own queued reembed (see `reembedQueues`) will
    // run next and simply re-derive/re-embed the same-or-newer text,
    // converging `indexVersion` to the right value either way.
    const versionBeingEmbedded =
      (await db.findFileById(transcriptFileId))?.transcriptVersion ?? null;

    const embedded = await embedTranscript({
      req,
      file_id: transcriptFileId,
      filename: baseFile.filename ?? `${transcriptFileId}.md`,
      text: correctedText,
    });

    if (embedded) {
      // Only ever upgrades `embedded` false -> true, never the reverse: a
      // transient failure here (RAG server hiccup) shouldn't retroactively
      // mark a previously-successful embed as gone, which would make the
      // full raw text start riding along in every future prompt as
      // `extractFileContext`'s fallback for anything not embedded - a much
      // bigger regression than one correction's RAG index lagging behind.
      await db.updateFile({
        file_id: transcriptFileId,
        embedded: true,
        indexStatus: 'indexed',
        indexVersion: versionBeingEmbedded,
      });
    } else {
      await db.updateFile({ file_id: transcriptFileId, indexStatus: 'index_failed' });
    }
    logger.info(
      `[TRANSCRIPTION] re-embedded corrected transcript file_id=${transcriptFileId} conversationId=${conversationId} embedded=${embedded} version=${versionBeingEmbedded}`,
    );
  } catch (error) {
    await db.updateFile({ file_id: transcriptFileId, indexStatus: 'index_failed' }).catch(() => {});
    logger.error('[transcriptCorrections] Failed to re-embed corrected transcript', error);
  }
}

/**
 * Saves one correction event, bumps `transcriptVersion` and marks the index
 * `'stale'` in the same request (before the un-awaited re-embed even starts -
 * see `reembedCorrectedTranscript`), and enqueues the re-embed. Shared by
 * every correction route in `transcriptCorrections.js`, and by the automatic
 * speaker-labeling step in `transcribe.js`, so the version/status bookkeeping
 * can't drift between a manual and an automatic correction.
 */
async function recordCorrectionAndReembed(req, transcriptFileId, conversationId, correctionData) {
  const correction = await db.createTranscriptCorrection(correctionData);
  await db.markTranscriptStale(transcriptFileId);
  reembedCorrectedTranscript(req, transcriptFileId, conversationId);
  return correction;
}

module.exports = { recordCorrectionAndReembed, reembedCorrectedTranscript };
