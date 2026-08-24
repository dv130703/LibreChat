import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, ReactNode } from 'react'
import { AudioPlayer } from '../audio-player'
import { AudioQualityPanel } from '../audio-quality'
import { Icon, type IconName } from '../icon'
import { Waveform } from '../waveform'
import { FormatDropdown } from '../format-dropdown'
import { summariseTranscriptionOptions, type TranscriptionOptions } from '../transcript-options/transcriptionOptions'
import {
  isVideoFile,
  isAcceptedMediaFile,
  probeMedia,
  EMPTY_PROBE,
  WAVE_BARS,
  useAudioConverter,
  useAudioQualityCheck,
  getAvailableTargetFormats,
  isLossless,
  estimateOutputBytes,
  estimateBitrateKbps,
  type ConversionResult,
  type MediaProbe,
  type AudioFormat,
} from '../../logic'
import './UploadIntake.css'

interface UploadIntakeProps {
  onFileChange: (file: File | null) => void
  onConverted: (result: ConversionResult | null) => void
  // Raised while ffmpeg is loading or converting, so the parent can hold its
  // stage-navigation disabled until there's a settled file to move on with.
  onBusyChange?: (busy: boolean) => void
  // "name · 22:11 · 243.7 MB" for the top bar, which has no way to measure the
  // file for itself. Null once there is no file to describe.
  onFileLineChange?: (line: string | null) => void
  // The recording's shape, so the transcript stage's player can draw the same
  // waveform this panel does rather than probing the file a second time.
  onPeaksChange?: (peaks: number[] | null) => void
  // Move on to transcription. The output rail's one button runs any conversion
  // the picked row still needs and then calls this, so the parent keeps owning
  // stage-navigation without having to know whether a conversion is pending.
  onContinue?: () => void
  // The transcription options block, rendered in its own column - kept as a
  // slot so the parent owns those settings, which the transcript stage reads
  // back when it runs the job.
  optionsSlot?: ReactNode
  // Read-only mirror of the same settings, for the "ready to transcribe"
  // summary column - the slot above renders the editable panel, but this page
  // has no other way to read what it's currently set to.
  transcription: TranscriptionOptions
}

// ffmpeg.wasm runs conversion in a single linear memory space shared by the
// input, output, and working buffers - it gets unreliable well before the
// browser's own per-file limits kick in, so this cap is enforced up front.
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024

// Sentinel for the "don't convert" row. Never collides with a real format id.
const KEEP_ORIGINAL = 'keep-original'

const MEGABYTE = 1024 * 1024

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / MEGABYTE).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const total = Math.round(seconds)
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

function formatSampleRate(hertz: number): string {
  const kilohertz = hertz / 1000
  return `${Number.isInteger(kilohertz) ? kilohertz : kilohertz.toFixed(1)} kHz`
}

function formatChannels(channels: number): string {
  if (channels === 1) return 'Mono'
  if (channels === 2) return 'Stereo'
  return `${channels} channels`
}

function formatAddedAt(timestamp: number): string {
  return new Date(timestamp)
    .toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })
    .toUpperCase()
}

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function validateFile(candidate: File): string | null {
  if (!isAcceptedMediaFile(candidate)) {
    return `"${candidate.name}" isn't an audio or video file — try MP3, WAV, MP4, MOV, and similar formats.`
  }
  if (candidate.size > MAX_FILE_SIZE) {
    return `"${candidate.name}" is ${formatFileSize(candidate.size)}, over the ${formatFileSize(MAX_FILE_SIZE)} limit for in-browser conversion.`
  }
  return null
}

/**
 * One option on the picker. Options are grouped by what the encode does to the
 * audio, and the one currently picked is drawn onto the lane below the chips so
 * its size can be read against the source rather than against another number.
 */
interface Stop {
  key: string
  name: string
  /** Three or four words on why you'd take this one over its neighbours, shown on the picker row. */
  desc: string
  codec: string
  /** The same codec squeezed into the output rail's narrow comparison column. */
  shortCodec: string
  /** Expected output size, or null when the source duration couldn't be read. */
  bytes: number | null
  bitrateKbps: number | null
  approximateRate: boolean
  /** Which of the groups the option belongs to, and how they're ordered. */
  lossless: boolean
  /** Marks the one format this page suggests for transcription. */
  recommended: boolean
  /** null on the "as uploaded" option - picking it adopts the source untouched. */
  format: AudioFormat | null
}

