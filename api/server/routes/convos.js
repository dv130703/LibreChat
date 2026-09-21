const multer = require('multer');
const express = require('express');
const { sleep } = require('@librechat/agents');
const {
  isEnabled,
  deleteAgentCheckpoints,
  resolveImportMaxFileSize,
  restoreTenantContextFromReq,
  deleteAllSharedLinksWithCleanup,
  deleteConvoSharedLinksWithCleanup,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys, FileContext, EModelEndpoint } = require('librechat-data-provider');
const {
  createImportLimiters,
  validateConvoAccess,
  createForkLimiters,
  configMiddleware,
} = require('~/server/middleware');
const { processDeleteRequest } = require('~/server/services/Files/process');
const { requestCancel } = require('~/server/services/Transcription/jobQueue');
const { forkConversation, duplicateConversation } = require('~/server/utils/import/fork');
const { storage, importFileFilter } = require('~/server/routes/files/multer');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { importConversations } = require('~/server/utils/import');
const getLogStores = require('~/cache/getLogStores');
const db = require('~/models');

/**
 * Deletes the per-conversation RAG transcript files (see the Audio Transcriber
 * feature, `api/server/routes/transcribe.js`) for the given conversations, so
 * they never survive their conversation and
 * never show up in any general file listing. Scoped strictly by
 * `context: FileContext.transcript_rag` - deliberately NOT a bare
 * `conversationId` match, which would also catch the user's own regular
 * `file_search` documents that happen to carry the same conversationId.
 * Best-effort: never blocks conversation deletion on cleanup failure.
 *
 * @param {ServerRequest} req
 * @param {string[]} conversationIds
 */
async function cleanupTranscriptFiles(req, conversationIds) {
  if (!conversationIds?.length) {
    return;
  }
  try {
    const files = await db.getFiles({
      conversationId: { $in: conversationIds },
      context: FileContext.transcript_rag,
    });
    if (files?.length) {
      await processDeleteRequest({ req, files });
    }
  } catch (error) {
    logger.error('[cleanupTranscriptFiles] Failed to clean up transcript RAG files', error);
  }
}

/**
 * Deletes `execute_code`-context files (Code Interpreter output) for the
 * given conversations.
 *
 * Neither `deleteConvos` nor `deleteMessages` (the two collections this
 * cascade otherwise touches) ever reference the `File` collection — verified
 * by reading both, not assumed — so without this, every code-interpreter
 * file outlives its conversation forever: no Mongo `File` doc removed, no
 * on-disk/storage-strategy bytes reclaimed. `expiredAt`-based retention
 * (`getRetentionExpiry`) is a separate, opt-in policy (temp chats /
 * enterprise retention) — most deployments never set it, so it does not
 * substitute for this. Best-effort, mirrors `cleanupTranscriptFiles`: never
 * blocks conversation deletion on cleanup failure.
 *
 * @param {ServerRequest} req
 * @param {string[]} conversationIds
 */
async function cleanupExecuteCodeFiles(req, conversationIds) {
  if (!conversationIds?.length) {
    return;
  }
  try {
    const files = await db.getFiles({
      conversationId: { $in: conversationIds },
      context: FileContext.execute_code,
    });
    if (files?.length) {
      await processDeleteRequest({ req, files });
    }
  } catch (error) {
    logger.error('[cleanupExecuteCodeFiles] Failed to clean up execute_code files', error);
  }
}

/**
 * Cancels any transcription job still `queued`/`transcribing` for the
 * conversations about to be deleted. Without this, deleting a conversation
 * mid-transcription left the job running to completion (or timeout) with
 * nothing left to write its result to - on a long recording that can hold
 * the single-slot job queue (`jobQueue.js`'s one-in-flight cap) busy for
 * many more minutes on a conversation that no longer exists. Same terminal
 * state the manual `POST /:sourceFileId/cancel` route writes
 * (`transcription.status: 'failed'`, `cancelledAt` set), so status polling
 * and `/retry` treat it identically either way. Best-effort, mirrors
 * `cleanupTranscriptFiles`: never blocks conversation deletion on failure.
 *
 * @param {ServerRequest} req
 * @param {string[]} conversationIds
 */
