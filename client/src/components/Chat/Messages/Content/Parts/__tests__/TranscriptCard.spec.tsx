import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import type { TConversationTranscript } from 'librechat-data-provider';
import TranscriptCard from '../TranscriptCard';

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

function renderCard(record: TConversationTranscript) {
  return render(
    <MemoryRouter initialEntries={['/c/convo-1']}>
      <SearchParamsDisplay />
      <TranscriptCard record={record} />
    </MemoryRouter>,
  );
}

const baseRecord: TConversationTranscript = {
  sourceFileId: 'source-file-1',
  // The uploaded name, not the extracted `.m4a` artifact's - see
  // `originalFilename`. Defect 1 was this label changing mid-flight.
  displayName: 'interview.mp4',
  transcriptFileId: null,
  diarizationDetailFileId: null,
  jobStatus: 'queued',
  jobError: null,
  cancelled: false,
  indexStatus: null,
  isQueryable: false,
  unqueryableReason: 'in_progress',
};

describe('TranscriptCard (transcription/ARCHITECTURE.md §6.1/§6.4, Phase 4)', () => {
  it('shows a queued spinner and still opens the transcript panel when clicked', () => {
    renderCard(baseRecord);

    expect(screen.getByText('com_ui_transcript_card_queued')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));

    // `TranscriptPanel` renders its own "queued"/"transcribing" state (audio
    // player + spinner) when opened before the job finishes - no reason to
    // make the user wait for `ready` before they can even see that.
    const params = screen.getByTestId('search-params').textContent;
    expect(params).toContain('panel=transcript');
    expect(params).toContain('file=source-file-1');
  });

  it('shows a transcribing spinner and still opens the transcript panel when clicked', () => {
    renderCard({ ...baseRecord, jobStatus: 'transcribing' });

    expect(screen.getByText('com_ui_transcript_card_transcribing')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));

    const params = screen.getByTestId('search-params').textContent;
    expect(params).toContain('panel=transcript');
    expect(params).toContain('file=source-file-1');
  });

  it(
    'shows the failure state with no retry action of its own - regression: retry now ' +
      "renders as an icon among the message's other hover actions instead (see " +
      'HoverButtons.spec.tsx), not as a text link next to this card',
    () => {
      renderCard({ ...baseRecord, jobStatus: 'failed', jobError: 'boom' });

      expect(screen.getByText('com_ui_transcript_card_failed')).toBeInTheDocument();
      expect(screen.queryByText('com_ui_transcript_card_retry')).not.toBeInTheDocument();
    },
  );

  it("opens the transcript panel on this conversation's URL once ready", () => {
    renderCard({
      ...baseRecord,
      jobStatus: 'ready',
      transcriptFileId: 'transcript-1',
      isQueryable: true,
      unqueryableReason: null,
    });

    expect(screen.getByText('com_ui_transcript_card_ready')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));

    const params = screen.getByTestId('search-params').textContent;
    expect(params).toContain('panel=transcript');
    expect(params).toContain('file=source-file-1');
  });

  it('falls back to the queued label when the job record has no status yet', () => {
    renderCard({ ...baseRecord, jobStatus: null });

    expect(screen.getByText('com_ui_transcript_card_queued')).toBeInTheDocument();
  });

  it('labels the recording with the uploaded name, never the extracted track', () => {
    // Defect 1: the persisted source file is `interview.m4a`, so a chip
    // labelled from it renamed itself the moment the placeholder handed off.
    renderCard(baseRecord);

    expect(screen.getByText('interview.mp4')).toBeInTheDocument();
  });
});
