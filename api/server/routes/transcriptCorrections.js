const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { planLineDeletion, applyTranscriptCorrectionsStructured } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const {
  recordCorrectionAndReembed,
  reembedCorrectedTranscript,
} = require('~/server/services/Transcription/corrections');
const db = require('~/models');

const router = express.Router();
router.use(requireJwtAuth);

/**
 * Corrections a forensic reviewer makes to an Audio Transcriber transcript -
 * renaming a speaker, reassigning a misattributed line, editing text,
 * inserting a line the pipeline missed entirely, or correcting a line's
 * timing - stored as an
 * append-only event log (see `packages/data-schemas/src/schema/transcriptCorrection.ts`)
 * rather than an edit to the transcript text itself, so the original pipeline
 * output stays recoverable and every change carries real user attribution.
 *
 * Every route below first confirms `req.user` owns `conversationId` via
 * `db.getConvo`, which scopes its query by `user` - a mismatched owner gets a
 * `null` back exactly like a nonexistent conversation, never someone else's data.
 */

async function assertOwnsConversation(req, res, conversationId) {
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId is required' });
    return false;
  }
  const convo = await db.getConvo(req.user.id, conversationId);
  if (!convo) {
    res.status(404).json({ error: 'Conversation not found' });
    return false;
  }
  return true;
}

/** All correction events for a transcript, chronological - the client
 *  replays them (last write per key wins) to derive current speaker names
 *  and segment reassignments. */
router.get('/:transcriptFileId', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId } = req.query;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    const corrections = await db.getTranscriptCorrections(transcriptFileId);
    res.json(corrections);
  } catch (error) {
    logger.error('[GET /api/transcript-corrections/:transcriptFileId] Failed', error);
    res.status(500).json({ error: 'Failed to load transcript corrections' });
  }
});

/** Renames a speaker - applies to every line from that speaker at once, since
 *  the name is a property of the speaker id, not any individual line. */
router.post('/:transcriptFileId/speaker-rename', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId, speakerId, fromName, toName } = req.body;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    if (!speakerId || !toName) {
      return res.status(400).json({ error: 'speakerId and toName are required' });
    }
    const correction = await recordCorrectionAndReembed(req, transcriptFileId, conversationId, {
      transcriptFileId,
      conversationId,
      user: req.user.id,
      type: 'speaker_rename',
      speakerId,
      fromName,
      toName,
      tenantId: req.user.tenantId,
    });
    res.json(correction);
  } catch (error) {
    logger.error(
      '[POST /api/transcript-corrections/:transcriptFileId/speaker-rename] Failed',
      error,
    );
    res.status(500).json({ error: 'Failed to rename speaker' });
  }
});

/** Reassigns one misattributed line to a different (existing or brand-new)
 *  speaker id. Only this one line moves - every other line's attribution is
 *  untouched. */
router.post('/:transcriptFileId/segment-reassign', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId, lineIndex, fromSpeakerId, toSpeakerId } = req.body;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    if (lineIndex == null || !toSpeakerId) {
      return res.status(400).json({ error: 'lineIndex and toSpeakerId are required' });
    }
    const correction = await recordCorrectionAndReembed(req, transcriptFileId, conversationId, {
      transcriptFileId,
      conversationId,
      user: req.user.id,
      type: 'segment_reassign',
      lineIndex,
      fromSpeakerId,
      toSpeakerId,
      tenantId: req.user.tenantId,
    });
    res.json(correction);
  } catch (error) {
    logger.error(
      '[POST /api/transcript-corrections/:transcriptFileId/segment-reassign] Failed',
      error,
    );
    res.status(500).json({ error: 'Failed to reassign segment' });
  }
});

/** Edits one line's transcribed text - only this line's text changes; its
 *  timestamp and speaker attribution are untouched. Like every correction
 *  here, this doesn't overwrite the original pipeline output - it's an event
 *  the client replays on top of it, so what WhisperX actually produced stays
 *  recoverable underneath any edit. */
router.post('/:transcriptFileId/text-edit', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId, lineIndex, fromText, toText } = req.body;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    if (lineIndex == null || toText == null) {
      return res.status(400).json({ error: 'lineIndex and toText are required' });
    }
    const correction = await recordCorrectionAndReembed(req, transcriptFileId, conversationId, {
      transcriptFileId,
      conversationId,
      user: req.user.id,
      type: 'text_edit',
      lineIndex,
      fromText,
      toText,
      tenantId: req.user.tenantId,
    });
    res.json(correction);
  } catch (error) {
    logger.error('[POST /api/transcript-corrections/:transcriptFileId/text-edit] Failed', error);
    res.status(500).json({ error: 'Failed to edit transcript text' });
  }
});

/** Corrects one line's start/end time - the pipeline's automatic alignment can
 *  drift or land on the wrong stretch of audio entirely (most often when a
 *  word or two went unrecognized nearby), and there's no way to fix that
 *  short of the reviewer setting it by hand. Only this line's timing changes;
 *  its text and speaker attribution are untouched. */
router.post('/:transcriptFileId/time-edit', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId, lineIndex, fromSeconds, fromEndSeconds, seconds, endSeconds } = req.body;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    if (lineIndex == null || seconds == null || endSeconds == null) {
      return res.status(400).json({ error: 'lineIndex, seconds, and endSeconds are required' });
    }
    if (typeof seconds !== 'number' || typeof endSeconds !== 'number' || endSeconds <= seconds) {
      return res.status(400).json({ error: 'endSeconds must be greater than seconds' });
    }
    const correction = await recordCorrectionAndReembed(req, transcriptFileId, conversationId, {
      transcriptFileId,
      conversationId,
      user: req.user.id,
      type: 'time_edit',
      lineIndex,
      fromSeconds,
      fromEndSeconds,
      seconds,
      endSeconds,
      tenantId: req.user.tenantId,
    });
    res.json(correction);
  } catch (error) {
    logger.error('[POST /api/transcript-corrections/:transcriptFileId/time-edit] Failed', error);
    res.status(500).json({ error: 'Failed to edit transcript time' });
  }
});

