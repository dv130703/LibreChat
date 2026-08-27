import { useEffect, useMemo } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { useNavigate, useLocation } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import { useGetConvoIdQuery } from '~/data-provider';
import { isAudioTranscriberConvo, useUpdateEphemeralAgent } from '~/store';
import { splitFileIds } from './fileIds';

const CHAT_ROUTE_PATTERN = /^\/c\/([^/]+)$/;

/**
 * Mounted once at the app root so it survives the route swap it exists to correct:
 * `ChatRoute`'s own hydration effect calls `newConversation()` for any conversation
 * it loads, which unconditionally navigates to `/c/:conversationId` - harmless on
 * that route itself, but it hijacks the URL away from
 * `/audio-transcriber/:conversationId` when `ChatRoute` is reused there (in
 * `Workspace`), since the two are sibling routes and the navigate unmounts the
 * whole audio-transcriber subtree. Snaps back immediately when that happens.
 *
 * Also the only thing that can get a *returning* visitor there at all. The
 * `isAudioTranscriberConvo` flag itself is only ever set to `true` from inside
 * `Workspace` - which only mounts on this same route. Landing on `/c/:id`
 * fresh (a sidebar link, a reopened tab, a hard reload) with nothing having
 * set the flag yet would otherwise never redirect, no matter how many times
 * the conversation was opened before: this component would just sit there
 * checking a flag nothing had a chance to set. So this derives the same
 * answer independently, straight from the conversation's own persisted file
 * list (the one thing that DOES survive a reload) - which both breaks that
 * cycle and back-fills the flag for every other place that reads it
 * (`Header`, `ChatForm`, `MessagesView`, ...), not just this redirect.
 *
 * `Workspace`'s mount effect also force-enables `file_search` on the
 * conversation's ephemeral agent - the same "only set by the component that
 * requires it to already be set" shape as the flag above, one layer deeper.
 * Fixing only the redirect left a real gap: a returning visitor whose chat
 * history/messages happen to load before this component's own query
 * resolves could send a message from the plain `/c/:id` view - before
 * `Workspace` ever mounts - with `file_search` still off, silently losing
 * RAG retrieval for that one turn. So this sets both facts about the
 * conversation at the same time, from the same persisted-data check,
 * instead of leaving one of the two solely on `Workspace`.
 */
export default function AudioTranscriberRedirectGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useAuthContext();
  const updateEphemeralAgent = useUpdateEphemeralAgent();
  const match = CHAT_ROUTE_PATTERN.exec(location.pathname);
  const conversationId = match?.[1] ?? '';

  const alreadyFlagged = useRecoilValue(isAudioTranscriberConvo(conversationId));
  const setFlagged = useSetRecoilState(isAudioTranscriberConvo(conversationId));

  // Only needs to resolve once per conversation - once `alreadyFlagged` is
  // true (either from here or from `Workspace`), this stops asking again.
  // `NEW_CONVO` is excluded the same way `ChatRoute` excludes it: there's no
  // conversation to fetch yet, and every fresh "new chat" in the whole app
  // passes through here, not just this feature's own.
  const { data: conversation } = useGetConvoIdQuery(conversationId, {
    enabled:
      conversationId !== '' &&
      conversationId !== Constants.NEW_CONVO &&
      isAuthenticated &&
      !alreadyFlagged,
  });

  const hasTranscriptFile = useMemo(
    () =>
      splitFileIds((conversation as { files?: string[] } | undefined)?.files ?? [])
        .transcriptFileId != null,
    [conversation],
  );

  useEffect(() => {
    if (conversationId !== '' && hasTranscriptFile && !alreadyFlagged) {
      setFlagged(true);
      // Same fact, set alongside the flag rather than left for `Workspace`
      // to set later - a message sent before `Workspace` mounts must not go
      // out with this still off.
      updateEphemeralAgent(conversationId, { file_search: true });
    }
  }, [conversationId, hasTranscriptFile, alreadyFlagged, setFlagged, updateEphemeralAgent]);

  const belongsToTranscriber = alreadyFlagged || hasTranscriptFile;

  useEffect(() => {
    if (conversationId !== '' && belongsToTranscriber) {
      navigate(`/audio-transcriber/${conversationId}`, { replace: true });
    }
  }, [conversationId, belongsToTranscriber, navigate]);

  return null;
}
