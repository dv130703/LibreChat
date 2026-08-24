import { isVideoFile } from './mediaType'

/**
 * What could be read from the uploaded file itself, rather than guessed from
 * its extension. Every field is nullable: browsers expose very little about a
 * media file without decoding it, so the intake page hides what it can't know
 * instead of inventing it.
 */
export interface MediaProbe {
  durationSeconds: number | null
  sampleRate: number | null
  channels: number | null
  bitDepth: number | null
  /** Normalised 0..1 peak per waveform bar, or null when no waveform was read. */
  peaks: number[] | null
}

export const EMPTY_PROBE: MediaProbe = {
  durationSeconds: null,
  sampleRate: null,
  channels: null,
  bitDepth: null,
  peaks: null,
}

// Few enough that every bar is a few pixels wide in the file rail - a denser
// strip reads as noise at this size rather than as an envelope.
export const WAVE_BARS = 56

// Frames read per bar when sampling a WAV directly. The peak of a ~12ms window
// tracks the envelope closely enough at this bar width.
const PEAK_WINDOW_FRAMES = 512

// A RIFF header sits in the first few hundred bytes, but files carrying LIST or
// broadcast-extension chunks push the `data` chunk further back.
const HEADER_SCAN_BYTES = 64 * 1024

// decodeAudioData expands the whole file into 32-bit floats - roughly 350 MB for
// an hour of 44.1 kHz stereo. Past these limits the waveform isn't worth the
// allocation, so the strip renders empty rather than risking the tab.
const DECODE_MAX_BYTES = 120 * 1024 * 1024
const DECODE_MAX_SECONDS = 20 * 60

const DURATION_TIMEOUT_MS = 15000

/* ---------------------------------------------------------------------- */
/* WAV                                                                     */
/* ---------------------------------------------------------------------- */

interface WavLayout {
  sampleRate: number
  channels: number
  bitDepth: number
  isFloat: boolean
  blockAlign: number
  dataOffset: number
  dataBytes: number
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}

function looksLikeWav(file: File): boolean {
  return file.name.split('.').pop()?.toLowerCase() === 'wav' || file.type === 'audio/wav' || file.type === 'audio/wave'
}

/**
 * Walks the RIFF chunk list for the `fmt ` and `data` headers. WAV is the one
 * format that states its own sample rate and channel count in plain bytes, and
 * it's also the format that produces the huge files - so reading it directly
 * avoids decoding hundreds of megabytes just to label the file.
 */
async function readWavLayout(file: File): Promise<WavLayout | null> {
  const head = new DataView(await file.slice(0, Math.min(HEADER_SCAN_BYTES, file.size)).arrayBuffer())
  if (head.byteLength < 12) return null
  if (ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 4) !== 'WAVE') return null

  let format: Omit<WavLayout, 'dataOffset' | 'dataBytes'> | null = null
  let cursor = 12

  while (cursor + 8 <= head.byteLength) {
    const id = ascii(head, cursor, 4)
    const size = head.getUint32(cursor + 4, true)
    const body = cursor + 8

    if (id === 'fmt ' && body + 16 <= head.byteLength) {
      const tag = head.getUint16(body, true)
      const channels = head.getUint16(body + 2, true)
      const bitDepth = head.getUint16(body + 14, true)
      format = {
        channels,
        sampleRate: head.getUint32(body + 4, true),
        blockAlign: head.getUint16(body + 12, true) || (bitDepth / 8) * channels,
        bitDepth,
        // WAVE_FORMAT_EXTENSIBLE (0xFFFE) carries the real tag as the first two
        // bytes of the sub-format GUID in its extension block.
        isFloat:
          tag === 3 || (tag === 0xfffe && body + 26 <= head.byteLength && head.getUint16(body + 24, true) === 3),
      }
    }

    if (id === 'data') {
      if (!format || format.blockAlign <= 0 || format.sampleRate <= 0) return null
      const available = file.size - body
      // Streamed WAVs sometimes declare a placeholder length; trust the file.
      const dataBytes = size > 0 ? Math.min(size, available) : available
      if (dataBytes <= 0) return null
      return { ...format, dataOffset: body, dataBytes }
    }

    // RIFF chunks are word-aligned, so odd-sized bodies carry a pad byte.
    cursor = body + size + (size % 2)
  }

  return null
}

function readSample(view: DataView, offset: number, bitDepth: number, isFloat: boolean): number {
  if (isFloat) return bitDepth === 64 ? view.getFloat64(offset, true) : view.getFloat32(offset, true)
  switch (bitDepth) {
    case 8:
      // 8-bit PCM is unsigned, centred on 128.
      return (view.getUint8(offset) - 128) / 128
    case 16:
      return view.getInt16(offset, true) / 32768
    case 24: {
      const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16)
      return raw / 8388608
    }
    case 32:
      return view.getInt32(offset, true) / 2147483648
    default:
      return 0
  }
}

/**
 * Reads one small window of samples per bar, spread evenly across the file.
 * A few hundred kilobytes total, regardless of how long the recording is.
 */
