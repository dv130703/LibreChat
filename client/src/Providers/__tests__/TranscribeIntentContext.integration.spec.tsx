/* eslint-disable i18next/no-literal-string */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TranscribeIntentProvider, useTranscribeIntent } from '../TranscribeIntentContext';
import type { TranscribeIntentResult } from '../TranscribeIntentContext';

const mockProbeChannelCount = jest.fn<Promise<number | null>, [File]>();
jest.mock('~/components/AudioTranscriber/probeChannelCount', () => ({
  probeChannelCount: (file: File) => mockProbeChannelCount(file),
}));

jest.mock('~/data-provider', () => ({
  useTranscribeConfigQuery: () => ({ data: undefined }),
}));

function Harness({ onResult }: { onResult: (result: TranscribeIntentResult) => void }) {
  const { interceptAudioVideo } = useTranscribeIntent();
  return (
    <button
      onClick={() => {
        void interceptAudioVideo(
          new File(['x'], 'recording.mp3', { type: 'audio/mpeg' }),
          true,
        ).then(onResult);
      }}
    >
      intercept
    </button>
  );
}

function renderHarness(onResult: (result: TranscribeIntentResult) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TranscribeIntentProvider>
        <Harness onResult={onResult} />
      </TranscribeIntentProvider>
    </QueryClientProvider>,
  );
}

/**
 * Exercises the REAL `MultiChannelDialog`/`TranscribeOptionsDialog` (not the
 * stand-ins `TranscribeIntentContext.spec.tsx` uses) - that suite verifies
 * the provider's own stage-sequencing logic in isolation, but the actual
 * production bug (transcription/ARCHITECTURE.md's post-Phase-5 hotfix log)
 * only showed up with the real, stacked Radix dialogs: `openStage` reset
 * `choiceMadeRef` synchronously, racing the dialog-being-replaced's own
 * `onOpenChange(false)` teardown call and silently resolving `cancel` right
 * after a real "Yes, use channels" click. A suite built entirely on
 * mocked dialogs (simple stand-in `<div>`s, no real open/close lifecycle)
 * structurally cannot catch that class of bug - this suite exists
 * specifically to keep that gap covered.
 */
describe('TranscribeIntentProvider with real dialogs (stage-swap regression coverage)', () => {
  beforeEach(() => {
    mockProbeChannelCount.mockReset();
  });

  it('multi-channel accept -> real options dialog -> confirm actually resolves "transcribe"', async () => {
    mockProbeChannelCount.mockResolvedValue(2);
    const onResult = jest.fn();
    renderHarness(onResult);

    fireEvent.click(screen.getByText('intercept'));
    fireEvent.click(await screen.findByText('Transcribe'));
    fireEvent.click(await screen.findByText('Yes, use channels'));

    await screen.findByText('Transcription Options');
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(await screen.findByText('Start Transcription'));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(onResult.mock.calls[0][0]).toMatchObject({ action: 'transcribe' });
    expect(screen.queryByText('Transcription Options')).not.toBeInTheDocument();
  });

  it('multi-channel decline -> real options dialog -> confirm resolves "transcribe" without channel split', async () => {
    mockProbeChannelCount.mockResolvedValue(2);
    const onResult = jest.fn();
    renderHarness(onResult);

    fireEvent.click(screen.getByText('intercept'));
    fireEvent.click(await screen.findByText('Transcribe'));
    fireEvent.click(await screen.findByText('No, auto-detect'));

    await screen.findByText('Transcription Options');
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(await screen.findByText('Start Transcription'));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(onResult.mock.calls[0][0]).toMatchObject({
      action: 'transcribe',
      options: expect.objectContaining({ channelSplit: false }),
    });
  });

  it('single-channel: skips the multi-channel dialog, real options dialog resolves "transcribe" directly', async () => {
    mockProbeChannelCount.mockResolvedValue(1);
    const onResult = jest.fn();
    renderHarness(onResult);

    fireEvent.click(screen.getByText('intercept'));
    fireEvent.click(await screen.findByText('Transcribe'));

    await screen.findByText('Transcription Options');
    expect(screen.queryByText('Split speakers by channel?')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(await screen.findByText('Start Transcription'));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(onResult.mock.calls[0][0]).toMatchObject({ action: 'transcribe' });
  });

  it('declining the initial intent dialog resolves "attach" without probing channels at all', async () => {
    const onResult = jest.fn();
    renderHarness(onResult);

    fireEvent.click(screen.getByText('intercept'));
    fireEvent.click(await screen.findByText('Attach as file'));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ action: 'attach' }));
    expect(mockProbeChannelCount).not.toHaveBeenCalled();
    expect(screen.queryByText('Transcribe this recording?')).not.toBeInTheDocument();
  });

  it('dismissing the real options dialog mid-flow (Escape) resolves "cancel", not a hang or a false "transcribe"', async () => {
    mockProbeChannelCount.mockResolvedValue(1);
    const onResult = jest.fn();
    renderHarness(onResult);

    fireEvent.click(screen.getByText('intercept'));
    fireEvent.click(await screen.findByText('Transcribe'));
    await screen.findByText('Transcription Options');

    // Radix dismisses the dialog on Escape without either of its own
    // buttons ever being clicked - the same "no explicit choice was made"
    // path the stage-swap race used to mishandle, but this time for a
    // genuine dismiss rather than a real choice being made right before it.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
      code: 'Escape',
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ action: 'cancel' }));
    expect(screen.queryByText('Transcription Options')).not.toBeInTheDocument();
  });
});
