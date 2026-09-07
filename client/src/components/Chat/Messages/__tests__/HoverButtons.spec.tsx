import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import HoverButtons from '../HoverButtons';

const mockRetryMutate = jest.fn();
let mockTranscribeStatusData: { files: Array<{ file_id: string; status: string }> } | undefined;

jest.mock('~/data-provider', () => ({
  useTranscribeStatusQuery: () => ({ data: mockTranscribeStatusData }),
  useRetryTranscriptionMutation: () => ({ mutate: mockRetryMutate, isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGenerationsByLatest: () => ({
    hideEditButton: true,
    regenerateEnabled: false,
    continueSupported: false,
    forkingSupported: false,
    isEditableEndpoint: false,
  }),
}));

jest.mock('~/components/Conversations', () => ({
  Fork: () => <div data-testid="fork-button" />,
}));

jest.mock('../MessageAudio', () => () => null);
jest.mock('../Feedback', () => () => null);

const conversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.custom,
} as TConversation;

const baseMessage = {
  messageId: 'message-1',
  isCreatedByUser: true,
  files: [{ file_id: 'source-file-1', type: 'audio/mpeg' }],
} as unknown as TMessage;

const defaultProps = {
  index: 0,
  isEditing: false,
  enterEdit: jest.fn(),
  copyToClipboard: jest.fn(),
  conversation,
  isSubmitting: false,
  regenerate: jest.fn(),
  handleContinue: jest.fn(),
  latestMessageId: undefined,
  isLast: true,
};

describe('HoverButtons - transcription retry icon', () => {
  beforeEach(() => {
    mockRetryMutate.mockClear();
    mockTranscribeStatusData = undefined;
  });

  it('shows no retry icon when the message has no audio/video files', () => {
    render(
      <RecoilRoot>
        <HoverButtons {...defaultProps} message={{ ...baseMessage, files: [] }} />
      </RecoilRoot>,
    );
    expect(screen.queryByTestId('retry-transcription-button')).not.toBeInTheDocument();
  });

  it('shows no retry icon when the file exists but has not failed', () => {
    mockTranscribeStatusData = { files: [{ file_id: 'source-file-1', status: 'transcribing' }] };
    render(
      <RecoilRoot>
        <HoverButtons {...defaultProps} message={baseMessage} />
      </RecoilRoot>,
    );
    expect(screen.queryByTestId('retry-transcription-button')).not.toBeInTheDocument();
  });

  it(
    "shows a retry icon alongside the message's other hover actions when its audio " +
      "file's transcription failed, and clicking it retries that exact file",
    () => {
      mockTranscribeStatusData = { files: [{ file_id: 'source-file-1', status: 'failed' }] };
      render(
        <RecoilRoot>
          <HoverButtons {...defaultProps} message={baseMessage} />
        </RecoilRoot>,
      );

      const retryButton = screen.getByTestId('retry-transcription-button');
      expect(retryButton).toBeInTheDocument();

      fireEvent.click(retryButton);
      expect(mockRetryMutate).toHaveBeenCalledWith({ sourceFileId: 'source-file-1' });
    },
  );
});
