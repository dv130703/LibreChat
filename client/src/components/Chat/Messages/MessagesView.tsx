import { memo, useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { CSSTransition } from 'react-transition-group';
import type { TMessage } from 'librechat-data-provider';
import { useScreenshot, useMessageScrolling, useLocalize } from '~/hooks';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';
import { steerOverlayHeightFamily } from '~/store/steer';
import { MessagesViewProvider } from '~/Providers';
import { fontSizeAtom } from '~/store/fontSize';
import PendingTranscriptionMessages from './PendingTranscriptionMessages';
import MultiMessage from './MultiMessage';
import MessageNav from './MessageNav';
import { cn } from '~/utils';
import store from '~/store';

const intersectionThreshold = 0.85;
const visibilityDebounceRate = 150;

/**
 * Owns the messages-end IntersectionObserver and the button visibility state,
 * so scroll-position flips re-render only this component instead of the whole
 * message tree host. Intersection is reported up through `onNearBottomChange`
 * for the resize-follow logic in `useMessageScrolling`.
 */
const ScrollButton = memo(function ScrollButton({
  scrollableRef,
  messagesEndRef,
  scrollHandler,
  onNearBottomChange,
}: {
  scrollableRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  scrollHandler: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  onNearBottomChange: (isNearBottom: boolean) => void;
}) {
  const scrollButtonPreference = useRecoilValue(store.showScrollButton);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const scrollToBottomRef = useRef<HTMLDivElement>(null);
  const timeoutIdRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        onNearBottomChange(entry.isIntersecting);
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = setTimeout(() => {
          setShowScrollButton(!entry.isIntersecting);
        }, visibilityDebounceRate);
      },
      { root: scrollableRef.current, threshold: intersectionThreshold },
    );

    observer.observe(messagesEndRef.current);

    return () => {
      observer.disconnect();
      clearTimeout(timeoutIdRef.current);
    };
  }, [messagesEndRef, scrollableRef, onNearBottomChange]);

  return (
    <CSSTransition
      in={showScrollButton && scrollButtonPreference}
      timeout={{
        enter: 300,
        exit: 250,
      }}
      classNames="scroll-animation"
      unmountOnExit={true}
      appear={true}
      nodeRef={scrollToBottomRef}
    >
      <ScrollToBottom ref={scrollToBottomRef} scrollHandler={scrollHandler} />
    </CSSTransition>
  );
});

function MessagesViewContent({
  messagesTree: _messagesTree,
}: {
  messagesTree?: TMessage[] | null;
}) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const { screenshotTargetRef } = useScreenshot();
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);

  const {
    conversation,
    contentRef,
    scrollableRef,
    messagesEndRef,
    handleSmoothToRef,
    debouncedHandleScroll,
    handleNearBottomChange,
  } = useMessageScrolling(_messagesTree);

  const { conversationId } = conversation ?? {};
  /** `ChatView`'s own decision to render this component at all (rather than
   *  `Landing`) is keyed on the URL's conversation id (`useParams`), not the
   *  Recoil `conversation` atom - deliberately, per `ChatRoute.tsx`'s own
   *  comment on `ChatPanelHost`: the atom can still be catching up to a
   *  `navigate()` that just fired (a brand-new conversation minted and
   *  seeded by the composer's instant-navigate transcribe flow is exactly
   *  this case) well after the URL itself is already correct. Deriving
   *  `isRestCreatedEmptyStart` from the ATOM's id instead re-introduces
   *  that exact gap one level down: `ChatView` already committed to
   *  rendering this component for the URL's real id, but this check could
   *  still read the not-yet-caught-up atom and fall through to "Nothing
   *  found" regardless - matching the URL, like `ChatPanelHost`/
   *  `TranscriptPanel` already do for the exact same reason, closes it. */
  const { conversationId: urlConversationId } = useParams();
  /** A real, already-persisted conversation (created via a REST action -
   *  today only the audio transcriber's `POST /api/transcribe`, historically -
   *  rather than the normal first-message flow) can legitimately have zero
   *  chat messages until the user actually asks the model something. `ChatView`
   *  already routes a genuinely new, unsaved draft (`Constants.NEW_CONVO` or no
   *  id) to `Landing` instead of this component, so by the time an empty tree
   *  reaches here it's always this case, not a failed search. */
  const isRestCreatedEmptyStart =
    urlConversationId != null && urlConversationId !== Constants.NEW_CONVO;

  /** The in-flight steer overlay floats above the composer over the bottom of
   *  the thread (see `InFlightSteers`); reserve an equal band here so the
   *  newest message rests above it and older ones scroll behind. */
  const steerOverlayHeight = useAtomValue(
    steerOverlayHeightFamily(conversationId ?? Constants.NEW_CONVO),
  );

  return (
    <>
      <div className="relative flex-1 overflow-hidden overflow-y-auto">
        <div className="relative h-full">
          <div
            className="scrollbar-gutter-stable"
            onScroll={debouncedHandleScroll}
            ref={scrollableRef}
            style={{
              height: '100%',
              overflowY: 'auto',
              width: '100%',
            }}
          >
            <div
              ref={contentRef}
              className="flex flex-col pb-9 pt-14 dark:bg-transparent"
              style={
                steerOverlayHeight > 0
                  ? { paddingBottom: `calc(2.25rem + ${steerOverlayHeight}px)` }
                  : undefined
              }
            >
              {((_messagesTree && _messagesTree.length == 0) || _messagesTree === null) &&
              !isRestCreatedEmptyStart ? (
                <div
                  className={cn(
                    'flex w-full items-center justify-center p-3 text-text-secondary',
                    fontSize,
                  )}
                >
                  {localize('com_ui_nothing_found')}
                </div>
              ) : (
                <>
                  <div ref={screenshotTargetRef}>
                    <MultiMessage
                      messagesTree={_messagesTree ?? undefined}
                      messageId={conversationId ?? null}
                      setCurrentEditId={setCurrentEditId}
                      currentEditId={currentEditId ?? null}
                    />
                  </div>
                </>
              )}
              {/* Renders wherever its real message bubble will land once the
                  upload resolves - both for a brand-new, still-empty
                  conversation (replacing "Nothing found" above, since
                  `isRestCreatedEmptyStart` already keeps that branch from
                  firing here) and appended after an existing conversation's
                  real messages when a second recording is mid-upload. Keyed
                  off the URL id, same reasoning as `isRestCreatedEmptyStart`
                  above - `pendingTranscriptionUploadsByConvoId` is written
                  under the real minted id the instant the composer navigates
                  here, which is exactly what the URL already carries. */}
              {urlConversationId != null && (
                <PendingTranscriptionMessages conversationId={urlConversationId} />
              )}
              <div
                id="messages-end"
                className="group h-0 w-full flex-shrink-0"
                ref={messagesEndRef}
              />
            </div>
          </div>

          <ScrollButton
            scrollableRef={scrollableRef}
            messagesEndRef={messagesEndRef}
            scrollHandler={handleSmoothToRef}
            onNearBottomChange={handleNearBottomChange}
          />

          <MessageNav scrollableRef={scrollableRef} />
        </div>
      </div>
    </>
  );
}

export default function MessagesView({ messagesTree }: { messagesTree?: TMessage[] | null }) {
  return (
    <MessagesViewProvider>
      <MessagesViewContent messagesTree={messagesTree} />
    </MessagesViewProvider>
  );
}
