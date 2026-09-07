/* eslint-disable i18next/no-literal-string */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TranscribeIntentProvider, useTranscribeIntent } from '../TranscribeIntentContext';
import type { TranscribeIntentResult } from '../TranscribeIntentContext';

const mockProbeChannelCount = jest.fn<Promise<number | null>, [File]>();
jest.mock('~/components/AudioTranscriber/probeChannelCount', () => ({
  probeChannelCount: (file: File) => mockProbeChannelCount(file),
}));

// `MultiChannelDialog`/`TranscribeOptionsDialog` are pre-existing, unchanged
// components with their own real UI (speaker settings, channel-split copy) -
// what this suite cares about is `TranscribeIntentProvider`'s orchestration
// across them (stage sequencing, promise resolution, cancel-vs-choice
// disambiguation), not their internals, so they're stood in with minimal
// stubs that expose their real callback contract - same approach as
// `ChatPanelHost.spec.tsx`'s `TranscriptPanel` stub.
jest.mock('~/components/AudioTranscriber/MultiChannelDialog', () => {
  function MockMultiChannelDialog({
    channelCount,
    onAccept,
    onDecline,
  }: {
    channelCount: number;
    onAccept: () => void;
    onDecline: () => void;
  }) {
    return (
      <div data-testid="multi-channel-dialog">
        <span>channels: {channelCount}</span>
        <button onClick={onAccept}>split-by-channel</button>
        <button onClick={onDecline}>auto-detect</button>
      </div>
    );
  }
  return { __esModule: true, default: MockMultiChannelDialog };
});

jest.mock('~/components/AudioTranscriber/TranscribeOptionsDialog', () => {
  function MockTranscribeOptionsDialog({
    channelSplitEnabled,
    onConfirm,
  }: {
    channelSplitEnabled: boolean;
    onConfirm: (options: { diarize: boolean; includeTimestamps: boolean }) => void;
  }) {
    return (
      <div data-testid="options-dialog">
        <span>channelSplitEnabled: {String(channelSplitEnabled)}</span>
        <button onClick={() => onConfirm({ diarize: true, includeTimestamps: true })}>
          confirm-options
        </button>
      </div>
    );
  }
  return { __esModule: true, default: MockTranscribeOptionsDialog };
});

function Harness({ onResult }: { onResult: (result: TranscribeIntentResult) => void }) {
  const { interceptAudioVideo } = useTranscribeIntent();
  return (
    <div>
      <button
        onClick={() => {
          void interceptAudioVideo(
            new File(['x'], 'recording.mp3', { type: 'audio/mpeg' }),
            true,
          ).then(onResult);
        }}
      >
        intercept-can-attach
      </button>
      <button
        onClick={() => {
          void interceptAudioVideo(
            new File(['x'], 'recording.mp3', { type: 'audio/mpeg' }),
            false,
          ).then(onResult);
        }}
      >
        intercept-cannot-attach
      </button>
    </div>
  );
}

function renderProvider(onResult: (result: TranscribeIntentResult) => void) {
  return render(
    <TranscribeIntentProvider>
      <Harness onResult={onResult} />
    </TranscribeIntentProvider>,
  );
}

describe('TranscribeIntentProvider (transcription/ARCHITECTURE.md §6.1/§6.4, Phase 4)', () => {
  beforeEach(() => {
    mockProbeChannelCount.mockReset();
    mockProbeChannelCount.mockResolvedValue(1);
  });

  it('resolves "attach" immediately when the user declines transcription', async () => {
    const onResult = jest.fn();
    renderProvider(onResult);

    fireEvent.click(screen.getByText('intercept-can-attach'));
    expect(await screen.findByText(/Transcribe this recording/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Attach as file'));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ action: 'attach' }));
    expect(screen.queryByText(/Transcribe this recording/)).not.toBeInTheDocument();
  });

  it('goes straight to the options dialog when the endpoint cannot attach natively', async () => {
    const onResult = jest.fn();
    renderProvider(onResult);

    fireEvent.click(screen.getByText('intercept-cannot-attach'));

    expect(mockProbeChannelCount).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Transcribe this recording/)).not.toBeInTheDocument();
    await screen.findByTestId('options-dialog');
  });

  it('single-channel: skips the multi-channel dialog and resolves "transcribe" with the confirmed options', async () => {
    mockProbeChannelCount.mockResolvedValue(1);
    const onResult = jest.fn();
    renderProvider(onResult);

    fireEvent.click(screen.getByText('intercept-can-attach'));
    fireEvent.click(await screen.findByText('Transcribe'));

    await screen.findByTestId('options-dialog');
    expect(screen.queryByTestId('multi-channel-dialog')).not.toBeInTheDocument();
    expect(screen.getByText('channelSplitEnabled: false')).toBeInTheDocument();

    fireEvent.click(screen.getByText('confirm-options'));

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        action: 'transcribe',
        options: { diarize: true, includeTimestamps: true, channelSplit: false },
      }),
    );
  });

  it('stereo (2 channels): skips the multi-channel dialog, since 2 channels commonly means stereo rather than one speaker per channel', async () => {
    mockProbeChannelCount.mockResolvedValue(2);
    const onResult = jest.fn();
    renderProvider(onResult);

    fireEvent.click(screen.getByText('intercept-can-attach'));
    fireEvent.click(await screen.findByText('Transcribe'));

    await screen.findByTestId('options-dialog');
    expect(screen.queryByTestId('multi-channel-dialog')).not.toBeInTheDocument();
    expect(screen.getByText('channelSplitEnabled: false')).toBeInTheDocument();
  });

  it('multi-channel: offers the split choice, and carries the choice into the options dialog', async () => {
    mockProbeChannelCount.mockResolvedValue(3);
    const onResult = jest.fn();
    renderProvider(onResult);

    fireEvent.click(screen.getByText('intercept-can-attach'));
    fireEvent.click(await screen.findByText('Transcribe'));

    await screen.findByTestId('multi-channel-dialog');
    fireEvent.click(screen.getByText('split-by-channel'));

    await screen.findByTestId('options-dialog');
    expect(screen.getByText('channelSplitEnabled: true')).toBeInTheDocument();

    fireEvent.click(screen.getByText('confirm-options'));

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'transcribe',
          options: expect.objectContaining({ channelSplit: true }),
        }),
      ),
    );
  });

  it('dismissing the intent dialog without a choice resolves "cancel"', async () => {
    const onResult = jest.fn();
    renderProvider(onResult);

    fireEvent.click(screen.getByText('intercept-can-attach'));
    await screen.findByText(/Transcribe this recording/);

    // Escape dismisses via Radix without either button handler running.
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
        code: 'Escape',
      });
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ action: 'cancel' }));
  });
});
