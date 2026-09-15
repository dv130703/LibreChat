const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { saveConvo } = require('~/models');

/** Broad category a file's MIME `type` belongs to, for a human-readable fallback. */
function describeFileKind(type) {
  if (!type) {
    return 'a file';
  }
  if (type.startsWith('image/')) {
    return 'an image';
  }
  if (type.startsWith('audio/')) {
    return 'an audio file';
  }
  if (type.startsWith('video/')) {
    return 'a video file';
  }
  if (type === 'application/pdf') {
    return 'a PDF document';
  }
  if (type.startsWith('text/')) {
    return 'a text document';
  }
  return 'a file';
}

/**
 * `title` timing runs in parallel with generation and, for the default
 * `immediate` timing, never sees the assistant's response — only the user's
 * raw typed `text`. A message that is only an attachment (drag in a photo or
 * PDF and hit send, no caption) leaves that `text` empty, so the title model
 * gets no signal at all and produces a generic/empty title. This builds a
 * short, concrete stand-in from the attachment metadata already on the
 * request (filenames + MIME type) so the title model has something to
 * summarize, without altering the actual persisted user message text.
 *
 * @param {Array<{filename?: string, type?: string}>} files
 * @returns {string}
 */
function describeAttachmentsForTitle(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return '';
  }

  const named = files.filter((file) => file?.filename);
  if (named.length === 0) {
    return '';
  }

  const MAX_LISTED = 3;
  const listed = named.slice(0, MAX_LISTED).map((file) => file.filename);
  const remainder = named.length - listed.length;
  const fileList =
    remainder > 0 ? `${listed.join(', ')}, and ${remainder} more` : listed.join(', ');

  if (named.length === 1) {
    return `[User shared ${describeFileKind(named[0].type)}: ${fileList}]`;
  }
  return `[User shared ${named.length} files: ${fileList}]`;
}

/**
 * Add title to conversation in a way that avoids memory retention.
 *
 * @param {ServerRequest} req
 * @param {Object} params
 * @param {string} params.text - The user's first message.
 * @param {Array<{filename?: string, type?: string}>} [params.files] - The user's
 *   attachments for this turn (e.g. `req.body.files`, or a resumed message's own
 *   `files`). Used only as a fallback title-generation input when `text` is
 *   empty/whitespace (an attachment sent with no caption) — see
 *   `describeAttachmentsForTitle`.
 * @param {TMessage} [params.response] - The assistant response (legacy/`final` timing only).
 * @param {AgentClient} params.client
 * @param {string} [params.conversationId] - Required for `immediate` timing, where
 *   `response` is not yet available; falls back to `response.conversationId`.
 * @param {boolean} [params.immediate] - When true, the title is generated in parallel
 *   with the response (from the user's first message) and persisted to the conversation
 *   only after `convoReady` resolves (the conversation row must exist for `noUpsert`).
 * @param {Promise<void>} [params.convoReady] - Resolves once the conversation has been
 *   persisted; awaited before saving the title in `immediate` mode.
 * @param {AbortSignal} [params.signal] - When aborted (e.g. the user stops an
 *   immediate-mode generation), cancels the in-flight title model call so a
 *   turn stopped before the title finished does not consume the title model. A
 *   title that already finished generating is still persisted and surfaced.
 * @param {AbortSignal} [params.discardSignal] - When aborted, discards an
 *   already-generated title instead of persisting it. Used only when this stream
 *   is superseded by a newer run (or the turn failed), so a stale title does not
 *   clobber the conversation now owned by the newer run. A plain user Stop does
 *   NOT abort this — its generated title is kept.
 * @param {(params: { conversationId: string, title: string }) => Promise<void>|void} [params.onTitleGenerated]
 *   Called after the title is cached and before persistence waits for the
 *   conversation row. Used by live streams to push the title immediately.
 */
const addTitle = async (
  req,
  {
    text,
    files,
    response,
    client,
    conversationId,
    immediate = false,
    convoReady,
    signal,
    discardSignal,
    onTitleGenerated,
  },
) => {
  const { TITLE_CONVO = true } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO)) {
    return;
  }

  if (client.options.titleConvo === false) {
    return;
  }

  // Skip title generation for temporary conversations
  if (req?.body?.isTemporary) {
    return;
  }

  const convoId = conversationId ?? response?.conversationId;
  if (!convoId) {
    logger.warn('[addTitle] Missing conversationId; skipping title generation');
    return;
  }

  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${convoId}`;
  /** @type {NodeJS.Timeout} */
  let timeoutId;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Title generation timeout')), 90000);
    }).catch((error) => {
      logger.error('Title error:', error);
    });

    let titlePromise;
    let abortController = new AbortController();
    /** Propagate a request abort (Stop) to the title generation so a cancelled
     *  turn does not consume the title model or surface a title. */
    if (signal) {
      if (signal.aborted) {
        abortController.abort();
      } else {
        signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }
    const titleInputText =
      text?.trim() || describeAttachmentsForTitle(files ?? req?.body?.files) || text;

    if (client && typeof client.titleConvo === 'function') {
      titlePromise = Promise.race([
        client
          .titleConvo({
            text: titleInputText,
            abortController,
            immediate,
          })
          .catch((error) => {
            logger.error('Client title error:', error);
          }),
        timeoutPromise,
      ]);
    } else {
      return;
    }

    const title = await titlePromise;
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!title) {
      logger.debug(`[${key}] No title generated`);
      return;
    }

    await titleCache.set(key, title, 120000);

    if (!signal?.aborted && typeof onTitleGenerated === 'function') {
      try {
        await onTitleGenerated({ conversationId: convoId, title });
      } catch (error) {
        logger.error('Error emitting generated title:', error);
      }
    }

    /** In immediate mode the title is generated in parallel with the response,
     *  so the conversation row may not exist yet. `saveConvo` with `noUpsert`
     *  is a silent no-op when the row is missing, which would drop the title
     *  from the database (the cache above still serves the live UI). Wait for
     *  the controller to signal the conversation has been persisted. */
    if (convoReady) {
      await convoReady;
    }

    if (discardSignal?.aborted) {
      // This stream was superseded by a newer run (or the turn failed) after the
      // title had already been generated — discard it so a stale title does not
      // clobber the conversation now owned by the newer run. A plain user Stop is
      // not a discard: its generated title falls through and is persisted below.
      // Only clear the cache if it still holds THIS task's title: a replacement
      // stream shares the `userId-conversationId` key and may have already cached
      // its own (valid) title that we must not remove.
      const cached = await titleCache.get(key);
      if (cached === title) {
        await titleCache.delete(key);
      }
      return;
    }

    await saveConvo(
      {
        userId: req?.user?.id,
        isTemporary: req?.body?.isTemporary,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      {
        conversationId: convoId,
        title,
      },
      { context: 'api/server/services/Endpoints/agents/title.js', noUpsert: true },
    );
  } catch (error) {
    logger.error('Error generating title:', error);
  }
};

module.exports = addTitle;
