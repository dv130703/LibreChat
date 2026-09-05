import { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TranscriptHeader from '../TranscriptHeader';

const mockLocalize = jest.fn((key: string) => key);
jest.mock('~/hooks/useLocalize', () => () => mockLocalize);

jest.mock('../audioPeaks', () => ({
  computeAudioPeaks: jest.fn().mockResolvedValue(new Array(120).fill(0.5)),
}));

/**
 * Covers the recoverable error/retry state added alongside the direct-
 * streaming rework (transcription/ARCHITECTURE.md §12 #13) - before this,
 * `!audioSrc` unconditionally rendered `null` regardless of *why* there was
 * no src, which is what made a failed fetch (the old blob-download
 * approach's `retry: false`, `staleTime: Infinity`) permanently disappear
 * the whole player with no way back. `hasError` is the one thing that
 * distinguishes "still loading, nothing to show yet" (still `null`, same as
 * before) from "this failed and needs a visible way to retry."
 */
describe('TranscriptHeader', () => {
  beforeEach(() => {
    mockLocalize.mockClear();
  });

  it('renders nothing while a src is simply not resolved yet (no error)', () => {
    const { container } = render(
      <TranscriptHeader
        audioSrc={undefined}
        audioRef={createRef()}
        onUnboundedPlaybackRequested={jest.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a retry affordance instead of vanishing once loading the audio has definitively failed', () => {
    const onRetry = jest.fn();
    render(
      <TranscriptHeader
        audioSrc={undefined}
        audioRef={createRef()}
        hasError
        onRetry={onRetry}
        onUnboundedPlaybackRequested={jest.fn()}
      />,
    );

    expect(screen.getByText('com_ui_transcript_audio_error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('com_ui_retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the real player, pointed at audioSrc, once a src is available', () => {
    const { container } = render(
      <TranscriptHeader
        audioSrc="/api/transcribe/source-1/audio?token=abc"
        audioRef={createRef()}
        onUnboundedPlaybackRequested={jest.fn()}
      />,
    );
    const audioEl = container.querySelector('audio');
    expect(audioEl).not.toBeNull();
    expect(audioEl?.getAttribute('src')).toBe('/api/transcribe/source-1/audio?token=abc');
  });
});
