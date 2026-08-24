/** How an encoded file's size is predicted from the source's properties. */
export type FormatSizing =
  // Uncompressed 16-bit PCM: sample rate x channels x 2 bytes.
  | { kind: 'pcm' }
  // Lossless compression, expressed as a fraction of the equivalent PCM size.
  | { kind: 'ratio'; ofPcm: number }
  // Constant (or near-constant) bitrate, in kilobits per second.
  | { kind: 'cbr'; kbps: number }

export interface AudioFormat {
  id: string
  label: string
  extension: string
  mimeType: string
  /** What the file actually is once encoded, shown under the format's name. */
  codec: string
  /** The same codec squeezed into the output rail's narrow comparison column. */
  shortCodec: string
  /**
   * Three or four words on why you'd take this one over its neighbours. Sits
   * beside the chosen format's name, where `fidelityLabel` is too blunt.
   */
  tag: string
  /**
   * Two sentences on the trade-off: what the encode does, then when to reach
   * for it. Only ever shown for the format currently picked, so it can afford
   * to say more than a table cell could.
   */
  detail: string
  /** Explains what the encode did to the audio; shown once a conversion lands. */
  note: string
  /** Badge beside the name - "Lossless", "Speech-safe". */
  fidelityLabel: string
  /** Set on the single format recommended for transcription. */
  recommended?: boolean
  /** True when the quoted bitrate is an average rather than a pinned rate. */
  approximateRate?: boolean
  /**
   * Encoder flags pinned onto the ffmpeg command. Without them ffmpeg picks its
   * own defaults and the sizes quoted on each row stop matching the file that
   * actually comes out of the conversion.
   */
  encoderArgs: string[]
  sizing: FormatSizing
}

export const AUDIO_FORMATS: AudioFormat[] = [
  {
    id: 'wav',
    label: 'WAV',
    extension: 'wav',
    mimeType: 'audio/wav',
    codec: 'PCM 16-bit',
    shortCodec: 'PCM 16-bit',
    tag: 'No compression',
    detail:
      'Nothing is compressed at all, so this is as large as the audio gets. Only worth it if something downstream insists on raw PCM.',
    note: 'Uncompressed PCM — nothing is thrown away in encoding, but the file gets large.',
    fidelityLabel: 'Lossless',
    encoderArgs: [],
    sizing: { kind: 'pcm' },
  },
  {
    id: 'flac',
    label: 'FLAC',
    extension: 'flac',
    mimeType: 'audio/flac',
    codec: 'FLAC lossless',
    shortCodec: 'FLAC',
    tag: 'Archival',
    detail:
      'Every sample preserved, at roughly two thirds of the size. Worth the upload if this recording is evidence you may need to re-process.',
    note: 'Compressed without loss — the decoded audio is identical to the file you uploaded.',
    fidelityLabel: 'Lossless',
    approximateRate: true,
    encoderArgs: [],
    // Speech at 44.1 kHz stereo typically lands near 60% of its PCM size.
    sizing: { kind: 'ratio', ofPcm: 0.61 },
  },
  {
    id: 'mp3',
    label: 'MP3',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
    codec: 'MPEG-1 Layer III',
    shortCodec: 'MPEG-1 L3',
    tag: 'Recommended',
    detail:
      'Small, and playable on anything you are likely to hand it to. The safe default for getting a recording transcribed.',
    note: 'Re-encoded at 128 kbps. Detail above 16 kHz is discarded; speech is unaffected.',
    fidelityLabel: 'Speech-safe',
    recommended: true,
    encoderArgs: ['-b:a', '128k'],
    sizing: { kind: 'cbr', kbps: 128 },
  },
  {
    id: 'm4a',
    label: 'M4A',
    extension: 'm4a',
    mimeType: 'audio/mp4',
    codec: 'AAC-LC / MP4',
    shortCodec: 'AAC-LC',
    tag: 'Apple-friendly',
    detail:
      'The same audio as AAC in the container Apple devices expect. Pick this one if the recording is heading to a Mac or an iPhone.',
    note: 'Re-encoded at 128 kbps AAC. Detail above 16 kHz is discarded; speech is unaffected.',
    fidelityLabel: 'Speech-safe',
    encoderArgs: ['-b:a', '128k'],
    sizing: { kind: 'cbr', kbps: 128 },
  },
  {
    id: 'aac',
    label: 'AAC',
    extension: 'aac',
    mimeType: 'audio/aac',
    codec: 'AAC-LC / ADTS',
    shortCodec: 'AAC-LC',
    tag: 'Clearest small file',
    detail:
      'Holds quiet speech together better than MP3 at the same size. A little less reliable on older hardware and car stereos.',
    note: 'Re-encoded at 128 kbps AAC. Detail above 16 kHz is discarded; speech is unaffected.',
    fidelityLabel: 'Speech-safe',
    encoderArgs: ['-b:a', '128k'],
    sizing: { kind: 'cbr', kbps: 128 },
  },
  {
    id: 'ogg',
    label: 'OGG',
    extension: 'ogg',
    mimeType: 'audio/ogg',
    codec: 'Vorbis / Ogg',
    shortCodec: 'Vorbis',
    tag: 'Smallest',
    detail:
      'The smallest file on this page, and open source. Excellent on speech, though a few older players and phones will refuse to open it.',
    note: 'Re-encoded with Vorbis. Detail above 16 kHz is discarded; speech is unaffected.',
    fidelityLabel: 'Speech-safe',
    approximateRate: true,
    // -q:a 3 is variable-rate, so the quoted 112 kbps is a typical average.
    encoderArgs: ['-q:a', '3'],
    sizing: { kind: 'cbr', kbps: 112 },
  },
]

