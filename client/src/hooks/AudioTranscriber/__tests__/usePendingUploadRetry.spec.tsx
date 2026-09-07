import { RecoilRoot, MutableSnapshot, useRecoilValue } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import type { PendingTranscriptionUpload } from '~/store/families';
import { usePendingUploadRetry } from '../usePendingUploadRetry';
import store from '~/store';

const mockMutateAsync = jest.fn();

jest.mock('~/data-provider', () => ({
  useTranscribeAudioMutation: () => ({ mutateAsync: mockMutateAsync }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const mockRefetchQueries = jest.fn().mockResolvedValue(undefined);
const mockGetQueryData = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    refetchQueries: mockRefetchQueries,
    getQueryData: mockGetQueryData,
  }),
}));

const CONVO_ID = 'convo-1';

function makePending(
  overrides: Partial<PendingTranscriptionUpload> = {},
): PendingTranscriptionUpload {
  return {
    pendingId: 'pending-1',
    conversationId: CONVO_ID,
    filename: 'recording.mp3',
    file: new File(['x'], 'recording.mp3', { type: 'audio/mpeg' }),
    options: {},
    parentMessageId: Constants.NO_PARENT as string,
    isNewConversation: true,
    status: 'failed',
    errorMessage: 'boom',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderRetry(pending: PendingTranscriptionUpload) {
  const setPendingUploads = jest.fn();
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.conversationByIndex(0), {
      conversationId: CONVO_ID,
      endpoint: 'openAI',
      createdAt: '',
    } as never);
  };

  const { result } = renderHook(
    () => {
      const retry = usePendingUploadRetry(pending, setPendingUploads);
      const conversation = useRecoilValue(store.conversationByIndex(0));
      return { retry, conversation };
    },
    {
      wrapper: ({ children }) => (
        <RecoilRoot initializeState={initializeState}>
          <MemoryRouter initialEntries={['/c/' + CONVO_ID]}>{children}</MemoryRouter>
        </RecoilRoot>
      ),
    },
  );

  return { result, setPendingUploads };
}

describe(
  'usePendingUploadRetry - regression: retrying a failed upload from the transcript panel ' +
    '(not the composer) never updated the shared conversation atom from its placeholder shape ' +
    "to the real, server-confirmed one - the composer's own call site fixed this via " +
    '`onConversationRefreshed`, but this hook (shared by the panel and the message-list bubble, ' +
    "neither of which sit inside the composer's `ChatContext.Provider`) never got the same fix. " +
    'A conversation whose very first upload failed and only succeeded on retry stayed looking ' +
    'like an unsent draft forever, corrupting every ordinary `ask()` send afterward.',
  () => {
    it('merges the real conversation data into the shared atom once the retry succeeds', async () => {
      mockMutateAsync.mockResolvedValueOnce({
        sourceFile: { file_id: 'source-1', filename: 'recording.mp3' },
        messageId: 'message-1',
      });
      mockGetQueryData.mockReturnValueOnce({
        conversationId: CONVO_ID,
        endpoint: 'openAI',
        createdAt: '2024-01-01T00:00:00.000Z',
        title: 'recording.mp3',
      });

      const { result } = renderRetry(makePending());

      await act(async () => {
        result.current.retry();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.conversation).toMatchObject({
        conversationId: CONVO_ID,
        createdAt: '2024-01-01T00:00:00.000Z',
        title: 'recording.mp3',
      });
    });

    it('does not touch the conversation atom when the retry fails again', async () => {
      mockMutateAsync.mockRejectedValueOnce(new Error('still broken'));

      const { result, setPendingUploads } = renderRetry(makePending());

      await act(async () => {
        result.current.retry();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.conversation).toMatchObject({ createdAt: '' });
      expect(setPendingUploads).toHaveBeenCalled();
    });
  },
);
