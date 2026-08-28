import { useRef, useEffect, useState } from 'react';
import { useSetRecoilState } from 'recoil';
import {
  ResizableHandleAlt,
  ResizablePanel,
  ResizablePanelGroup,
  useMediaQuery,
} from '@librechat/client';
import ChatRoute from '~/routes/ChatRoute';
import { useSetConvoContext } from '~/Providers';
import { useUpdateEphemeralAgent, isAudioTranscriberConvo } from '~/store';
import TranscriptPanel from './TranscriptPanel';

/** Fixed-pixel floors so neither pane can be dragged down to an unusable
 * width; the transcript pane also caps out at 70% so the chat pane always
 * keeps a majority share of the screen. */
const MIN_PANE_WIDTH = '320px';
const TRANSCRIPT_MAX_WIDTH = '70%';

/**
 * Two-pane layout: the real, unmodified chat page on the left (reused wholesale
 * rather than hand-rolled - the conversation is a genuine, already-persisted
 * conversation by the time this renders, so `ChatRoute`'s normal bootstrap
 * fetches and initializes it exactly like reopening any past chat), and the
 * transcript + audio player on the right.
 *
 * Picking a different model/agent from the chat's own header will navigate
 * away to the plain `/c/:conversationId` view for this conversation - accepted
 * tradeoff, not a bug: `ephemeralAgentByConvoId` survives the in-SPA route
 * change, so `file_search` stays forced on regardless.
 */
export default function Workspace({ conversationId }: { conversationId: string }) {
  const updateEphemeralAgent = useUpdateEphemeralAgent();
  const setIsAudioTranscriberConvo = useSetRecoilState(isAudioTranscriberConvo(conversationId));

  /* `hasSetConversation` is one ref, held by `SetConvoProvider` at the app root.
   * `ChatRoute` sets it true the first time it hydrates anything and nothing
   * ever sets it back. The normal way into a conversation doesn't care:
   * `useNavigateToConvo` (the sidebar) writes the conversation into the atom
   * itself and only marks the flag afterwards. This route can't do that - it
   * arrives holding an id and nothing else, and depends on `ChatRoute`'s own
   * first-load fetch to hydrate from it. With the flag left standing from any
   * earlier chat in the session, that fetch is disabled and the hydration
   * effect early-returns, so the chat pane quietly keeps the previous
   * conversation - usually the empty `new` draft - while the URL and the
   * transcript beside it show this one. The next message then posts under
   * `new`, the server mints a different conversation for it, and the user lands
   * in a fresh chat with no transcript attached and no `file_search`: the
   * transcript is right there on screen and the assistant says it has never
   * seen it.
   *
   * Cleared during render rather than in an effect. Children's effects run
   * before the parent's, so an effect here would fire after `ChatRoute` had
   * already decided to skip hydration - and writing a ref wouldn't re-render it
   * to reconsider. */
  const hasSetConversation = useSetConvoContext();
  const hydratedFor = useRef<string | null>(null);
  if (hydratedFor.current !== conversationId) {
    hydratedFor.current = conversationId;
    hasSetConversation.current = false;
  }
  const isSmallScreen = useMediaQuery('(max-width: 767px)');

  /* The audio player portals into this node (see `TranscriptPanel`/
   * `TranscriptHeader`) instead of living inside the scrollable transcript
   * pane - a real DOM node, not just a different CSS region, so that
   * scrolling/playback-driven re-renders inside the pane never have to touch
   * it. It sits inside the chat pane itself (above `ChatRoute`), so its width
   * tracks that pane's resizable width instead of the transcript pane's - the
   * player should stop at the same edge the chat does, not stretch across
   * into the transcript column.
   *
   * A ref alone wouldn't work here: it doesn't trigger a re-render when
   * attached, so `TranscriptPanel`'s first render would see it as still
   * null. */
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    // Recoil state doesn't survive a reload, so this re-runs every mount -
    // forcing file_search back on is what lets the model retrieve the
    // RAG-embedded transcript starting on the very next message.
    updateEphemeralAgent(conversationId, { file_search: true });
    setIsAudioTranscriberConvo(true);
  }, [conversationId, updateEphemeralAgent, setIsAudioTranscriberConvo]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize="50" minSize={MIN_PANE_WIDTH} id="chat-view">
        <div className="flex h-full flex-col">
          <div ref={setHeaderEl} className="flex-shrink-0" />
          <div className="min-h-0 flex-1">
            <ChatRoute />
          </div>
        </div>
      </ResizablePanel>
      {!isSmallScreen && (
        <>
          <ResizableHandleAlt className="bg-border-medium" />
          <ResizablePanel
            defaultSize="50"
            minSize={MIN_PANE_WIDTH}
            maxSize={TRANSCRIPT_MAX_WIDTH}
            id="transcript-panel"
            className="border-l border-border-medium"
          >
            <TranscriptPanel conversationId={conversationId} headerContainer={headerEl} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
