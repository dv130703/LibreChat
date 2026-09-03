import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import type { TFile, TTranscribeStatusEntry } from 'librechat-data-provider';
import TranscriptCard from '../TranscriptCard';

const mockRetryMutate = jest.fn();
let mockRetryIsLoading = false;

jest.mock('~/data-provider', () => ({
  useRetryTranscriptionMutation: () => ({
    mutate: mockRetryMutate,
    isLoading: mockRetryIsLoading,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

// Isolates this suite to `TranscriptCard`'s own status-branching logic - the
// real `FileContainer` (icon lookup, chip chrome) is already covered by its
// own tests. Exposes just enough of the real contract (`subtitle`, `onClick`)
// to assert against.
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

function renderCard(file: Partial<TFile>, jobStatus: TTranscribeStatusEntry | undefined) {
  return render(
    <MemoryRouter initialEntries={['/c/convo-1']}>
      <SearchParamsDisplay />
      <TranscriptCard file={file} jobStatus={jobStatus} />
    </MemoryRouter>,
  );
}

const baseFile: Partial<TFile> = {
  file_id: 'source-file-1',
  filename: 'interview.mp3',
  type: 'audio/mpeg',
};

const baseJobStatus: Omit<TTranscribeStatusEntry, 'status'> = {
  file_id: 'source-file-1',
  error: null,
  transcriptFileId: null,
  diarizationDetailFileId: null,
};

describe('TranscriptCard (transcription/ARCHITECTURE.md §6.1/§6.4, Phase 4)', () => {
  beforeEach(() => {
    mockRetryMutate.mockClear();
    mockRetryIsLoading = false;
  });

  it('shows a queued spinner and is not clickable while queued', () => {
    renderCard(baseFile, { ...baseJobStatus, status: 'queued' });

    expect(screen.getByText('com_ui_transcript_card_queued')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));
    expect(screen.getByTestId('search-params').textContent).toBe('');
  });

  it('shows a transcribing spinner', () => {
    renderCard(baseFile, { ...baseJobStatus, status: 'transcribing' });

    expect(screen.getByText('com_ui_transcript_card_transcribing')).toBeInTheDocument();
  });

  it('shows the failure state with a working retry button, without opening the transcript', () => {
    renderCard(baseFile, { ...baseJobStatus, status: 'failed', error: 'boom' });

    expect(screen.getByText('com_ui_transcript_card_failed')).toBeInTheDocument();
    fireEvent.click(screen.getByText('com_ui_transcript_card_retry'));

    expect(mockRetryMutate).toHaveBeenCalledWith({ sourceFileId: 'source-file-1' });
    // Retry's own click must not also bubble into the card's onClick.
    expect(screen.getByTestId('search-params').textContent).toBe('');
  });

  it("opens the transcript panel on this conversation's URL once ready", () => {
    renderCard(baseFile, { ...baseJobStatus, status: 'ready', transcriptFileId: 'transcript-1' });

    expect(screen.getByText('com_ui_transcript_card_ready')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));

    const params = screen.getByTestId('search-params').textContent;
    expect(params).toContain('panel=transcript');
    expect(params).toContain('file=source-file-1');
  });

  it('treats a missing job status (not yet polled, or not a transcription job) as non-interactive', () => {
    renderCard(baseFile, undefined);

    expect(screen.getByText('com_ui_transcript_card_queued')).toBeInTheDocument();
  });
});
