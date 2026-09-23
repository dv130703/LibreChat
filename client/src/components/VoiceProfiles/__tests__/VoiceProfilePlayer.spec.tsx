import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import VoiceProfilePlayer from '../VoiceProfilePlayer';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/** jsdom implements neither `play()` nor `pause()` on media elements, so
 *  they are stubbed to record intent - what matters here is which element
 *  the component acts on, not real playback. */
let playSpy: jest.Mock;
let pauseSpy: jest.Mock;

beforeEach(() => {
  playSpy = jest.fn().mockResolvedValue(undefined);
  pauseSpy = jest.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: playSpy,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: pauseSpy,
  });
});

function getAudio(container: HTMLElement): HTMLAudioElement {
  return container.querySelector('audio') as HTMLAudioElement;
}

describe('VoiceProfilePlayer', () => {
  /** The point of the component: a native `<audio controls>` draws
   *  browser chrome that cannot be restyled, so the page looked unlike the
   *  rest of the app. The element must still be present (it does the actual
   *  playing) but must not be rendering its own controls. */
  it('renders app controls rather than the browser default player chrome', () => {
    const { container } = render(<VoiceProfilePlayer src="/clip.wav" />);

    expect(screen.getByLabelText('com_ui_voice_profile_play')).toBeInTheDocument();
    expect(getAudio(container).hasAttribute('controls')).toBe(false);
  });

  it('shows a m:ss readout, matching the transcript player', () => {
    render(<VoiceProfilePlayer src="/clip.wav" />);
    expect(screen.getByText('0:00 / 0:00')).toBeInTheDocument();
  });

  it('reflects the clip length once metadata loads', () => {
    const { container } = render(<VoiceProfilePlayer src="/clip.wav" />);
    const audio = getAudio(container);

    Object.defineProperty(audio, 'duration', { configurable: true, value: 62 });
    fireEvent.loadedMetadata(audio);

    expect(screen.getByText('0:00 / 1:02')).toBeInTheDocument();
  });

  it('swaps the label to pause while playing', () => {
    const { container } = render(<VoiceProfilePlayer src="/clip.wav" />);

    fireEvent.play(getAudio(container));

    expect(screen.getByLabelText('com_ui_voice_profile_pause')).toBeInTheDocument();
  });

  it('starts playback when the play control is pressed', () => {
    render(<VoiceProfilePlayer src="/clip.wav" />);

    fireEvent.click(screen.getByLabelText('com_ui_voice_profile_play'));

    expect(playSpy).toHaveBeenCalled();
  });

  /** Several profiles are listed at once; two clips playing over each other
   *  makes both unintelligible, so starting one stops the rest. */
  it('stops any other clip that is already playing', () => {
    const other = document.createElement('audio');
    document.body.appendChild(other);

    render(<VoiceProfilePlayer src="/clip.wav" />);
    fireEvent.click(screen.getByLabelText('com_ui_voice_profile_play'));

    expect(pauseSpy).toHaveBeenCalled();
    other.remove();
  });
});
