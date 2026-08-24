/**
 * The hue a speaker is drawn in, by speaking order and wrapping after ten -
 * the most speakers a diarization hint can ask for (see SPEAKER_CHOICES).
 * Returned as a `var(...)` string rather than a class so a dot can be tinted
 * without the surrounding chip or row picking up a background too.
 */
export function speakerColor(speaker: string, uniqueSpeakers: string[]): string {
  const index = uniqueSpeakers.indexOf(speaker)
  return `var(--color-speaker-${((index < 0 ? 0 : index) % 10) + 1})`
}