/** Inserts a line the pipeline missed entirely - a dialogue exchange that never
 *  made it into the transcript at all, not a misattribution or a typo. `lineIndex`
 *  is a synthetic value the client computes strictly between its two neighbors
 *  (e.g. 4.5 between lines 4 and 5), so it sorts into the right place without
 *  renumbering any existing line's identity - every other correction keeps
 *  targeting the same `lineIndex` it always has. `seconds`/`endSeconds` are
 *  likewise the client's responsibility: it knows the neighboring lines' real
 *  timestamps, this route doesn't. */
router.post('/:transcriptFileId/line-insert', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId, lineIndex, speaker, text, seconds, endSeconds } = req.body;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    if (lineIndex == null || !text || seconds == null || endSeconds == null) {
      return res
        .status(400)
        .json({ error: 'lineIndex, text, seconds, and endSeconds are required' });
    }
    const correction = await recordCorrectionAndReembed(req, transcriptFileId, conversationId, {
      transcriptFileId,
      conversationId,
      user: req.user.id,
      type: 'line_insert',
      lineIndex,
      speaker,
      text,
      seconds,
      endSeconds,
      tenantId: req.user.tenantId,
    });
    res.json(correction);
  } catch (error) {
    logger.error('[POST /api/transcript-corrections/:transcriptFileId/line-insert] Failed', error);
    res.status(500).json({ error: 'Failed to insert transcript line' });
  }
});

/**
 * Removes a line from the transcript, and hands its time range to a
 * neighboring line so the underlying audio stays reachable from the panel.
 *
 * Both writes happen here rather than as two client calls: the neighbor
 * depends on every correction already applied (which this side has anyway to
 * re-embed), and a delete that landed without its reabsorption would leave a
 * stretch of recording covered by no box at all.
 *
 * Only the deletion triggers a re-embed. The `time_edit` that accompanies it
 * changes no words, and `recordCorrectionAndReembed` would otherwise queue a
 * second full re-index of the same transcript for nothing.
 */
router.post('/:transcriptFileId/line-delete', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId, lineIndex } = req.body;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    if (lineIndex == null) {
      return res.status(400).json({ error: 'lineIndex is required' });
    }
    const baseFile = await db.findFileById(transcriptFileId);
    if (!baseFile) {
      return res.status(404).json({ error: 'Transcript file not found' });
    }
    const existing = await db.getTranscriptCorrections(transcriptFileId);
    const plan = planLineDeletion(
      applyTranscriptCorrectionsStructured(baseFile.text ?? '', existing),
      lineIndex,
    );
    if (!plan) {
      return res.status(404).json({ error: 'Transcript line not found' });
    }

    if (plan.timeEdit) {
      await db.createTranscriptCorrection({
        transcriptFileId,
        conversationId,
        user: req.user.id,
        type: 'time_edit',
        ...plan.timeEdit,
        tenantId: req.user.tenantId,
      });
    }
    const correction = await recordCorrectionAndReembed(req, transcriptFileId, conversationId, {
      transcriptFileId,
      conversationId,
      user: req.user.id,
      type: 'line_delete',
      ...plan.deleted,
      tenantId: req.user.tenantId,
    });
    res.json(correction);
  } catch (error) {
    logger.error('[POST /api/transcript-corrections/:transcriptFileId/line-delete] Failed', error);
    res.status(500).json({ error: 'Failed to delete transcript line' });
  }
});

function toIndexStatusPayload(file) {
  return {
    transcriptVersion: file?.transcriptVersion ?? 0,
    indexVersion: file?.indexVersion ?? null,
    indexStatus: file?.indexStatus ?? 'not_indexed',
  };
}

/** Current index status for a transcript - lets a client (or a developer)
 *  check whether `file_search` has caught up to the latest correction
 *  instead of guessing from the outside. */
router.get('/:transcriptFileId/index-status', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId } = req.query;
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    const file = await db.findFileById(transcriptFileId);
    if (!file) {
      return res.status(404).json({ error: 'Transcript file not found' });
    }
    res.json(toIndexStatusPayload(file));
  } catch (error) {
    logger.error('[GET /api/transcript-corrections/:transcriptFileId/index-status] Failed', error);
    res.status(500).json({ error: 'Failed to load index status' });
  }
});

/**
 * Manually retries indexing - for when it's `index_failed` or has been
 * `stale` for longer than a correction's own automatic re-embed should take.
 * Goes through the same per-transcript queue as every correction-triggered
 * re-embed (`reembedCorrectedTranscript`), so it can never race one.
 */
router.post('/:transcriptFileId/reindex', async (req, res) => {
  const { transcriptFileId } = req.params;
  const { conversationId } = req.body ?? {};
  try {
    if (!(await assertOwnsConversation(req, res, conversationId))) {
      return;
    }
    await reembedCorrectedTranscript(req, transcriptFileId, conversationId);
    const file = await db.findFileById(transcriptFileId);
    if (!file) {
      return res.status(404).json({ error: 'Transcript file not found' });
    }
    res.json(toIndexStatusPayload(file));
  } catch (error) {
    logger.error('[POST /api/transcript-corrections/:transcriptFileId/reindex] Failed', error);
    res.status(500).json({ error: 'Failed to reindex transcript' });
  }
});

module.exports = router;
