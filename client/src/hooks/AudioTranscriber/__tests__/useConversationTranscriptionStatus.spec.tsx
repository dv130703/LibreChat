import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TConversationTranscript } from 'librechat-data-provider';
import { useConversationTranscriptionStatus } from '../useConversationTranscriptionStatus';

const CONVO_ID = 'convo-1';

/** Seeds the read model's own cache entry rather than mocking the query
 *  hook, so the real hook, the real query key, and the real derivation all
 *  run - only the network is absent. */
function renderWithTranscripts(transcripts: TConversationTranscript[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData([QueryKeys.conversationTranscripts, CONVO_ID], { transcripts });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useConversationTranscriptionStatus(CONVO_ID), { wrapper });
}

const transcript = (overrides: Partial<TConversationTranscript>): TConversationTranscript => ({
  sourceFileId: 'source-1',
  displayName: 'standup.m4a',
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

describe('useConversationTranscriptionStatus', () => {
  it('reports nothing in flight for a conversation with no recordings', () => {
    const { result } = renderWithTranscripts([]);
    expect(result.current.isTranscribing).toBe(false);
    expect(result.current.nonTerminalSourceFileIds).toEqual([]);
  });

  it('reports nothing in flight when every recording has settled', () => {
    const { result } = renderWithTranscripts([
      transcript({ sourceFileId: 'a' }),
      transcript({ sourceFileId: 'b', jobStatus: 'failed', isQueryable: false }),
    ]);
    expect(result.current.isTranscribing).toBe(false);
  });

  it('reports an in-flight job and the file ids to cancel', () => {
    const { result } = renderWithTranscripts([
      transcript({ sourceFileId: 'done' }),
      transcript({ sourceFileId: 'running', jobStatus: 'transcribing', isQueryable: false }),
      transcript({ sourceFileId: 'waiting', jobStatus: 'queued', isQueryable: false }),
    ]);
    expect(result.current.isTranscribing).toBe(true);
    expect(result.current.nonTerminalSourceFileIds).toEqual(['running', 'waiting']);
  });

  it('does not treat a missing job record as in flight', () => {
    // Pre-migration source files carry no transcription job at all; showing
    // the composer a stop-square it could never satisfy would be worse than
    // showing nothing.
    const { result } = renderWithTranscripts([
      transcript({ sourceFileId: 'legacy', jobStatus: null, isQueryable: true }),
    ]);
    expect(result.current.isTranscribing).toBe(false);
  });
});