async function cancelInProgressTranscriptions(req, conversationIds) {
  if (!conversationIds?.length) {
    return;
  }
  try {
    const sourceFiles = await db.getFiles({
      conversationId: { $in: conversationIds },
      'transcription.status': { $in: ['queued', 'transcribing'] },
    });
    for (const sourceFile of sourceFiles ?? []) {
      await db.updateFile({
        file_id: sourceFile.file_id,
        'transcription.status': 'failed',
        'transcription.error': 'Cancelled: conversation deleted',
        'transcription.cancelledAt': new Date(),
        'transcription.completedAt': new Date(),
      });
      requestCancel(sourceFile.file_id);
    }
  } catch (error) {
    logger.error(
      '[cancelInProgressTranscriptions] Failed to cancel in-progress transcriptions',
      error,
    );
  }
}

/**
 * The one place every delete-conversation route routes its transcript
 * cleanup through, so a future route can't add a third path that forgets
 * one of the steps below - see `transcription/ARCHITECTURE.md` §5.4/I4.
 * There is currently only one other route to keep in sync (`DELETE /all`);
 * this exists so that stays true rather than becoming an assumption nobody
 * checks.
 *
 * @param {ServerRequest} req
 * @param {string[]} conversationIds
 */
async function deleteConversationCascade(req, conversationIds) {
  await cancelInProgressTranscriptions(req, conversationIds);
  await cleanupTranscriptFiles(req, conversationIds);
  await cleanupExecuteCodeFiles(req, conversationIds);
  await db.deleteTranscriptCorrections(conversationIds);
}

const router = express.Router();
router.use(requireJwtAuth);

const isValidProjectFilter = (projectId) =>
  !projectId || projectId === 'unassigned' || /^[a-f\d]{24}$/i.test(projectId);

router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 25;
  const cursor = req.query.cursor;
  const isArchived = isEnabled(req.query.isArchived);
  const search = req.query.search ? decodeURIComponent(req.query.search) : undefined;
  const sortBy = req.query.sortBy || 'updatedAt';
  const sortDirection = req.query.sortDirection || 'desc';
  const projectId = Array.isArray(req.query.projectId)
    ? req.query.projectId[0]
    : req.query.projectId;

  if (!isValidProjectFilter(projectId)) {
    return res.status(400).json({ error: 'projectId must be a valid project id or unassigned' });
  }

  let tags;
  if (req.query.tags) {
    tags = Array.isArray(req.query.tags) ? req.query.tags : [req.query.tags];
  }

  try {
    const result = await db.getConvosByCursor(req.user.id, {
      cursor,
      limit,
      isArchived,
      tags,
      search,
      sortBy,
      sortDirection,
      projectId,
    });
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error fetching conversations', error);
    res.status(500).json({ error: 'Error fetching conversations' });
  }
});

router.get('/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const convo = await db.getConvo(req.user.id, conversationId);

  if (convo) {
    res.status(200).json(convo);
  } else {
    res.status(404).end();
  }
});

router.get('/gen_title/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${conversationId}`;
  let title = await titleCache.get(key);

  if (!title) {
    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s (total ~15.5s max wait)
    const delays = [500, 1000, 2000, 4000, 8000];
    for (const delay of delays) {
      await sleep(delay);
      title = await titleCache.get(key);
      if (title) {
        break;
      }
    }
  }

  if (title) {
    await titleCache.delete(key);
    res.status(200).json({ title });
  } else {
    res.status(404).json({
      message: "Title not found or method not implemented for the conversation's endpoint",
    });
  }
});

