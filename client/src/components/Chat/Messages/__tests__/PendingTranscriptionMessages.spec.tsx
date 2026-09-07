import { RecoilRoot, MutableSnapshot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PendingTranscriptionMessages from '../PendingTranscriptionMessages';
import {
  MESSAGE_BODY_CLASSES,
  MESSAGE_CONTENT_CLASSES,
} from '~/components/Chat/Messages/ui/messageShell';
import store from '~/store';

jest.mock('~/components/Chat/Messages/MessageIcon', () => {
  return function MockMessageIcon() {
    return <div data-testid="message-icon" />;
  };
});

const mockRetry = jest.fn();

jest.mock('~/hooks/AudioTranscriber/usePendingUploadRetry', () => ({
  usePendingUploadRetry: () => mockRetry,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { name: 'Test User', username: 'testuser' } }),
}));

// Isolates this suite to the pending-row's own status branching - `FileContainer`'s
// icon lookup/chip chrome is already covered by its own tests.
jest.mock('~/components/Chat/Input/Files/FileContainer', () => {
  function MockFileContainer({
    displayName,
    subtitle,
    onClick,
  }: {
    displayName?: string;
    subtitle?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) {
    return (
      <button type="button" onClick={onClick} data-testid="file-container">
        <span>{displayName}</span>
        <div data-testid="subtitle">{subtitle}</div>
      </button>
    );
  }
  return { __esModule: true, default: MockFileContainer };
});

function SearchParamsDisplay() {
  const [searchParams] = useSearchParams();
  return <div data-testid="search-params">{searchParams.toString()}</div>;
}

const CONVO_ID = 'convo-1';
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderWithPending(pendingUploads: Array<Record<string, unknown>>) {
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.pendingTranscriptionUploadsByConvoId(CONVO_ID), pendingUploads as never);
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={initializeState}>
        <MemoryRouter initialEntries={['/c/convo-1']}>
          <SearchParamsDisplay />
          <PendingTranscriptionMessages conversationId={CONVO_ID} />
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

const baseFile = new File(['x'], 'recording.mp3', { type: 'audio/mpeg' });

describe('PendingTranscriptionMessages', () => {
  beforeEach(() => {
    mockRetry.mockClear();
  });

  it('renders nothing when there is no pending upload', () => {
    renderWithPending([]);
    expect(screen.queryByTestId('file-container')).not.toBeInTheDocument();
  });

  it(
    'shows the account\'s real display name, not a hardcoded "You" - regression: the ' +
      "placeholder header showed generic fallback text that visibly changed to the account's " +
      'actual name the instant the real message replaced it',
    () => {
      renderWithPending([
        {
          pendingId: 'pending-1',
          conversationId: CONVO_ID,
          filename: 'recording.mp3',
          file: baseFile,
          options: {},
          parentMessageId: 'root',
          isNewConversation: true,
          status: 'uploading',
          createdAt: new Date().toISOString(),
        },
      ]);

      expect(screen.getByText('Test User')).toBeInTheDocument();
      expect(screen.queryByText('com_user_message')).not.toBeInTheDocument();
    },
  );

  it(
    "shows 'Processing…', not a transcription-status label - regression: nothing existed for " +
      'this window before, so by the time anything rendered the job had often already reached ' +
      'queued/transcribing, making a plain-upload delay look like actual transcription was already ' +
      'underway',
    () => {
      renderWithPending([
        {
          pendingId: 'pending-1',
          conversationId: CONVO_ID,
          filename: 'recording.mp3',
          file: baseFile,
          options: {},
          parentMessageId: 'root',
          isNewConversation: true,
          status: 'uploading',
        },
      ]);

      expect(screen.getByText('com_ui_transcript_card_processing')).toBeInTheDocument();
      expect(screen.queryByText('com_ui_transcript_card_transcribing')).not.toBeInTheDocument();
      expect(screen.getByText('recording.mp3')).toBeInTheDocument();
    },
  );

  it('opens the transcript panel with the pending id when clicked while uploading', () => {
    renderWithPending([
      {
        pendingId: 'pending-1',
        conversationId: CONVO_ID,
        filename: 'recording.mp3',
        file: baseFile,
        options: {},
        parentMessageId: 'root',
        isNewConversation: true,
        status: 'uploading',
      },
    ]);

    fireEvent.click(screen.getByTestId('file-container'));

    const params = screen.getByTestId('search-params').textContent;
    expect(params).toContain('panel=transcript');
    expect(params).toContain('file=pending-1');
  });

  it('shows the failure message with a working retry button, without opening the panel', () => {
    renderWithPending([
      {
        pendingId: 'pending-1',
        conversationId: CONVO_ID,
        filename: 'recording.mp3',
        file: baseFile,
        options: {},
        parentMessageId: 'root',
        isNewConversation: true,
        status: 'failed',
        errorMessage: 'Network error',
      },
    ]);

    expect(screen.getByText('Network error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('com_ui_transcript_card_retry'));

    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('search-params').textContent).toBe('');
  });

  it('renders one row per pending recording', () => {
    renderWithPending([
      {
        pendingId: 'pending-1',
        conversationId: CONVO_ID,
        filename: 'first.mp3',
        file: baseFile,
        options: {},
        parentMessageId: 'root',
        isNewConversation: true,
        status: 'uploading',
      },
      {
        pendingId: 'pending-2',
        conversationId: CONVO_ID,
        filename: 'second.mp3',
        file: baseFile,
        options: {},
        parentMessageId: 'pending-1',
        isNewConversation: false,
        status: 'uploading',
      },
    ]);

    expect(screen.getByText('first.mp3')).toBeInTheDocument();
    expect(screen.getByText('second.mp3')).toBeInTheDocument();
  });
});

describe('message-shell parity with a real message row', () => {
  const pendingUpload = {
    pendingId: 'pending-1',
    conversationId: CONVO_ID,
    filename: 'recording.mp3',
    file: baseFile,
    options: {},
    parentMessageId: 'root',
    isNewConversation: true,
    status: 'uploading',
    createdAt: new Date().toISOString(),
  };

  // The pending row sits exactly where its real message will land, so its
  // inner shell has to BE the real one. It used to hand-copy those classes
  // and merge the two wrappers into one, which dropped `items-start` and
  // stretched the chip to full width - visibly a different kind of object in
  // the thread from the message that replaced it moments later.
  it('nests the real message body and content wrappers', () => {
    const { container } = renderWithPending([pendingUpload]);

    const content = container.querySelector('.text-message');
    expect(content).not.toBeNull();

    const body = content?.parentElement;
    for (const cls of MESSAGE_BODY_CLASSES.split(' ')) {
      expect(body?.classList.contains(cls)).toBe(true);
    }
  });

  it('carries every shared content class, `items-start` included', () => {
    const { container } = renderWithPending([pendingUpload]);
    const content = container.querySelector('.text-message');

    // `items-start` is the load-bearing one: without it the flex column
    // stretches the chip to full width.
    expect(content?.classList.contains('items-start')).toBe(true);
    for (const cls of MESSAGE_CONTENT_CLASSES.split(' ')) {
      expect(content?.classList.contains(cls)).toBe(true);
    }
  });
});
