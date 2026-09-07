import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, Tools } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TConversationTranscript } from 'librechat-data-provider';
import SyncTranscriptToolBadge from '../SyncTranscriptToolBadge';

const mockUpdate = jest.fn();
let mockEphemeralState: Record<string, unknown> | undefined;

jest.mock('~/store', () => ({
  useUpdateEphemeralAgent: () => mockUpdate,
  useGetEphemeralAgent: () => () => mockEphemeralState,
}));

const CONVO_ID = 'convo-1';

const transcript = (overrides: Partial<TConversationTranscript>): TConversationTranscript => ({
  sourceFileId: 'source-1',
  displayName: 'standup.mp4',
  transcriptFileId: 'source-1-transcript',
  diarizationDetailFileId: null,
  jobStatus: 'ready',
  jobError: null,
  cancelled: false,
  indexStatus: 'indexed',
  isQueryable: true,
  unqueryableReason: null,
  ...overrides,
});

function renderSync(transcripts: TConversationTranscript[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.conversationTranscripts, CONVO_ID], { transcripts });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<SyncTranscriptToolBadge conversationId={CONVO_ID} />, { wrapper });
}

describe('SyncTranscriptToolBadge', () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    mockEphemeralState = undefined;
  });

  it('turns the badge on when the conversation has a searchable transcript', () => {
    renderSync([transcript({})]);

    expect(mockUpdate).toHaveBeenCalledWith(
      CONVO_ID,
      expect.objectContaining({ [Tools.file_search]: true }),
    );
  });

  it('leaves the badge alone when nothing is searchable yet', () => {
    // Still transcribing - retrieval is not possible, so claiming otherwise
    // in the UI would be a lie the user then has to interpret.
    renderSync([
      transcript({
        transcriptFileId: null,
        jobStatus: 'transcribing',
        isQueryable: false,
        unqueryableReason: 'in_progress',
      }),
    ]);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('preserves other ephemeral tools rather than clearing them', () => {
    mockEphemeralState = { execute_code: true, mcp: ['server-a'] };
    renderSync([transcript({})]);

    expect(mockUpdate).toHaveBeenCalledWith(CONVO_ID, {
      execute_code: true,
      mcp: ['server-a'],
      [Tools.file_search]: true,
    });
  });

  it('does not rewrite state that is already correct', () => {
    mockEphemeralState = { [Tools.file_search]: true };
    renderSync([transcript({})]);

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
