import { useEffect, useContext, createContext } from 'react';
import type { ReactNode } from 'react';

/**
 * Shared between `ChatPanelHost.tsx` (the provider/consumer of this context)
 * and any panel component (`TranscriptPanel.tsx`) it hosts - kept in its own
 * module specifically so neither has to import the other: `ChatPanelHost`
 * already imports `TranscriptPanel` directly (its panel registry), so
 * `TranscriptPanel` importing back from `ChatPanelHost.tsx` would be a
 * circular module dependency. Types are erased at compile time and safe
 * either way, but `useChatHeaderSlot` is a real function value, not just a
 * type - worth avoiding the cycle outright rather than relying on bundler
 * behavior around circular value imports.
 */

export interface PanelComponentProps {
  conversationId: string;
  /** The `file` query param's value at mount, or `null` if the panel was
   *  opened without one. A panel that resolves its own real target id
   *  should report it via `onResolved`. */
  fileId: string | null;
  /** Call once the panel has resolved which file it's actually showing, so
   *  the URL can be synced to a bookmarkable/shareable address. */
  onResolved: (fileId: string) => void;
  /** Call when `fileId` was present but doesn't correspond to anything this
   *  caller can access (deleted, failed, not owned) - closes the panel with
   *  a toast instead of rendering an in-panel error state. */
  onUnresolvable: () => void;
}

interface ChatPanelHostContextValue {
  setHeaderSlot: (node: ReactNode) => void;
}

export const ChatPanelHostContext = createContext<ChatPanelHostContextValue | null>(null);

/**
 * Lets whatever panel is currently open contribute content into the chat
 * pane's own header region (e.g. the Audio Transcriber's audio player)
 * without a DOM portal - see transcription/ARCHITECTURE.md D6. Portalling
 * into a node rendered by a sibling component is mount-order dependent (the
 * target has to already exist as a real DOM node before the portal source
 * renders); this instead lifts the already-composed React element up to
 * `ChatPanelHost`, the one parent that owns both the header region and the
 * panel itself, so there's no cross-component DOM handoff to race at all -
 * just a normal state update. Outside a `ChatPanelHost` (there's always
 * exactly one, or none), this is a no-op rather than throwing, so a panel
 * component stays usable in isolation (tests, Storybook-style previews).
 */
export function useChatHeaderSlot(node: ReactNode): void {
  const ctx = useContext(ChatPanelHostContext);
  useEffect(() => {
    ctx?.setHeaderSlot(node);
    return () => ctx?.setHeaderSlot(null);
  }, [ctx, node]);
}