/** True when the encode preserves every sample, as opposed to discarding detail. */
export function isLossless(format: AudioFormat): boolean {
  return format.sizing.kind !== 'cbr'
}

export function getAvailableTargetFormats(inputFileName: string): AudioFormat[] {
  const inputExtension = inputFileName.split('.').pop()?.toLowerCase()
  return AUDIO_FORMATS.filter((format) => format.extension !== inputExtension)
}

/** What is known about the uploaded file, as far as sizing the output goes. */
export interface SourceProperties {
  durationSeconds: number | null
  sampleRate: number | null
  channels: number | null
}

// Used when the source's own rate and channel count couldn't be read - only WAV
// exposes them cheaply. CD quality stereo is the common case and errs high, so
// the estimate overshoots rather than promising a file smaller than it lands.
const FALLBACK_SAMPLE_RATE = 44100
const FALLBACK_CHANNELS = 2
const PCM_BYTES_PER_SAMPLE = 2

function pcmBytesPerSecond(source: SourceProperties): number {
  const sampleRate = source.sampleRate ?? FALLBACK_SAMPLE_RATE
  const channels = source.channels ?? FALLBACK_CHANNELS
  return sampleRate * channels * PCM_BYTES_PER_SAMPLE
}

/**
 * Bytes the encoded file is expected to occupy, or null when the source's
 * duration is unknown and there is nothing to extrapolate from.
 */
export function estimateOutputBytes(format: AudioFormat, source: SourceProperties): number | null {
  const duration = source.durationSeconds
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null

  return ((estimateBitrateKbps(format, source) * 1000) / 8) * duration
}

/** Kilobits per second the encode is expected to run at. */
export function estimateBitrateKbps(format: AudioFormat, source: SourceProperties): number {
  switch (format.sizing.kind) {
    case 'pcm':
      return (pcmBytesPerSecond(source) * 8) / 1000
    case 'ratio':
      return (pcmBytesPerSecond(source) * 8 * format.sizing.ofPcm) / 1000
    case 'cbr':
      return format.sizing.kbps
  }
}
