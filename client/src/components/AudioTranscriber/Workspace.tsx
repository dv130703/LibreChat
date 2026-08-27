import { useEffect, useState } from 'react';
import { useSetRecoilState } from 'recoil';
import {
  ResizableHandleAlt,
  ResizablePanel,
  ResizablePanelGroup,
  useMediaQuery,
} from '@librechat/client';
import ChatRoute from '~/routes/ChatRoute';
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
