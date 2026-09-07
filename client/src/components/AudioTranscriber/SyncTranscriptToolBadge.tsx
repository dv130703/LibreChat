import { useEffect, useMemo } from 'react';
import { Tools } from 'librechat-data-provider';
import { useConversationTranscriptsQuery } from '~/data-provider';
import { useUpdateEphemeralAgent, useGetEphemeralAgent } from '~/store';

/**
 * Keeps the composer's File Search badge showing what the server is actually
 * doing, for a conversation that has a searchable transcript.
 *
 * Retrieval itself is NOT driven from here. `attachTranscriptToolState`
 * enables `file_search` server-side for every generation on such a
 * conversation, from the read model, whatever the client sends - so RAG is
 * automatic with or without this component. What this fixes is the
 * disagreement that leaves behind: the badge rendered *off* while retrieval
 * was running, which reads as "I have to switch this on myself" for something
 * the user should never have to think about.
 *
 * Deliberately not the old `EnsureTranscriptFileSearch`, which this replaces.
 * That component was load-bearing - retrieval only worked if it had managed to
 * notice a `-transcript` id in the client's cached conversation document,
 * which had no refetch on job completion unless the transcript panel happened
 * to be mounted. This one is cosmetic by construction: if it never runs,
 * nothing breaks.
 */
export default function SyncTranscriptToolBadge({ conversationId }: { conversationId: string }) {
  const updateEphemeralAgent = useUpdateEphemeralAgent();
  const getEphemeralAgent = useGetEphemeralAgent();
  const { data } = useConversationTranscriptsQuery(conversationId);

  const hasQueryableTranscript = useMemo(
    () => (data?.transcripts ?? []).some((entry) => entry.isQueryable),
    [data],
  );

  useEffect(() => {
    if (conversationId === '' || !hasQueryableTranscript) {
      return;
    }
    // Merges rather than replaces: `updateEphemeralAgent` writes the whole
    // atom, so passing only `{ file_search: true }` would silently clear any
    // other ephemeral tool (execute_code, web_search, an MCP selection) the
    // user has turned on - an unrelated regression with nothing to do with
    // reflecting this one badge.
    const current = getEphemeralAgent(conversationId);
    if (current?.[Tools.file_search] === true) {
      return;
    }
    updateEphemeralAgent(conversationId, { ...current, [Tools.file_search]: true });
  }, [conversationId, hasQueryableTranscript, updateEphemeralAgent, getEphemeralAgent]);

  return null;
}
