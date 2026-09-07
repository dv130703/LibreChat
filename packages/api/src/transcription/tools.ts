import { Tools } from 'librechat-data-provider';
import type { TConversationTranscript, TEphemeralAgent } from 'librechat-data-provider';

/**
 * What this conversation's recordings mean for tool assembly on this turn.
 * Two distinct facts, because they lead to two different behaviors: whether
 * to equip `file_search` at all, and what to tell the model about recordings
 * it will NOT be able to search.
 */
export interface TranscriptToolState {
  /** At least one transcript whose RAG index reflects its current text. */
  hasQueryableTranscript: boolean;
  /** Recordings that exist but cannot be searched right now, so the model
   *  can say something true about them instead of reporting "no files". */
  unavailable: Array<{ displayName: string; reason: string }>;
}

const EMPTY_STATE: TranscriptToolState = { hasQueryableTranscript: false, unavailable: [] };

/**
 * Reduces the conversation's recordings to the two facts tool assembly needs.
 *
 * A recording still mid-job is deliberately NOT reported as unavailable: it
 * is not a fault, the user already sees it processing in the thread, and
 * naming it here would only invite the model to apologize for something that
 * is about to work on its own.
 */
export function deriveTranscriptToolState(
  transcripts: TConversationTranscript[],
): TranscriptToolState {
  if (transcripts.length === 0) {
    return EMPTY_STATE;
  }

  let hasQueryableTranscript = false;
  const unavailable: TranscriptToolState['unavailable'] = [];
  for (const transcript of transcripts) {
    if (transcript.isQueryable) {
      hasQueryableTranscript = true;
      continue;
    }
    if (transcript.unqueryableReason == null || transcript.unqueryableReason === 'in_progress') {
      continue;
    }
    unavailable.push({
      displayName: transcript.displayName,
      reason: transcript.unqueryableReason,
    });
  }

  return { hasQueryableTranscript, unavailable };
}

/**
 * Turns `file_search` on for a turn whose conversation has a searchable
 * transcript, regardless of what the client sent.
 *
 * Retrieval used to depend on the client having set an ephemeral, unpersisted
 * flag, which it could only do after noticing a `-transcript` id in its own
 * cached copy of the conversation - a cache with no refetch on job completion
 * unless one particular component happened to be mounted. A conversation with
 * a perfectly good transcript therefore answered "no files" whenever that
 * component was not. The server knows the answer without asking the client,
 * so it decides.
 *
 * Only ever adds. A user who has explicitly enabled other ephemeral tools
 * keeps them, and nothing here can turn a tool off.
 */
export function applyTranscriptToolState(
  ephemeralAgent: TEphemeralAgent | undefined,
  state: TranscriptToolState,
): TEphemeralAgent | undefined {
  if (!state.hasQueryableTranscript) {
    return ephemeralAgent;
  }
  return { ...(ephemeralAgent ?? {}), [Tools.file_search]: true };
}

const REASON_TEXT: Record<string, string> = {
  job_failed: 'its transcription failed, so no transcript exists',
  index_failed: 'its transcript could not be indexed for search',
  stale_index: 'its transcript has been edited since it was last indexed',
  not_indexed: 'its transcript has not been indexed for search',
};

/**
 * A plain-language note about recordings the model cannot search, appended to
 * the `file_search` tool context.
 *
 * Exists so "there is a recording here but I cannot search it" is a statement
 * the model can make truthfully. Without it the tool reports the same "no
 * files" it reports for a conversation that never had a recording, which
 * reads to the model as an error worth retrying rather than as an answer.
 */
export function buildUnavailableTranscriptNotice(state: TranscriptToolState): string | null {
  if (state.unavailable.length === 0) {
    return null;
  }
  const lines = state.unavailable.map(
    (entry) => `\n\t- ${entry.displayName}: ${REASON_TEXT[entry.reason] ?? 'it is not searchable'}`,
  );
  return (
    `- Note: this conversation has ${state.unavailable.length === 1 ? 'a recording' : 'recordings'}` +
    ` that cannot be searched right now:${lines.join('')}` +
    `\n\tSay so plainly if the user asks about ${state.unavailable.length === 1 ? 'it' : 'them'};` +
    ` do not retry ${Tools.file_search} expecting a different result.`
  );
}