export function UploadIntake({
  onFileChange,
  onConverted,
  onBusyChange,
  onFileLineChange,
  onPeaksChange,
  onContinue,
  optionsSlot,
  transcription,
}: UploadIntakeProps) {
  const [file, setFile] = useState<File | null>(null)
  // The source file adopted as-is. Held so re-picking "as uploaded" after a
  // conversion doesn't mint a second object URL for the same blob. Null for video,
  // which has no directly usable audio track.
  const [original, setOriginal] = useState<ConversionResult | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Discarding the recording throws away the probe, the quality check and any
  // conversion, so it asks first rather than acting on a single stray click.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  // The chip under the pointer or the keyboard's focus, previewed on the lane
  // behind the picked format's fill so two options can be compared without
  // committing to either. Null whenever nothing is being pointed at.
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [addedAt, setAddedAt] = useState<number | null>(null)
  // Null while the file is still being read; the panel shows what it has and
  // fills the rest in when the probe settles.
  const [probe, setProbe] = useState<MediaProbe | null>(null)

  const { status, progress, result: converted, error: convertError, convert, reset } = useAudioConverter()
  const {
    isChecking,
    quality,
    error: qualityError,
    checkQuality,
    applyPreprocessing,
    reset: resetQuality,
  } = useAudioQualityCheck()

  const dragDepthRef = useRef(0)

  // The file whose quality has already been measured, so a repaired file that
  // arrives with fresh measurements isn't sent straight back for re-analysis.
  const measuredFileRef = useRef<File | null>(null)

  // Which row the in-flight or finished conversion belongs to. Moving along the
  // chips doesn't convert, so the converter's result has to be tied back to the
  // one that asked for it - otherwise moving away from a finished FLAC would
  // keep handing that FLAC forward under a different format's name.
  const [convertedId, setConvertedId] = useState<string | null>(null)

  const isBusy = status === 'loading' || status === 'converting'
  const isDone = status === 'done' && !!converted
  const isError = status === 'error' && !!convertError

  const fromVideo = file ? isVideoFile(file) : false
  const originalExtension = file ? extensionOf(file.name) : ''
  const availableFormats = file ? getAvailableTargetFormats(file.name) : []

  // Conversion state, but only when it belongs to the row on screen.
  const matchesConverted = convertedId !== null && convertedId === selectedId
  const showsBusy = isBusy && matchesConverted
  const showsDone = isDone && matchesConverted
  const showsError = isError && matchesConverted

  // The file carried forward to transcription: the finished conversion when the
  // picked row is the one that produced it, otherwise the source as uploaded.
  // A failed conversion falls back to the original rather than stranding the
  // user with nothing.
  const adopted = showsDone ? converted : original

  // Read the latest callbacks from refs so these effects only fire on real state
  // transitions, not whenever the parent re-renders with new callback identities.
  const onConvertedRef = useRef(onConverted)
  const onBusyChangeRef = useRef(onBusyChange)
  const onFileLineChangeRef = useRef(onFileLineChange)
  const onPeaksChangeRef = useRef(onPeaksChange)
  const onContinueRef = useRef(onContinue)
  useEffect(() => {
    onConvertedRef.current = onConverted
    onBusyChangeRef.current = onBusyChange
    onFileLineChangeRef.current = onFileLineChange
    onPeaksChangeRef.current = onPeaksChange
    onContinueRef.current = onContinue
  })
  // Hold the last reported file while a conversion is in flight - the parent keeps
  // showing the session it already has, and Continue is held shut via onBusyChange
  // rather than by yanking the audio out from under it mid-convert.
  useEffect(() => {
    if (isBusy) return
    onConvertedRef.current(adopted)
  }, [adopted, isBusy])
  useEffect(() => {
    onBusyChangeRef.current?.(isBusy)
  }, [isBusy])

  // Reading duration, sample rate and the waveform touches the file itself, so
  // it runs once per file and never blocks the page from rendering.
  // `probe` is cleared by applyFile alongside the file itself, so this only has
  // the asynchronous half to do.
  useEffect(() => {
    if (!file) return

    let cancelled = false
    probeMedia(file, WAVE_BARS)
      .then((result) => {
        if (!cancelled) setProbe(result)
      })
      .catch(() => {
        if (!cancelled) setProbe(EMPTY_PROBE)
      })

    return () => {
      cancelled = true
    }
  }, [file])

  // The top bar's subtitle. Duration only joins once the probe lands, so this
  // runs again when it does rather than waiting for it up front.
  const probedDuration = formatDuration(probe?.durationSeconds ?? null)
  useEffect(() => {
    onFileLineChangeRef.current?.(
      file ? [file.name, probedDuration, formatFileSize(file.size)].filter(Boolean).join(' · ') : null,
    )
  }, [file, probedDuration])

  useEffect(() => {
    onPeaksChangeRef.current?.(probe?.peaks ?? null)
  }, [probe])

  // Check audio quality after probe completes. A repaired file arrives with its
  // measurements already taken, so it's recorded here as measured to keep this
  // from spending another minute re-deriving numbers we were just handed.
  useEffect(() => {
    if (!file || !probe || probe === EMPTY_PROBE) return
    if (measuredFileRef.current === file) return
    measuredFileRef.current = file
    checkQuality({ file })
  }, [file, probe, checkQuality])

  /**
   * Adopt the repaired recording in place of the one that needed fixing.
   *
   * Everything downstream reads from `file`, so swapping it here is what makes
   * the player, the waveform and the transcription use the fixed audio - the
   * measurements alone would only claim a repair had happened.
   */
  function adoptRepairedFile(repaired: File) {
    measuredFileRef.current = repaired

    // The old preview URL has no owner once the file behind it is replaced.
    setOriginal((previous) => {
      if (previous) URL.revokeObjectURL(previous.url)
      return { blob: repaired, url: URL.createObjectURL(repaired), fileName: repaired.name }
    })

    setFile(repaired)
    setProbe(null)
    // Any finished conversion belongs to the unrepaired audio, so it can't be
    // carried forward under the repaired file's name.
    setConvertedId(null)
    reset()

    // Repaired audio always comes back as WAV, so a format picked against the
    // old container may no longer be on offer.
    const formats = getAvailableTargetFormats(repaired.name)
    setSelectedId((current) =>
      current === KEEP_ORIGINAL || formats.some((format) => format.id === current) ? current : KEEP_ORIGINAL,
    )

    onFileChange(repaired)
    setAnnouncement('Audio repaired')
  }

  function applyFile(nextFile: File | null) {
    if (nextFile) {
      const rejection = validateFile(nextFile)
      if (rejection) {
        setError(rejection)
        return
      }
    }

    setError(null)
    setFile(nextFile)
    setAddedAt(nextFile ? Date.now() : null)
    setProbe(null)
    setConvertedId(null)
    // The incoming file has no measurements yet, whatever the outgoing one had.
    measuredFileRef.current = null
    resetQuality()
    reset()
    onFileChange(nextFile)
    setAnnouncement(nextFile ? `${nextFile.name} added` : 'File removed')

    // Audio is usable as uploaded, so it starts on the "as uploaded" row with a
    // result already in hand and nothing to do. Video has no directly usable
    // audio track, so it starts on the recommended format instead - that row
    // has an action worth taking, and nothing is carried forward until it runs.
    if (nextFile && !isVideoFile(nextFile)) {
      setOriginal({ blob: nextFile, url: URL.createObjectURL(nextFile), fileName: nextFile.name })
      setSelectedId(KEEP_ORIGINAL)
    } else {
      setOriginal(null)
      const formats = nextFile ? getAvailableTargetFormats(nextFile.name) : []
      setSelectedId(formats.find((format) => format.recommended)?.id ?? formats[0]?.id ?? null)
    }
  }

  // Moving between chips is free - it only changes what's described. The
  // conversion is committed separately, so comparing options costs nothing.
  function pickStop(stop: Stop) {
    if (isBusy) return
    setSelectedId(stop.key)
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    applyFile(event.target.files?.[0] ?? null)
    // Reset so picking the same file again (e.g. after removing it) still fires onChange.
    event.target.value = ''
  }

  // Tracks nesting depth of dragenter/dragleave so the highlight doesn't flicker
  // when the pointer crosses child elements (icon, text, buttons) inside the target.
  function handleDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    dragDepthRef.current += 1
    setIsDragging(true)
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault()
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDragging(false)
    applyFile(event.dataTransfer.files?.[0] ?? null)
  }

  function handleSave() {
    if (!converted) return
    const link = document.createElement('a')
    link.href = converted.url
    link.download = converted.fileName
    link.click()
  }

  const filePicker = (
    <input type="file" accept="audio/*,video/*" className="visually-hidden" onChange={handleInputChange} />
  )

  const statusRegion = (
    <div className="visually-hidden" aria-live="polite">
      {announcement}
    </div>
  )

  if (!file) {
    return (
      <div
        className="intake-empty"
        data-dragging={isDragging}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {statusRegion}
        <div className="card intake-empty__panel">
          <span className="intake-empty__icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </span>
          <span className="intake-empty__title">Add an audio or video file</span>
          <span className="intake-empty__hint">MP3, WAV, M4A, MP4, MOV, and more · up to {formatFileSize(MAX_FILE_SIZE)}</span>
          <label className="button button--primary intake-empty__browse">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4M12 4 7 9M12 4l5 5" />
              <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            </svg>
            Select file
            {filePicker}
          </label>
        </div>
        {error && (
          <p role="alert" className="status-message status-message--error intake-empty__error">
            {error}
          </p>
        )}
      </div>
    )
  }

  const source = {
    durationSeconds: probe?.durationSeconds ?? null,
    sampleRate: probe?.sampleRate ?? null,
    channels: probe?.channels ?? null,
  }
  const durationLabel = formatDuration(source.durationSeconds)
  const sourceCodec = probe?.bitDepth ? `PCM ${probe.bitDepth}-bit` : originalExtension
  // What the panel's player plays: the finished conversion once there is one,
  // otherwise the source as uploaded. Null for a video still awaiting its first
  // conversion, which has no directly playable audio track.
  const playableUrl = adopted?.url ?? null

  function stopForFormat(format: AudioFormat): Stop {
    return {
      key: format.id,
      name: format.label,
      desc: format.tag,
      codec: format.codec,
      shortCodec: format.shortCodec,
      bytes: estimateOutputBytes(format, source),
      bitrateKbps: estimateBitrateKbps(format, source),
      approximateRate: !!format.approximateRate,
      lossless: isLossless(format),
      recommended: !!format.recommended,
      format,
    }
  }

  // Kept out of the two encode groups: adopting the upload is not an encode, and
  // a source that arrived as an MP3 has no business sitting under "kept whole".
  let keepOriginal: Stop | null = null
  if (!fromVideo) {
    // Bitrate of the file exactly as it arrived, rather than a predicted one.
    const sourceKbps =
      source.durationSeconds && source.durationSeconds > 0 ? (file.size * 8) / 1000 / source.durationSeconds : null
    keepOriginal = {
      key: KEEP_ORIGINAL,
      name: originalExtension,
      desc: 'Nothing re-encoded, kept exactly as uploaded.',
      codec: sourceCodec,
      shortCodec: sourceCodec,
      bytes: file.size,
      bitrateKbps: sourceKbps,
      approximateRate: true,
      lossless: true,
      recommended: false,
      format: null,
    }
  }
  const encodes = availableFormats.map(stopForFormat)

  // Smallest file first within each group, so a group's chips read left to right
  // as a scale. Bitrate rather than bytes: it is defined even when the duration
  // isn't, and an unknown rate belongs at the untouched end.
  const byBitrate = (a: Stop, b: Stop) =>
    (a.bitrateKbps ?? Number.POSITIVE_INFINITY) - (b.bitrateKbps ?? Number.POSITIVE_INFINITY)
  const compressed = encodes.filter((stop) => !stop.lossless).sort(byBitrate)
  const keptWhole = encodes.filter((stop) => stop.lossless).sort(byBitrate)

  const groups: { key: string; label: string; icon: IconName; stops: Stop[] }[] = [
    keepOriginal ? { key: 'source', label: 'As uploaded', icon: 'size', stops: [keepOriginal] } : null,
    compressed.length > 0 ? { key: 'lossy', label: 'Compressed', icon: 'compress', stops: compressed } : null,
    keptWhole.length > 0 ? { key: 'lossless', label: 'Kept whole', icon: 'lossless', stops: keptWhole } : null,
  ].filter((group): group is { key: string; label: string; icon: IconName; stops: Stop[] } => group !== null)

  // One flat sequence behind the groups, so the arrow keys walk every chip on
  // the page in the order they are drawn.
  const ordered = groups.flatMap((group) => group.stops)

  const selectedStop = ordered.find((stop) => stop.key === selectedId) ?? null

  // Drawn to whichever is larger: the source, or the biggest output on offer.
  // Re-encoding an MP3 as WAV lands well past the source, so the source is
  // marked at its own place on the lane rather than pinned to the far end.
  const laneBytes = Math.max(file.size, ...ordered.map((stop) => stop.bytes ?? 0))


  // The rail's one action. Runs whatever conversion the picked row still needs
  // and then moves on; a row that needs nothing goes straight through.
  //
  // The converted file is handed to the parent here rather than left to the
  // effect above: that effect runs on the next commit, which is after the
  // parent would already have switched stages, and the transcript page would
  // arrive to find no audio waiting for it.
  async function handleContinue() {
    if (!file || isBusy) return

    if (selectedStop?.format && !showsDone) {
      setConvertedId(selectedStop.key)
      const result = await convert(file, selectedStop.format)
      // A failed conversion leaves the error on screen rather than carrying the
      // unconverted original forward under the picked format's name.
      if (!result) return
      onConvertedRef.current(result)
    }

    onContinueRef.current?.()
  }

  // Whether continuing has an encode to run first, or just moves on. False on
  // the "as uploaded" row and on a row whose conversion has already landed.
  const needsConversion = !!selectedStop?.format && !showsDone

  // The one status line, tied to the row on screen. Only speaks while something
  // is actually happening to the file - a row that has nothing to say stays
  // quiet rather than narrating its own inaction.
  let noteText = ''
  let noteTone: 'plain' | 'good' | 'error' = 'plain'
  if (showsBusy && status === 'loading') {
    noteText = 'Getting the converter ready…'
  } else if (showsBusy) {
    noteText = `Converting to ${selectedStop?.name}…`
  } else if (showsError) {
    noteText = convertError as string
    noteTone = 'error'
  } else if (showsDone && selectedStop) {
    noteText = `Ready as ${selectedStop.name}.`
    noteTone = 'good'
  }

  const specRows: { label: string; value: string; icon: IconName }[] = []
  if (durationLabel) specRows.push({ label: 'Duration', value: durationLabel, icon: 'duration' })
  if (probe?.bitDepth) specRows.push({ label: 'Encoding', value: `PCM ${probe.bitDepth}-bit`, icon: 'encoding' })
  if (source.sampleRate)
    specRows.push({ label: 'Sample rate', value: formatSampleRate(source.sampleRate), icon: 'sampleRate' })
  if (source.channels) specRows.push({ label: 'Channels', value: formatChannels(source.channels), icon: 'channels' })
  if (fromVideo) specRows.push({ label: 'Source', value: 'Video · audio only', icon: 'video' })

  const tickMarks = source.durationSeconds
    ? [0, 0.25, 0.5, 0.75, 1].map((fraction) => formatDuration(source.durationSeconds! * fraction) ?? '')
    : []

  // Same facts the old "Transcription" disclosure used to summarise itself
  // with when folded shut - reused here so the ready-to-transcribe column
  // never has to invent a second description of the same settings.
  const transcriptionPills = summariseTranscriptionOptions(transcription)

  // One line for the ready-to-transcribe column: what Sound check actually
  // found, in its own words, so the summary can never disagree with the row
  // it's summarising.
  const qualityStatusText = isChecking
    ? 'Checking…'
    : quality
      ? quality.description
      : (qualityError ?? 'Not checked — transcription still works.')
  const qualityIsBad = quality?.rating === 'poor' || quality?.rating === 'very_poor'

  return (
    <div
      className="intake"
      data-dragging={isDragging}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {statusRegion}

      {/* Three regions side by side, not a single stack: the recording and its
          own checks, what the transcriber should be told, and - reflecting
          both back - what's about to happen when Continue is pressed. Below
          the container-query breakpoint this collapses to one column in the
          same order, so nothing here depends on the grid to make sense. */}
      <main className="intake__canvas" aria-label="Audio intake">
        <div className="intake-stage__inner">
          <div className="intake-grid">
            {/* ---- the recording, and whether it's usable ---- */}
            <section className="intake-col intake-col--recording">
              <h2 className="intake-col__heading">Recording</h2>

              <div className="intake-hero">
                {probe?.peaks && playableUrl ? (
                  <AudioPlayer key={playableUrl} src={playableUrl} title={file.name} peaks={probe.peaks} />
                ) : (
                  <div className="intake-wave-block">
                    <div className="intake-wave">
                      <Waveform
                        peaks={probe?.peaks ?? null}
                        placeholder={probe === null ? 'Reading file…' : fromVideo ? 'Video file' : 'No waveform preview'}
                      />
                    </div>
                    {tickMarks.length > 0 && (
                      <div className="intake-wave__ticks" aria-hidden="true">
                        {tickMarks.map((mark, index) => (
                          <span key={index}>{mark}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Identity once, on one line. Format below no longer repeats
                    the name or the size. */}
                <div className="intake-hero__id">
                  <h3 className="intake-hero__name" title={file.name}>
                    {file.name}
                  </h3>
                  <p className="intake-hero__meta">
                    {specRows.map((row) => row.value).join(' · ')}
                    {addedAt ? ` · added ${formatAddedAt(addedAt)}` : ''}
                  </p>
                </div>

                {error && (
                  <p role="alert" className="status-message status-message--error intake-file__error">
                    {error}
                  </p>
                )}
              </div>

              {/* Always on screen, never conditional: an absent quality block
                  reads as "not checked yet" for exactly as long as it takes to
                  wonder whether something is broken. */}
              <section className="intake-row intake-row--quality">
                <span className="intake-row__label">Sound check</span>
                <div className="intake-row__content">
                  {isChecking ? (
                    // The shape of the answer, shimmering, rather than a spinner
                    // that says only "something is happening": the rows that are
                    // coming are already laid out where they will land.
                    <div className="intake-skeleton" role="status" aria-live="polite">
                      <span className="visually-hidden">Listening to your recording…</span>
                      <span className="intake-skeleton__row" aria-hidden="true">
                        <span className="intake-skeleton__bar" style={{ width: '38%' }} />
                        <span className="intake-skeleton__bar" style={{ width: '14%' }} />
                      </span>
                      <span className="intake-skeleton__row" aria-hidden="true">
                        <span className="intake-skeleton__bar" style={{ width: '26%' }} />
                        <span className="intake-skeleton__bar" style={{ width: '18%' }} />
                      </span>
                    </div>
                  ) : quality ? (
                    <AudioQualityPanel
                      quality={quality}
                      isProcessing={isChecking}
                      error={qualityError}
                      onApplyPreprocessing={() => {
                        void applyPreprocessing(file).then((repaired) => {
                          if (repaired) adoptRepairedFile(repaired.file)
                        })
                      }}
                    />
                  ) : (
                    <p className="intake-quality__state intake-quality__state--muted">
                      {qualityError ?? "Couldn't check this one — transcription still works."}
                    </p>
                  )}
                </div>
              </section>

              {/* Already a closed-by-default combobox on its own - wrapping it
                  in a second disclosure only hid a control that was already
                  compact. */}
              <section className="intake-row intake-row--format">
                <span className="intake-row__label">Format</span>
                <FormatDropdown
                  groups={groups}
                  selectedId={selectedId}
                  onSelect={(key) => {
                    const stop = ordered.find((s) => s.key === key)
                    if (stop) pickStop(stop)
                  }}
                  disabled={isBusy}
                  laneBytes={laneBytes}
                  formatBytes={formatFileSize}
                />
              </section>

              {/* Set apart from the settings above: swapping or discarding the
                  recording undoes the whole step, not just one setting. */}
              <div className="intake-secondary">
                {confirmingRemove ? (
                  <p className="confirm-inline" role="status">
                    <span>Remove this recording?</span>
                    <button type="button" className="confirm-inline__danger" onClick={() => applyFile(null)}>
                      Remove
                    </button>
                    <button type="button" className="confirm-inline__cancel" onClick={() => setConfirmingRemove(false)}>
                      Keep it
                    </button>
                  </p>
                ) : (
                  <>
                    <label className="intake-secondary__action">
                      <Icon name="replace" size={20} aria-hidden="true" />
                      Replace file
                      {filePicker}
                    </label>
                    <button
                      type="button"
                      className="intake-secondary__action intake-secondary__action--danger"
                      onClick={() => setConfirmingRemove(true)}
                    >
                      <Icon name="remove" size={20} aria-hidden="true" />
                      Remove
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* ---- what the transcriber should be told ---- */}
            <section className="intake-col intake-col--transcription">
              <h2 className="intake-col__heading">Transcription</h2>
              {optionsSlot}
            </section>

            {/* ---- both columns, reflected back, and the one commitment ---- */}
            <aside className="intake-col intake-col--ready" aria-label="Ready to transcribe">
              <h2 className="intake-col__heading">Ready to transcribe</h2>

              <div className="intake-ready__summary">
                <div className="intake-ready__row intake-ready__row--file">
                  <span className="intake-ready__row-label">File</span>
                  <span className="intake-ready__row-value" title={file.name}>
                    {file.name}
                  </span>
                </div>
                <div className="intake-ready__row" data-tone={qualityIsBad ? 'warn' : 'plain'}>
                  <span className="intake-ready__row-label">Sound check</span>
                  <span className="intake-ready__row-value">{qualityStatusText}</span>
                </div>
                <div className="intake-ready__row">
                  <span className="intake-ready__row-label">Format</span>
                  <span className="intake-ready__row-value">
                    {selectedStop ? selectedStop.name : 'Not chosen'}
                    {selectedStop?.bytes != null ? ` · ${formatFileSize(selectedStop.bytes)}` : ''}
                  </span>
                </div>
                <div className="intake-ready__row intake-ready__row--pills">
                  <span className="intake-ready__row-label">Transcription</span>
                  <span className="intake-ready__row-pills">
                    {transcriptionPills.map((fact) => (
                      <span key={fact} className="pill">
                        {fact}
                      </span>
                    ))}
                  </span>
                </div>
              </div>

              <div className="intake-go">
                {noteText && (
                  <p className="intake-go__status" data-tone={noteTone} role="status" aria-live="polite">
                    {noteText}
                  </p>
                )}

                <button
                  type="button"
                  className="button button--primary intake-go__button"
                  disabled={isBusy || !selectedStop}
                  onClick={() => void handleContinue()}
                >
                  {showsBusy ? null : <Icon name={needsConversion ? 'convert' : 'check'} size={20} />}
                  {showsBusy
                    ? `Converting… ${Math.round(progress * 100)}%`
                    : showsError
                      ? `Retry ${selectedStop?.name} & continue`
                      : needsConversion
                        ? 'Convert & continue'
                        : 'Continue to transcript'}
                </button>

                {showsBusy && (
                  <span className="intake-go__progress" aria-hidden="true">
                    <span
                      className="intake-go__progress-fill"
                      style={{ transform: `scaleX(${Math.max(0.02, progress)})` }}
                    />
                  </span>
                )}

                {showsDone && (
                  <button type="button" className="intake-go__save" onClick={handleSave}>
                    <Icon name="download" size={18} aria-hidden="true" />
                    Download the {selectedStop?.name}
                  </button>
                )}
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  )
}
