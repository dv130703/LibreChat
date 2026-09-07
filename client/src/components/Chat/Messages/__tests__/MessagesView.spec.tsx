import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MessagesView from '../MessagesView';

beforeAll(() => {
  // `ScrollButton` (defined inline in `MessagesView.tsx`, not independently
  // mockable) observes `messagesEndRef` directly - jsdom has no real
  // implementation of this.
  class MockIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(global, 'IntersectionObserver', {
    writable: true,
    value: MockIntersectionObserver,
  });
});

const mockConversation: { conversationId?: string } = {};

jest.mock('~/Providers', () => ({
  MessagesViewProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('~/hooks', () => ({
  useScreenshot: () => ({ screenshotTargetRef: { current: null } }),
  useLocalize: () => (key: string) => key,
  useMessageScrolling: () => ({
    conversation: mockConversation,
    contentRef: { current: null },
    scrollableRef: { current: null },
    messagesEndRef: { current: null },
    handleSmoothToRef: jest.fn(),
    debouncedHandleScroll: jest.fn(),
    handleNearBottomChange: jest.fn(),
  }),
}));

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: () => 0,
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: () => false,
}));

jest.mock('../MultiMessage', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../MessageNav', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Messages/ScrollToBottom', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../PendingTranscriptionMessages', () => ({
  __esModule: true,
  default: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="pending-transcription-messages">{conversationId}</div>
  ),
}));

function renderAt(urlConversationId: string) {
  return render(
    <MemoryRouter initialEntries={[`/c/${urlConversationId}`]}>
      <Routes>
        <Route path="/c/:conversationId" element={<MessagesView messagesTree={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe(
  'MessagesView - regression: `isRestCreatedEmptyStart` and the pending-transcription bubble ' +
    "must key off the URL's conversation id, not the Recoil conversation atom - the atom can " +
    "still carry the previous draft's `Constants.NEW_CONVO` for a render or more after the " +
    "composer's instant-navigate transcribe flow already updated the URL to the real, freshly " +
    'minted id (the same reason `ChatPanelHost`/`TranscriptPanel` already use the URL for this). ' +
    'Reading the atom instead falls through to "Nothing found" and never renders the pending ' +
    "upload's placeholder bubble, even though the panel-side UI works because it's already URL-based.",
  () => {
    it('shows the pending-upload bubble (not "Nothing found") for a real URL id, even while the atom still lags on NEW_CONVO', () => {
      mockConversation.conversationId = 'new';

      renderAt('minted-real-id');

      expect(screen.queryByText('com_ui_nothing_found')).not.toBeInTheDocument();
      expect(screen.getByTestId('pending-transcription-messages')).toHaveTextContent(
        'minted-real-id',
      );
    });

    it('still shows "Nothing found" for a genuinely new, unsaved draft', () => {
      mockConversation.conversationId = 'new';

      renderAt('new');

      expect(screen.getByText('com_ui_nothing_found')).toBeInTheDocument();
    });
  },
);