async function readWavPeaks(file: File, layout: WavLayout, bars: number): Promise<number[] | null> {
  const bytesPerSample = layout.bitDepth / 8
  if (!Number.isFinite(bytesPerSample) || bytesPerSample <= 0) return null

  const totalFrames = Math.floor(layout.dataBytes / layout.blockAlign)
  if (totalFrames <= 0) return null

  const windows = await Promise.all(
    Array.from({ length: bars }, (_, index) => {
      const frame = Math.floor((index / bars) * totalFrames)
      const frames = Math.max(1, Math.min(PEAK_WINDOW_FRAMES, totalFrames - frame))
      const start = layout.dataOffset + frame * layout.blockAlign
      return file.slice(start, start + frames * layout.blockAlign).arrayBuffer()
    }),
  )

  // Only the first channel is sampled - stepping by blockAlign skips the rest.
  return windows.map((buffer) => {
    const view = new DataView(buffer)
    let peak = 0
    for (let offset = 0; offset + bytesPerSample <= view.byteLength; offset += layout.blockAlign) {
      peak = Math.max(peak, Math.abs(readSample(view, offset, layout.bitDepth, layout.isFloat)))
    }
    return peak
  })
}

/* ---------------------------------------------------------------------- */
/* Everything else                                                         */
/* ---------------------------------------------------------------------- */

/** Duration via a throwaway media element - the one cheap fact for any format. */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const element = document.createElement(isVideoFile(file) ? 'video' : 'audio') as HTMLMediaElement
    let settled = false

    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      element.removeAttribute('src')
      element.load()
      URL.revokeObjectURL(url)
      resolve(value)
    }

    // Some containers never fire either event (unsupported codec, truncated
    // file), which would otherwise leave the intake page probing forever.
    const timer = setTimeout(() => finish(null), DURATION_TIMEOUT_MS)

    element.preload = 'metadata'
    element.onloadedmetadata = () => finish(Number.isFinite(element.duration) ? element.duration : null)
    element.onerror = () => finish(null)
    element.src = url
  })
}

function bucketPeaks(samples: Float32Array, bars: number): number[] {
  const perBar = samples.length / bars
  const peaks: number[] = []

  for (let index = 0; index < bars; index++) {
    const start = Math.floor(index * perBar)
    const end = Math.min(samples.length, Math.floor((index + 1) * perBar))
    // Long buckets are sampled rather than scanned end to end; a few hundred
    // reads per bar track the envelope indistinguishably at this size.
    const step = Math.max(1, Math.floor((end - start) / 400))
    let peak = 0
    for (let cursor = start; cursor < end; cursor += step) peak = Math.max(peak, Math.abs(samples[cursor]))
    peaks.push(peak)
  }

  return peaks
}

interface DecodedProbe {
  durationSeconds: number
  channels: number
  peaks: number[]
}

async function decodeProbe(file: File, bars: number): Promise<DecodedProbe | null> {
  const AudioContextCtor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null

  const context = new AudioContextCtor()
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer())
    // buffer.sampleRate is the *context's* rate - decodeAudioData resamples - so
    // it says nothing about the source file and is deliberately not reported.
    return {
      durationSeconds: buffer.duration,
      channels: buffer.numberOfChannels,
      peaks: bucketPeaks(buffer.getChannelData(0), bars),
    }
  } catch {
    return null
  } finally {
    void context.close()
  }
}

// Referencing the loudest bar lets a single transient - a door, a cough, one
// clipped consonant - flatten the entire rest of the recording into a hairline.
// A high percentile is the level the recording actually sits at, and the few
// bars above it simply clip to full height.
const REFERENCE_PERCENTILE = 0.95

// Below 1 this lifts the quiet middle of the range into visible territory, the
// way a meter's scale does, without touching the loud end.
const CURVE = 0.7

/**
 * Scales peaks so the recording's working level - not its single loudest
 * sample - reaches full height, then softens the curve so speech at a
 * conversational level still reads as a shape rather than a flat line.
 */
function normalise(peaks: number[]): number[] {
  const sounded = peaks.filter((peak) => peak > 0).sort((a, b) => a - b)
  if (sounded.length === 0) return peaks.map(() => 0)

  const reference = sounded[Math.min(sounded.length - 1, Math.floor(sounded.length * REFERENCE_PERCENTILE))]
  if (reference <= 0) return peaks.map(() => 0)

  return peaks.map((peak) => Math.min(1, peak / reference) ** CURVE)
}

/**
 * Reads what it can about the uploaded file. Never rejects - an unreadable file
 * comes back as a probe full of nulls, and the page renders around the gaps.
 */
export async function probeMedia(file: File, bars: number = WAVE_BARS): Promise<MediaProbe> {
  if (looksLikeWav(file)) {
    const layout = await readWavLayout(file).catch(() => null)
    if (layout) {
      const bytesPerSecond = layout.blockAlign * layout.sampleRate
      const peaks = await readWavPeaks(file, layout, bars).catch(() => null)
      return {
        durationSeconds: bytesPerSecond > 0 ? layout.dataBytes / bytesPerSecond : null,
        sampleRate: layout.sampleRate,
        channels: layout.channels,
        bitDepth: layout.bitDepth,
        peaks: peaks ? normalise(peaks) : null,
      }
    }
  }

  const duration = await readDuration(file).catch(() => null)

  const withinDecodeBudget =
    file.size <= DECODE_MAX_BYTES && duration !== null && duration > 0 && duration <= DECODE_MAX_SECONDS
  if (withinDecodeBudget) {
    const decoded = await decodeProbe(file, bars).catch(() => null)
    if (decoded) {
      return {
        ...EMPTY_PROBE,
        durationSeconds: decoded.durationSeconds || duration,
        channels: decoded.channels,
        peaks: normalise(decoded.peaks),
      }
    }
  }

  return { ...EMPTY_PROBE, durationSeconds: duration }
}
