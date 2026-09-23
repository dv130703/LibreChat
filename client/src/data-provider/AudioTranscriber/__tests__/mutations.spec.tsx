import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import { useRetryTranscriptionMutation, useCancelTranscriptionMutation } from '../mutations';

const mockRetryTranscription = jest.fn();
const mockCancelTranscription = jest.fn();

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    retryTranscription: (...args: unknown[]) => mockRetryTranscription(...args),
    cancelTranscription: (...args: unknown[]) => mockCancelTranscription(...args),
  },
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

let queryClient: QueryClient;
let invalidateSpy: jest.SpyInstance;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Every query key the mutation asked react-query to invalidate, flattened to
 *  its first element, so a bare-prefix invalidation and a
 *  `[key, conversationId]` one both register as covering that key. */
function invalidatedKeys(): string[] {
  return invalidateSpy.mock.calls.map((call) => (call[0] as unknown[])[0] as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
});

describe('useRetryTranscriptionMutation', () => {
  /**
   * The bug this pins: `TranscriptPanel` reads `jobStatus` from
   * `useConversationTranscriptsQuery`, NOT from `useTranscribeStatusQuery`,
   * and that query stops polling once a job reaches a terminal state
   * (`failed`, which is exactly what a cancel produces). So after cancelling
   * and then hitting Retry, nothing refetched the data the panel actually
   * renders from: the backend really did re-queue the job, but the UI sat on
   * the stale pre-retry snapshot instead of showing queued/transcribing.
   * `useRetranscribeAudioMutation` already handled this; retry and cancel
   * did not.
   */
  it('invalidates conversationTranscripts so the panel reflects the re-queued job', async () => {
    mockRetryTranscription.mockResolvedValue({ status: 'queued' });
    const { result } = renderHook(() => useRetryTranscriptionMutation(), { wrapper });

    await act(async () => {
      result.current.mutate({ sourceFileId: 'source-1' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedKeys()).toContain(QueryKeys.conversationTranscripts);
  });

  /** Without the optimistic patch, an invalidation alone leaves the stale
   *  `failed` state rendered for the whole refetch round-trip, so the error
   *  panel and its Retry button visibly reappear right after being clicked.
   *  `unqueryableReason` is asserted alongside `jobStatus` because it is
   *  what `useConversationTranscriptsQuery`'s `refetchInterval` gates on -
   *  without it the 3s poll would not re-arm. */
  it('immediately patches the cached record to queued, with polling re-armed', async () => {
    mockRetryTranscription.mockResolvedValue({ status: 'queued' });
    queryClient.setQueryData([QueryKeys.conversationTranscripts, 'convo-1'], {
      transcripts: [
        {
          sourceFileId: 'source-1',
          displayName: 'recording.mp3',
          transcriptFileId: null,
          diarizationDetailFileId: null,
          jobStatus: 'failed',
          jobError: 'Cancelled by user',
          cancelled: true,
          indexStatus: null,
          isQueryable: false,
          unqueryableReason: 'job_failed',
        },
        {
          sourceFileId: 'source-2',
          displayName: 'other.mp3',
          transcriptFileId: 't-2',
          diarizationDetailFileId: null,
          jobStatus: 'ready',
          jobError: null,
          cancelled: false,
          indexStatus: 'indexed',
          isQueryable: true,
          unqueryableReason: null,
        },
      ],
    });

    const { result } = renderHook(() => useRetryTranscriptionMutation(), { wrapper });
    await act(async () => {
      result.current.mutate({ sourceFileId: 'source-1' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const patched = queryClient.getQueryData([QueryKeys.conversationTranscripts, 'convo-1']) as {
      transcripts: Array<Record<string, unknown>>;
    };
    const retried = patched.transcripts.find((t) => t.sourceFileId === 'source-1');
    expect(retried).toMatchObject({
      jobStatus: 'queued',
      jobError: null,
      cancelled: false,
      unqueryableReason: 'in_progress',
    });

    // Unrelated recordings on the same conversation must be left alone.
    expect(patched.transcripts.find((t) => t.sourceFileId === 'source-2')).toMatchObject({
      jobStatus: 'ready',
      unqueryableReason: null,
    });
  });

  it('still invalidates transcribeStatus for the batched card polls', async () => {
    mockRetryTranscription.mockResolvedValue({ status: 'queued' });
    const { result } = renderHook(() => useRetryTranscriptionMutation(), { wrapper });

    await act(async () => {
      result.current.mutate({ sourceFileId: 'source-1' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedKeys()).toContain(QueryKeys.transcribeStatus);
  });
});

describe('useCancelTranscriptionMutation', () => {
  it('invalidates conversationTranscripts so the panel shows the cancelled state', async () => {
    mockCancelTranscription.mockResolvedValue({ cancelled: true });
    const { result } = renderHook(() => useCancelTranscriptionMutation(), { wrapper });

    await act(async () => {
      result.current.mutate({ sourceFileId: 'source-1' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedKeys()).toContain(QueryKeys.conversationTranscripts);
  });

  it('refreshes the panel too when the job already finished (409)', async () => {
    mockCancelTranscription.mockRejectedValue({ response: { status: 409 } });
    const { result } = renderHook(() => useCancelTranscriptionMutation(), { wrapper });

    await act(async () => {
      result.current.mutate({ sourceFileId: 'source-1' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidatedKeys()).toContain(QueryKeys.conversationTranscripts);
  });
});
