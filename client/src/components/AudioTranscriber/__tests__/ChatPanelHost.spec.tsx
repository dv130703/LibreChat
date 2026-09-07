/* eslint-disable i18next/no-literal-string */
import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ChatPanelHost from '../ChatPanelHost';
import type { PanelComponentProps } from '../panelHostContext';

let mockIsSmallScreen = false;
const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => mockIsSmallScreen,
  useToastContext: () => ({ showToast: mockShowToast }),
  // Real resize mechanics aren't what these tests care about - simple
  // passthroughs keep the tree shallow and assertable.
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandleAlt: () => <div data-testid="resize-handle" />,
}));

// `jest.mock` factories are hoisted above module-scope declarations, so the
// stand-in has to be defined *inside* the factory - referencing an
// out-of-scope `StubPanel` declared below would throw at collection time.
// Stands in for `TranscriptPanel` (or any future panel type): calls
// `useChatHeaderSlot` for real, so the D6 slot mechanism itself is
// exercised, and exposes buttons so a test can trigger `onResolved`
// `onResolved` deliberately instead of needing a real data fetch.
// Memoized for the same reason the real `TranscriptPanel` is (see its own
// comment): without it, `ChatPanelHost`'s `setHeaderSlot` re-render recreates
// this component's header JSX node every time, whose changed identity
// re-fires `useChatHeaderSlot`'s effect, calling `setHeaderSlot` again -
// an infinite loop, caught here by React's "Maximum update depth exceeded"
// the first time this test file was written without the memo.
jest.mock('../TranscriptPanel', () => {
  const { memo: memoize } = jest.requireActual('react');
  const { useChatHeaderSlot: useHeaderSlot } = jest.requireActual('../panelHostContext');
  function MockTranscriptPanel({ fileId, onResolved, onClose }: PanelComponentProps) {
    useHeaderSlot(<div data-testid="player-slot-content">player</div>);
    return (
      <div data-testid="stub-panel">
        <span>fileId: {fileId ?? 'none'}</span>
        <button onClick={() => onResolved('resolved-file-id')}>resolve</button>
        <button onClick={onClose}>panel-dismiss</button>
      </div>
    );
  }
  return { __esModule: true, default: memoize(MockTranscriptPanel) };
});

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderHost(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationDisplay />
      <ChatPanelHost conversationId="convo-1">
        <div data-testid="chat-content">chat</div>
      </ChatPanelHost>
    </MemoryRouter>,
  );
}

describe('ChatPanelHost (transcription/ARCHITECTURE.md §6.3, Phase 3)', () => {
  beforeEach(() => {
    mockIsSmallScreen = false;
    mockShowToast.mockClear();
  });

  it('renders only the chat content when no ?panel param is present', () => {
    renderHost('/audio-transcriber/convo-1');

    expect(screen.getByTestId('chat-content')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-panel')).not.toBeInTheDocument();
  });

  it('opens the registered panel for a known ?panel type', () => {
    renderHost('/audio-transcriber/convo-1?panel=transcript');

    expect(screen.getByTestId('chat-content')).toBeInTheDocument();
    expect(screen.getByTestId('stub-panel')).toBeInTheDocument();
  });

  it('ignores an unknown ?panel type rather than throwing', () => {
    renderHost('/audio-transcriber/convo-1?panel=not-a-real-panel');

    expect(screen.getByTestId('chat-content')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-panel')).not.toBeInTheDocument();
  });

  it('passes the ?file param through to the panel as fileId', () => {
    renderHost('/audio-transcriber/convo-1?panel=transcript&file=source-42');

    expect(screen.getByText('fileId: source-42')).toBeInTheDocument();
  });

  it("contributes the panel's header-slot content without a DOM portal (D6)", () => {
    renderHost('/audio-transcriber/convo-1?panel=transcript');

    expect(screen.getByTestId('player-slot-content')).toBeInTheDocument();
  });

  it('syncs ?file into the URL once the panel reports what it resolved to', () => {
    renderHost('/audio-transcriber/convo-1?panel=transcript');

    fireEvent.click(screen.getByText('resolve'));

    expect(screen.getByTestId('location-search').textContent).toContain('file=resolved-file-id');
  });

  // Defect 2: the panel used to be able to close itself when it couldn't
  // resolve `?file=`, which fired for a `file` param that simply hadn't
  // caught up yet (a pending upload's client-only id) and took the pane away
  // mid-job. Whether the panel is open now depends on `?panel=` and nothing
  // else, so a `file` param naming something unresolvable must leave it up.
  it('keeps the panel open for a file param that resolves to nothing', () => {
    renderHost('/audio-transcriber/convo-1?panel=transcript&file=stale-id');

    expect(screen.getByTestId('stub-panel')).toBeInTheDocument();
    expect(screen.getByText('fileId: stale-id')).toBeInTheDocument();
    expect(screen.getByTestId('location-search').textContent).toContain('panel=transcript');
  });

  // Real bug this guards: the desktop (resizable split-pane) layout never
  // passed the panel any way to close itself - `closePanel` existed in this
  // file but was only ever wired to the mobile overlay's own wrapper button,
  // so a desktop user had no way to close the transcript panel at all short
  // of editing the URL. `onClose` (new `PanelComponentProps` field) fixes
  // that by handing `closePanel` to the panel itself, for both layouts, so
  // it can offer a close affordance from wherever fits its own header.
  it("gives the panel a way to close itself on the desktop layout, where there's otherwise no other close control", () => {
    renderHost('/audio-transcriber/convo-1?panel=transcript&file=source-42');

    fireEvent.click(screen.getByText('panel-dismiss'));

    expect(screen.queryByTestId('stub-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-search').textContent).not.toContain('panel=');
    expect(screen.getByTestId('location-search').textContent).not.toContain('file=');
  });

  describe('mobile (< 767px)', () => {
    beforeEach(() => {
      mockIsSmallScreen = true;
    });

    it('renders the panel as a full-screen overlay instead of hiding it - the bug this phase fixes', () => {
      renderHost('/audio-transcriber/convo-1?panel=transcript');

      // Both present at once: the chat content underneath, the panel overlaid
      // on top - not "panel replaces chat" and not "panel omitted."
      expect(screen.getByTestId('chat-content')).toBeInTheDocument();
      expect(screen.getByTestId('stub-panel')).toBeInTheDocument();
    });

    it("the overlay's close button clears the panel/file query params", () => {
      renderHost('/audio-transcriber/convo-1?panel=transcript&file=source-42');

      fireEvent.click(screen.getByRole('button', { name: /close/i }));

      expect(screen.queryByTestId('stub-panel')).not.toBeInTheDocument();
      expect(screen.getByTestId('location-search').textContent).not.toContain('panel=');
    });

    it('does not render the resizable desktop layout', () => {
      renderHost('/audio-transcriber/convo-1?panel=transcript');
      expect(screen.queryByTestId('panel-group')).not.toBeInTheDocument();
    });
  });
});
