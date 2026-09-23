/** `m:ss`, matching the transcript player's own time readout so the two
 *  players read identically. Guards non-finite input because an `<audio>`
 *  element reports `NaN` duration until metadata loads, and `Infinity` for
 *  a stream of unknown length - neither should surface as "NaN:aN". */
export function formatPlayerTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0:00';
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Where along a seek track a pointer landed, as 0-1. Clamped, because a
 *  drag can continue past either end of the track and assigning an
 *  out-of-range `currentTime` throws. */
export function seekRatioFromClick(
  clientX: number,
  track: { left: number; width: number },
): number {
  if (track.width <= 0) {
    return 0;
  }
  const ratio = (clientX - track.left) / track.width;
  return Math.min(1, Math.max(0, ratio));
}