router.delete('/', configMiddleware, async (req, res) => {
  let filter = {};
  const { conversationId, source, thread_id, endpoint } = req.body?.arg ?? {};

  // Prevent deletion of all conversations
  if (!conversationId && !source && !thread_id && !endpoint) {
    return res.status(400).json({
      error: 'no parameters provided',
    });
  }

  if (conversationId) {
    filter = { conversationId };
  } else if (source === 'button') {
    return res.status(200).send('No conversationId provided');
  }

  try {
    const dbResponse = await db.deleteConvos(req.user.id, filter);
    // HITL: prune the deleted conversations' durable checkpoints — a paused run's
    // checkpoint would otherwise persist until the Mongo TTL. Never throws, and
    // doesn't depend on (or get depended on by) the tool-call/shared-link cleanup
    // below, so it runs concurrently with it instead of blocking before it.
    const checkpointsCleanup = deleteAgentCheckpoints(
      dbResponse.conversationIds,
      req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
    );
    if (filter.conversationId) {
      await db.deleteToolCalls(req.user.id, filter.conversationId);
      await deleteConvoSharedLinksWithCleanup(req.user.id, filter.conversationId);
    }
    await checkpointsCleanup;
    await deleteConversationCascade(req, dbResponse.conversationIds);
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

router.delete('/all', configMiddleware, async (req, res) => {
  try {
    const dbResponse = await db.deleteConvos(req.user.id, {});
    // HITL: prune ALL the deleted conversations' durable checkpoints in one bulk
    // pass. Never throws, and is independent of the tool-call/shared-link
    // cleanup below, so it runs concurrently with it instead of blocking before it.
    const checkpointsCleanup = deleteAgentCheckpoints(
      dbResponse.conversationIds,
      req.config?.endpoints?.[EModelEndpoint.agents]?.checkpointer,
    );
    await db.deleteToolCalls(req.user.id);
    await deleteAllSharedLinksWithCleanup(req.user.id);
    await checkpointsCleanup;
    await deleteConversationCascade(req, dbResponse.conversationIds);
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error clearing conversations', error);
    res.status(500).send('Error clearing conversations');
  }
});

/**
 * Archives or unarchives a conversation.
 * @route POST /archive
 * @param {string} req.body.arg.conversationId - The conversation ID to archive/unarchive.
 * @param {boolean} req.body.arg.isArchived - Whether to archive (true) or unarchive (false).
 * @returns {object} 200 - The updated conversation object.
 */
router.post('/archive', validateConvoAccess, async (req, res) => {
  const { conversationId, isArchived } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (typeof isArchived !== 'boolean') {
    return res.status(400).json({ error: 'isArchived must be a boolean' });
  }

  try {
    const dbResponse = await db.saveConvo(
      {
        userId: req?.user?.id,
        isTemporary: req?.body?.isTemporary,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      { conversationId, isArchived },
      { context: `POST /api/convos/archive ${conversationId}` },
    );
    res.status(200).json(dbResponse);
  } catch (error) {
    logger.error('Error archiving conversation', error);
    res.status(500).send('Error archiving conversation');
  }
});

router.post('/pin', validateConvoAccess, async (req, res) => {
  const { conversationId, pinned } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (pinned === undefined) {
    return res.status(400).json({ error: 'pinned is required' });
  }

  if (typeof pinned !== 'boolean') {
    return res.status(400).json({ error: 'pinned must be a boolean' });
  }

  try {
    const dbResponse = await db.saveConvo(
      { userId: req.user.id },
      { conversationId, pinned },
      { context: `POST /api/convos/pin ${conversationId}` },
    );
    res.status(200).json(dbResponse);
  } catch (error) {
    logger.error('Error pinning conversation', error);
    res.status(500).send('Error pinning conversation');
  }
});

/** Maximum allowed length for conversation titles */
const MAX_CONVO_TITLE_LENGTH = 1024;

/**
 * Updates a conversation's title.
 * @route POST /update
 * @param {string} req.body.arg.conversationId - The conversation ID to update.
 * @param {string} req.body.arg.title - The new title for the conversation.
 * @returns {object} 201 - The updated conversation object.
 */
router.post('/update', validateConvoAccess, async (req, res) => {
  const { conversationId, title } = req.body?.arg ?? {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  if (title === undefined) {
    return res.status(400).json({ error: 'title is required' });
  }

  if (typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }

  const sanitizedTitle = title.trim().slice(0, MAX_CONVO_TITLE_LENGTH);

  try {
    const dbResponse = await db.saveConvo(
      {
        userId: req?.user?.id,
        isTemporary: req?.body?.isTemporary,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      { conversationId, title: sanitizedTitle },
      { context: `POST /api/convos/update ${conversationId}` },
    );
    res.status(201).json(dbResponse);
  } catch (error) {
    logger.error('Error updating conversation', error);
    res.status(500).send('Error updating conversation');
  }
});

const { importIpLimiter, importUserLimiter } = createImportLimiters();
/** Fork and duplicate share one rate-limit budget (same "clone" operation class) */
const { forkIpLimiter, forkUserLimiter } = createForkLimiters();
const importMaxFileSize = resolveImportMaxFileSize();
const upload = multer({
  storage,
  fileFilter: importFileFilter,
  limits: { fileSize: importMaxFileSize },
});
const uploadSingle = upload.single('file');

function handleUpload(req, res, next) {
  uploadSingle(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File exceeds the maximum allowed size' });
    }
    if (err) {
      return next(err);
    }
    next();
  });
}

/**
 * Imports a conversation from a JSON file and saves it to the database.
 * @route POST /import
 * @param {Express.Multer.File} req.file - The JSON file to import.
 * @returns {object} 201 - success response - application/json
 */
router.post(
  '/import',
  importIpLimiter,
  importUserLimiter,
  configMiddleware,
  handleUpload,
  restoreTenantContextFromReq,
  async (req, res) => {
    try {
      /* TODO: optimize to return imported conversations and add manually */
      await importConversations({
        filepath: req.file.path,
        requestUserId: req.user.id,
        userRole: req.user.role,
        interfaceConfig: req.config?.interfaceConfig,
      });
      res.status(201).json({ message: 'Conversation(s) imported successfully' });
    } catch (error) {
      logger.error('Error processing file', error);
      res.status(500).send('Error processing file');
    }
  },
);

/**
 * POST /fork
 * This route handles forking a conversation based on the TForkConvoRequest and responds with TForkConvoResponse.
 * @route POST /fork
 * @param {express.Request<{}, TForkConvoResponse, TForkConvoRequest>} req - Express request object.
 * @param {express.Response<TForkConvoResponse>} res - Express response object.
 * @returns {Promise<void>} - The response after forking the conversation.
 */
router.post('/fork', forkIpLimiter, forkUserLimiter, async (req, res) => {
  try {
    /** @type {TForkConvoRequest} */
    const { conversationId, messageId, option, splitAtTarget, latestMessageId } = req.body;
    const result = await forkConversation({
      requestUserId: req.user.id,
      originalConvoId: conversationId,
      targetMessageId: messageId,
      latestMessageId,
      records: true,
      splitAtTarget,
      option,
    });

    res.json(result);
  } catch (error) {
    logger.error('Error forking conversation:', error);
    res.status(500).send('Error forking conversation');
  }
});

router.post('/duplicate', forkIpLimiter, forkUserLimiter, async (req, res) => {
  const { conversationId, title } = req.body;

  try {
    const result = await duplicateConversation({
      userId: req.user.id,
      conversationId,
      title,
    });
    res.status(201).json(result);
  } catch (error) {
    logger.error('Error duplicating conversation:', error);
    res.status(500).send('Error duplicating conversation');
  }
});

module.exports = router;
