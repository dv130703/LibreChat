import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import { useGetConvoIdQuery } from '~/data-provider';
import { useUpdateEphemeralAgent, useGetEphemeralAgent } from '~/store';
import { splitFileIds } from './fileIds';

const CHAT_ROUTE_PATTERN = /^\/c\/([^/]+)$/;

/**
 * Mounted once at the app root (Phase 5, transcription/ARCHITECTURE.md §9) -
 * the surviving half of the old `AudioTranscriberRedirectGuard`. That
 * component did two independent things bundled together: bounce `/c/:id`
 * back to the now-retired standalone `/audio-transcriber/:id` page, and
 * force `file_search` on for a conversation created by that page so the
 * model can retrieve its RAG-embedded transcript - the returning-visitor
 * case (a reload, a sidebar link, a fresh tab) where nothing has set that
 * yet. Only the second half still applies: `/c/:id` is the canonical place
 * to view a transcript now, so the redirect is gone, but an *existing*
 * transcript conversation from before this phase still needs its
 * `file_search` re-forced on each fresh session (it's ephemeral, not
 * persisted) or it silently loses transcript retrieval - dropping that
 * would regress conversations that already relied on it, not just decline
 * to add it to new ones (composer-created transcript attachments are a
 * separate, deliberate case - see R14).
 */
export default function EnsureTranscriptFileSearch() {
  const location = useLocation();
  const { isAuthenticated } = useAuthContext();
  const updateEphemeralAgent = useUpdateEphemeralAgent();
  const getEphemeralAgent = useGetEphemeralAgent();
  const match = CHAT_ROUTE_PATTERN.exec(location.pathname);
  const conversationId = match?.[1] ?? '';

  const { data: conversation } = useGetConvoIdQuery(conversationId, {
    enabled: conversationId !== '' && conversationId !== Constants.NEW_CONVO && isAuthenticated,
  });

  const hasTranscriptFile = useMemo(
    () =>
      splitFileIds((conversation as { files?: string[] } | undefined)?.files ?? [])
        .transcriptFileId != null,
    [conversation],
  );

  useEffect(() => {
    if (conversationId === '' || !hasTranscriptFile) {
      return;
    }
    // Merges rather than replaces: `updateEphemeralAgent` writes the whole
    // atom, not just the key given to it - passing only `{ file_search: true }`
    // would silently clear any other ephemeral tool (e.g. `execute_code`)
    // already active for this conversation, an unrelated regression that has
    // nothing to do with this component's own job of turning file_search on.
    const current = getEphemeralAgent(conversationId);
    if (current?.file_search === true) {
      return;
    }
    updateEphemeralAgent(conversationId, { ...current, file_search: true });
  }, [conversationId, hasTranscriptFile, updateEphemeralAgent, getEphemeralAgent]);

  return null;
}
