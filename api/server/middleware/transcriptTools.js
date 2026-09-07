const { logger } = require('@librechat/data-schemas');
const { deriveTranscriptToolState, applyTranscriptToolState } = require('@librechat/api');
const db = require('~/models');

/**
 * Decides, server-side, whether this turn's conversation has a searchable
 * transcript - and equips `file_search` when it does.
 *
 * Runs after `validateConvoAccess` (ownership already established) and
 * before `buildEndpointOption`, which is the last point at which
 * `req.body.ephemeralAgent` is still writable and the first at which both
 * the conversation id and the user are known. Both ephemeral agent loaders
 * (`loadEphemeralAgent` and `loadAddedAgent`) read that same field, so this
 * single place covers both.
 *
 * Deliberately never blocks the turn: a failure to read transcript state is
 * a degraded answer, not a failed request, so it logs and continues with
 * whatever the client sent.
 *
 * Scope note: this does not add `file_search` to a *persisted* agent. That
 * agent's tool list is its owner's explicit configuration, and silently
 * expanding it is a policy decision this middleware has no standing to make.
 */
const attachTranscriptToolState = async (req, res, next) => {
  const conversationId = req.body?.conversationId;
  if (!conversationId || conversationId === 'new') {
    return next();
  }

  try {
    const transcripts = await db.getConversationTranscripts(conversationId, {
      userId: req.user.id,
      tenantId: req.user.tenantId,
    });
    const state = deriveTranscriptToolState(transcripts);
    if (!state.hasQueryableTranscript && state.unavailable.length === 0) {
      return next();
    }
    // Read back by `handleTools` when it builds the `file_search` tool, so
    // the "exists but cannot be searched" note costs no second query.
    req.transcriptToolState = state;
    req.body.ephemeralAgent = applyTranscriptToolState(req.body.ephemeralAgent, state);
  } catch (error) {
    logger.error('[attachTranscriptToolState] Failed to resolve transcript state', error);
  }
  return next();
};

module.exports = attachTranscriptToolState;
