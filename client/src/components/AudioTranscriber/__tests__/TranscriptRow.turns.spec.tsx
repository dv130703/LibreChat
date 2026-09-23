import React from 'react';
import { render, screen } from '@testing-library/react';
import TranscriptRow from '../TranscriptRow';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const baseProps = {
  isFollowed: false,
  isPreviewing: false,
  playbackRatio: 0,
  canPlay: true,
  speakerOptions: [{ id: 'Speaker 1', name: 'Speaker 1', dotColorClass: 'bg-blue-500' }],
  isAddingSpeaker: false,
  newSpeakerName: '',
  onPlaySegment: jest.fn(),
  onTextCommit: jest.fn(),
  onTimeCommit: jest.fn(),
  onSpeakerSelect: jest.fn(),
  onStartAddSpeaker: jest.fn(),
  onNewSpeakerNameChange: jest.fn(),
  onCommitNewSpeaker: jest.fn(),
  onCancelNewSpeaker: jest.fn(),
};

function renderRow(overrides: { isContinuation: boolean; isTurnEnd: boolean }) {
  const line = {
    lineIndex: 1,
    speaker: 'Speaker 1',
    text: 'hello there',
    seconds: 1,
    endSeconds: 2,
    timestamp: '00:00:01.000',
  };
  const { container } = render(<TranscriptRow line={line} {...baseProps} {...overrides} />);
  return container.querySelector('[data-line-index="1"]') as HTMLElement;
}

/** Exact class-token membership. Substring matching is unsafe here: the
 *  design token `border-border-light` contains "border-b", so a naive
 *  `toContain('border-b')` reports a bottom border on every row. */
function hasClass(element: HTMLElement, className: string): boolean {
  return element.className.split(/\s+/).includes(className);
}

/**
 * These assert the box EDGES, which is the whole mechanism: react-virtualized
 * positions each row absolutely, so a turn box cannot be one element wrapping
 * several rows. Consecutive rows instead draw only their own outer edges, and
 * a missing/extra border here is exactly what would make a turn render as
 * separate boxes (or a box that never closes).
 */
describe('TranscriptRow speaker-turn box edges', () => {
  it('draws a complete box for a single-line turn', () => {
    const row = renderRow({ isContinuation: false, isTurnEnd: true });
    expect(hasClass(row, 'border-t')).toBe(true);
    expect(hasClass(row, 'rounded-t-lg')).toBe(true);
    expect(hasClass(row, 'border-b')).toBe(true);
    expect(hasClass(row, 'rounded-b-lg')).toBe(true);
  });

  it("opens but does not close the box on a turn's first line", () => {
    const row = renderRow({ isContinuation: false, isTurnEnd: false });
    expect(hasClass(row, 'border-t')).toBe(true);
    expect(hasClass(row, 'border-b')).toBe(false);
    expect(hasClass(row, 'rounded-b-lg')).toBe(false);
  });

  it('draws no horizontal edges on a line in the middle of a turn', () => {
    const row = renderRow({ isContinuation: true, isTurnEnd: false });
    expect(hasClass(row, 'border-t')).toBe(false);
    expect(hasClass(row, 'border-b')).toBe(false);
    // Sides still drawn, so the box reads as continuous through this line.
    expect(hasClass(row, 'border-x')).toBe(true);
  });

  it("closes the box on a turn's last line", () => {
    const row = renderRow({ isContinuation: true, isTurnEnd: true });
    expect(hasClass(row, 'border-t')).toBe(false);
    expect(hasClass(row, 'border-b')).toBe(true);
    expect(hasClass(row, 'rounded-b-lg')).toBe(true);
  });

  it('keeps per-line controls mounted on continuation lines so editing still works', () => {
    renderRow({ isContinuation: true, isTurnEnd: false });
    // Reachable (hover/focus reveals it) rather than removed - a continuation
    // line must still be independently playable and reassignable.
    expect(screen.getByLabelText('com_ui_transcript_play_line_short')).toBeInTheDocument();
  });
});
