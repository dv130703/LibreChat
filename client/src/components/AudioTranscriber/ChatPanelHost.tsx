import { useRef, useMemo, useState, useCallback } from 'react';
import type { ReactNode, ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import {
  ResizableHandleAlt,
  ResizablePanel,
  ResizablePanelGroup,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import { ChatPanelHostContext } from './panelHostContext';
import type { PanelComponentProps } from './panelHostContext';
import TranscriptPanel from './TranscriptPanel';

/**
 * Generic host for a resizable side panel next to arbitrary chat content -
 * see transcription/ARCHITECTURE.md §6.3/Phase 3. Built to the URL contract
 * the *final* design needs (`?panel=<type>&file=<id>`) from the start, back
 * when its only caller was the standalone Audio Transcriber page's own
 * `Workspace` component - Phase 5 (§9) mounted it in `ChatRoute` itself
 * instead, unconditionally, so it now covers every conversation on `/c/:id`
 * with no changes needed here, exactly as anticipated; `Workspace` and the
 * standalone page are gone. There's still only one registered panel type.
 * `PanelComponentProps`/the header-slot context live in `./panelHostContext`
 * rather than here, so a panel component (`TranscriptPanel.tsx`) can import
 * them without a circular dependency on this file (which itself imports
 * `TranscriptPanel` for the registry below).
 */

/** Fixed-pixel floors so neither pane can be dragged down to an unusable
 *  width; the side panel also caps out at 70% so the chat pane always keeps
 *  a majority share of the screen. Unchanged from the values `Workspace`
 *  used directly before this refactor. */
const MIN_PANE_WIDTH = '320px';
const PANEL_MAX_WIDTH = '70%';
const MOBILE_BREAKPOINT = '(max-width: 767px)';

const PANELS = {
  transcript: TranscriptPanel,
} as const satisfies Record<string, ComponentType<PanelComponentProps>>;

type PanelType = keyof typeof PANELS;

function isPanelType(value: string | null): value is PanelType {
  return value != null && Object.prototype.hasOwnProperty.call(PANELS, value);
}

export default function ChatPanelHost({
  conversationId,
  children,
}: {
  conversationId: string;
  children: ReactNode;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const isSmallScreen = useMediaQuery(MOBILE_BREAKPOINT);
  const [searchParams, setSearchParams] = useSearchParams();
  const [headerSlot, setHeaderSlot] = useState<ReactNode>(null);

  const panelParam = searchParams.get('panel');
  const fileParam = searchParams.get('file');
  const PanelComponent = isPanelType(panelParam) ? PANELS[panelParam] : null;

  /**
   * `closePanel`/`handleResolved`/`handleUnresolvable` are handed to
   * `PanelComponent` as props, and that component is memoized (see
   * `TranscriptPanel`'s own comment) specifically so this host's re-renders
   * don't cascade into re-rendering it unnecessarily - but memoization only
   * helps if these props are *actually* stable. `react-router-dom`'s
   * `setSearchParams` is not guaranteed to keep the same reference across
   * renders, so a plain `useCallback([..., setSearchParams])` would silently
   * recreate these on every render anyway, defeating the memo and closing an
   * infinite loop: recreated callback -> new panel props -> memo bails out
   * of nothing -> panel re-renders -> recreates its header-slot node ->
   * `useChatHeaderSlot` fires -> `setHeaderSlot` -> this host re-renders ->
   * repeat (this is exactly what happened before this fix - "Maximum update
   * depth exceeded" in `ChatPanelHost.spec.tsx`). Reading everything through
   * a ref updated on every render, instead of through the closure `useCallback`
   * would otherwise capture, keeps these three callbacks referentially
   * identical for the component's entire lifetime regardless of what
   * upstream hooks decide to do with their own return values.
   */
  const latest = useRef({ setSearchParams, showToast, localize, fileParam });
  latest.current = { setSearchParams, showToast, localize, fileParam };

  const closePanel = useCallback(() => {
    latest.current.setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('panel');
        next.delete('file');
        return next;
      },
      { replace: true },
    );
  }, []);

  /** Syncs the URL to the panel's real target once it's known - a page
   *  reloaded or bookmarked from this point on lands on the same file,
   *  not just the same conversation. No-op if already in sync. */
  const handleResolved = useCallback((resolvedFileId: string) => {
    if (latest.current.fileParam === resolvedFileId) {
      return;
    }
    latest.current.setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('file', resolvedFileId);
        return next;
      },
      { replace: true },
    );
  }, []);

  const handleUnresolvable = useCallback(() => {
    latest.current.showToast({
      message: latest.current.localize('com_ui_transcript_panel_unavailable'),
      severity: NotificationSeverity.ERROR,
      showIcon: true,
    });
    closePanel();
  }, [closePanel]);

  const contextValue = useMemo(() => ({ setHeaderSlot }), []);
  const isPanelOpen = PanelComponent != null;

  const chatPane = (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0">{headerSlot}</div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );

  const panel = isPanelOpen && PanelComponent && (
    <PanelComponent
      conversationId={conversationId}
      fileId={fileParam}
      onResolved={handleResolved}
      onUnresolvable={handleUnresolvable}
    />
  );

  // Below the mobile breakpoint the panel becomes a full-screen overlay
  // instead of disappearing outright - before this refactor the transcript
  // pane was unconditionally omitted under 767px, meaning the feature
  // silently didn't exist on a phone. Fixed here rather than ported forward.
  if (isSmallScreen) {
    return (
      <ChatPanelHostContext.Provider value={contextValue}>
        <div className="relative h-full w-full overflow-hidden">
          {chatPane}
          {isPanelOpen && (
            <div className="absolute inset-0 z-40 flex flex-col bg-surface-primary">
              <div className="flex flex-shrink-0 items-center justify-end border-b border-border-medium p-2">
                <button
                  type="button"
                  onClick={closePanel}
                  aria-label={localize('com_ui_close')}
                  className="rounded-md p-1.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1">{panel}</div>
            </div>
          )}
        </div>
      </ChatPanelHostContext.Provider>
    );
  }

  return (
    <ChatPanelHostContext.Provider value={contextValue}>
      <ResizablePanelGroup orientation="horizontal" className="h-full w-full">
        <ResizablePanel defaultSize="50" minSize={MIN_PANE_WIDTH} id="chat-view">
          {chatPane}
        </ResizablePanel>
        {isPanelOpen && (
          <>
            <ResizableHandleAlt className="bg-border-medium" />
            <ResizablePanel
              defaultSize="50"
              minSize={MIN_PANE_WIDTH}
              maxSize={PANEL_MAX_WIDTH}
              id="side-panel"
              className="border-l border-border-medium"
            >
              {panel}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </ChatPanelHostContext.Provider>
  );
}
