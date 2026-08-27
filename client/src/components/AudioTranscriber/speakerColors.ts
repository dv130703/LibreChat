/** Distinct, consistent per-speaker dot color, assigned by order of first
 *  appearance and wrapping after ten. Returned as a solid `bg-*` class for a
 *  small swatch dot - the chip/row it sits in stays a neutral LibreChat
 *  surface color, so only the dot itself carries the per-speaker hue. */
const SPEAKER_DOT_CLASSES = [
  'bg-blue-600 dark:bg-blue-400',
  'bg-teal-600 dark:bg-teal-400',
  'bg-green-600 dark:bg-green-400',
  'bg-purple-600 dark:bg-purple-400',
  'bg-rose-600 dark:bg-rose-400',
  'bg-amber-700 dark:bg-amber-500',
  'bg-sky-600 dark:bg-sky-400',
  'bg-lime-600 dark:bg-lime-500',
  'bg-fuchsia-600 dark:bg-fuchsia-400',
  'bg-pink-400 dark:bg-pink-300',
] as const;

export function getSpeakerDotColor(orderIndex: number): string {
  return SPEAKER_DOT_CLASSES[orderIndex % SPEAKER_DOT_CLASSES.length];
}
