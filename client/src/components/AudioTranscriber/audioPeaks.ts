/** One shared `AudioContext` for the whole feature, not one per decode - most
 *  browsers cap how many a page may create, and nothing here needs more than
 *  one at a time. */
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

/** Downsamples a decoded audio buffer's first channel into `bucketCount` true
 *  peaks (max sample magnitude per bucket, 0-1, loudest bucket normalized to
 *  1) for a compact waveform visualization - a real reading of the actual
 *  recording, not a placeholder shape. `url` is expected to be a same-origin
 *  `blob:` URL (the file's already-downloaded audio), so this is a local
 *  decode, not a second network fetch.
 *
 *  Peak, not RMS: each bucket here can span several seconds on a long
 *  recording, and averaging that much audio's energy (RMS) smooths pauses
 *  and transients into a near-flat line - the loudest single sample in the
 *  window is what an actual waveform display (Audacity, DAWs, etc.) shows,
 *  and it's what keeps real silence looking like silence. */
export async function computeAudioPeaks(url: string, bucketCount: number): Promise<number[]> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBucket = Math.max(1, Math.floor(channelData.length / bucketCount));

  const peaks: number[] = new Array(bucketCount).fill(0);
  let loudest = 0;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucket * samplesPerBucket;
    const end = Math.min(channelData.length, start + samplesPerBucket);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const magnitude = Math.abs(channelData[i]);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    peaks[bucket] = peak;
    loudest = Math.max(loudest, peak);
  }

  return loudest > 0 ? peaks.map((value) => value / loudest) : peaks;
}
