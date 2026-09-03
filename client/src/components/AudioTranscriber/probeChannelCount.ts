import { dataService } from 'librechat-data-provider';

/** Server-side channel count via `POST /api/transcribe/probe` (Phase 4,
 *  transcription/ARCHITECTURE.md §6.2) - replaces the old client-side Web
 *  Audio API decode/heuristic (size ceiling, browser codec gaps, and a
 *  "does this look like separate speakers" judgment that could mis-fire).
 *  `ffprobe` reads container metadata directly and is deterministic, but it
 *  only reports a channel count, not speaker-separation intent - so any
 *  file with more than one channel now surfaces the choice to the user
 *  instead of a heuristic guessing on their behalf. `null` means the probe
 *  itself failed (network error, etc.), treated the same as "single
 *  channel" - the dialog only ever shows on a confirmed count.
 */
export async function probeChannelCount(file: File): Promise<number | null> {
  try {
    const formData = new FormData();
    formData.append('file', file);
    const { channelCount } = await dataService.probeAudioChannels(formData);
    return channelCount;
  } catch {
    return null;
  }
}
