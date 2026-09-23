import { formatPlayerTime, seekRatioFromClick } from '../playerTime';

describe('formatPlayerTime', () => {
  it('formats seconds as m:ss', () => {
    expect(formatPlayerTime(0)).toBe('0:00');
    expect(formatPlayerTime(7)).toBe('0:07');
    expect(formatPlayerTime(62)).toBe('1:02');
    expect(formatPlayerTime(600)).toBe('10:00');
  });

  /** A voice sample whose duration hasn't loaded yet reports NaN/Infinity -
   *  the player must show a placeholder rather than "NaN:aN". */
  it('falls back to 0:00 for values that are not finite numbers', () => {
    expect(formatPlayerTime(Number.NaN)).toBe('0:00');
    expect(formatPlayerTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatPlayerTime(-5)).toBe('0:00');
  });
});

describe('seekRatioFromClick', () => {
  it('maps a click to its horizontal position within the track', () => {
    expect(seekRatioFromClick(50, { left: 0, width: 100 })).toBeCloseTo(0.5);
    expect(seekRatioFromClick(0, { left: 0, width: 100 })).toBeCloseTo(0);
    expect(seekRatioFromClick(100, { left: 0, width: 100 })).toBeCloseTo(1);
  });

  it('accounts for the track not starting at the viewport edge', () => {
    expect(seekRatioFromClick(150, { left: 100, width: 200 })).toBeCloseTo(0.25);
  });

  /** Dragging past either end of the track must clamp, not seek outside the
   *  clip (which would throw on `currentTime`). */
  it('clamps a click outside the track to the track', () => {
    expect(seekRatioFromClick(-20, { left: 0, width: 100 })).toBe(0);
    expect(seekRatioFromClick(250, { left: 0, width: 100 })).toBe(1);
  });

  it('returns 0 for a zero-width track rather than dividing by zero', () => {
    expect(seekRatioFromClick(10, { left: 0, width: 0 })).toBe(0);
  });
});
