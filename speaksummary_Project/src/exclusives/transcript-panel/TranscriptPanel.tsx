import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { AudioPlayerHandle } from '../audio-intake'
import {
  transcriptToPlainText,
  transcribeAudio,
  downloadTranscriptDocx,
  useRotatingMessage,
  type TranscriptSegment,
} from '../logic'
import { TranscriptRow, NEW_SPEAKER_OPTION } from '../transcript-row'
import {
  TranscriptActions,
  effectiveTerms,
  speakerBound,
  type PromptReport,
  type SpeakerReport,
  type TranscriptionOptions,
} from '../audio-intake'
import { SpeakerLabel } from '../speaker-label'
import './TranscriptPanel.css'

export interface AudioRef {
  name: string
  url: string
  blob: Blob
}

interface TranscriptPanelProps {
  fileName: string | null
  audio: AudioRef | null
  segments: TranscriptSegment[] | null
  onSegmentsChange: (segments: TranscriptSegment[] | null) => void
  playerRef: RefObject<AudioPlayerHandle | null>
  currentTime: number
  isPlaying: boolean
  // Set on the audio step and read here - this page runs the job and shows the
  // result, but no longer owns the settings it runs under.
  options: TranscriptionOptions
  // Back to the audio step, where those settings are changed.
  onEditOptions: () => void
  // Raised while a transcription is in flight, so the audio step can hold its
  // options shut rather than letting them be edited out from under the run.
  onTranscribingChange?: (busy: boolean) => void
  // The audio player (or "playback unavailable" card) rendered at the top of the
  // left rail, above the action card - kept as a slot so App owns the AudioPlayer.
  audioSlot?: ReactNode
}

type GenerationStatus = 'idle' | 'processing' | 'done' | 'error'

const TRANSCRIBING_MESSAGES = [
  'Longer recordings and speaker diarization both take a few extra minutes.',
  'Still working — WhisperX is aligning speech to timestamps.',
  'This can take a while on CPU; a GPU backend runs much faster.',
  'Almost every recording finishes within a few minutes — hang tight.',
]

export function TranscriptPanel({
  fileName,
  audio,
  segments,
  onSegmentsChange,
  playerRef,
  currentTime,
  isPlaying,
  options,
  onEditOptions,
  onTranscribingChange,
  audioSlot,
}: TranscriptPanelProps) {
  const { diarize, includeTimestamps } = options
  // Keyed off the actual distinct speakers rather than the segments array itself, so
  // editing a line's text (which rebuilds `segments` on every keystroke) doesn't hand
  // every TranscriptRow a new `uniqueSpeakers` array reference and defeat its memo.
  // JSON, not join(' ')/split(' '): speaker names contain spaces ("Speaker 1", and
  // anything the user renames one to), so a space-delimited round-trip shreds them
  // into separate entries. JSON survives any character a name can hold.
  const speakerSetKey = segments
    ? JSON.stringify(Array.from(new Set(segments.map((segment) => segment.speaker))))
    : ''
  const uniqueSpeakers = useMemo<string[]>(() => (speakerSetKey ? JSON.parse(speakerSetKey) : []), [speakerSetKey])
  const [status, setStatus] = useState<GenerationStatus>(segments ? 'done' : 'idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [previewSegmentId, setPreviewSegmentId] = useState<string | null>(null)
  const [addingSpeakerFor, setAddingSpeakerFor] = useState<string | null>(null)
  const [newSpeakerName, setNewSpeakerName] = useState('')
  const [isExportingDocx, setIsExportingDocx] = useState(false)
  // What the last run's prompt window actually took. Worth surfacing both ways:
  // a term the user typed that never reached the model, and a name we added on
  // their behalf, are each things they'd want to know about.
  const [promptReport, setPromptReport] = useState<PromptReport | null>(null)
  // Whether the speaker-count hint reached a diarizer, and whether the result
  // landed inside it. A hint is a hint - clustering can still come out elsewhere.
  const [speakerReport, setSpeakerReport] = useState<SpeakerReport | null>(null)
  // Custom speaker names, remembered by speaking order (who talks first, second, ...)
  // so a rename survives "Regenerate transcript" instead of resetting to "Speaker 1/2".
  const [speakerNamesByOrder, setSpeakerNamesByOrder] = useState<string[]>([])
  // A different audio file means different people - don't carry names over.
  // Adjusted during render (React's recommended pattern) rather than an effect,
  // since this needs to happen before the remap in handleGenerate ever runs.
  const [lastAudioUrl, setLastAudioUrl] = useState(audio?.url)
  if (audio?.url !== lastAudioUrl) {
    setLastAudioUrl(audio?.url)
    setSpeakerNamesByOrder([])
  }

  const abortControllerRef = useRef<AbortController | null>(null)
  const reassurance = useRotatingMessage(TRANSCRIBING_MESSAGES, status === 'processing')

  useEffect(() => {
    let intervalId: number | undefined
    if (status === 'processing') {
      intervalId = window.setInterval(() => {
        setProgress((prev) => Math.min(0.95, prev + 0.05 + Math.random() * 0.05))
      }, 400)
    }
    return () => window.clearInterval(intervalId)
  }, [status])

  useEffect(() => {
    onTranscribingChange?.(status === 'processing')
  }, [status, onTranscribingChange])

  // Follow-along: whichever line the shared player's position currently falls within.
  // Purely derived from props, so no state/effect needed to track it.
  const followSegmentId = segments
    ? (segments.find((segment) => currentTime >= segment.start && currentTime < segment.end)?.id ?? null)
    : null

  useEffect(() => {
    if (!followSegmentId) return
    const row = document.querySelector(`[data-segment-id="${followSegmentId}"]`)
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [followSegmentId])

  // Actually stop playback once it runs past the previewed line's end - a real command to
  // the audio element, not state; the row's "is this playing" indicator below is derived.
  // previewSegmentId is cleared here too, otherwise it keeps matching and re-pausing every
  // subsequent play once currentTime has moved past that segment's end.
  useEffect(() => {
    if (!previewSegmentId || !segments || !isPlaying) return
    const segment = segments.find((s) => s.id === previewSegmentId)
    if (segment && currentTime >= segment.end) {
      playerRef.current?.pause()
      setPreviewSegmentId(null)
    }
  }, [currentTime, previewSegmentId, segments, isPlaying, playerRef])

  async function handleGenerate() {
    if (!audio) return

    const controller = new AbortController()
    abortControllerRef.current = controller

    setStatus('processing')
    setError(null)
    setProgress(0)
    setPreviewSegmentId(null)

    try {
      const result = await transcribeAudio(
        audio.blob,
        audio.name,
        {
          diarize,
          minSpeakers: speakerBound(options.minSpeakers),
          maxSpeakers: speakerBound(options.maxSpeakers),
          contextTerms: effectiveTerms(options),
          context: options.context,
        },
        controller.signal,
      )
      setProgress(1)
      const diagnostics = result.diagnostics
      setPromptReport({
        dropped: diagnostics?.context_terms_dropped ?? [],
        harvested: diagnostics?.context_terms_harvested ?? [],
        tokens: diagnostics?.context_prompt_tokens ?? 0,
        budget: diagnostics?.context_prompt_budget ?? 0,
      })
      setSpeakerReport({
        found: diagnostics?.diarization_speaker_count ?? 0,
        min: diagnostics?.speaker_min_requested ?? null,
        max: diagnostics?.speaker_max_requested ?? null,
        hintApplied: diagnostics?.speaker_hint_applied ?? false,
        adjustments: diagnostics?.speaker_hint_adjustments ?? [],
        withinHint: diagnostics?.speaker_count_within_hint ?? null,
      })

      const speakingOrder = Array.from(new Set(result.segments.map((segment) => segment.speaker)))
      const remembered = result.segments.map((segment) => {
        const customName = speakerNamesByOrder[speakingOrder.indexOf(segment.speaker)]
        return customName ? { ...segment, speaker: customName } : segment
      })

      onSegmentsChange(remembered)
      setStatus('done')
    } catch (err) {
      setProgress(0)
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatus(segments ? 'done' : 'idle')
        return
      }
      setError(err instanceof Error ? err.message : 'Transcription failed')
      setStatus('error')
    } finally {
      abortControllerRef.current = null
    }
  }

  function handleCancelGenerate() {
    abortControllerRef.current?.abort()
  }

  function handleDownloadTranscriptTxt() {
    if (!segments || !fileName) return
    const title = fileName.replace(/\.[^/.]+$/, '')
    const blob = new Blob([transcriptToPlainText(segments, title)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${title}-transcript.txt`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function handleDownloadTranscriptDocx() {
    if (!segments || !fileName) return
    const title = fileName.replace(/\.[^/.]+$/, '')
    setIsExportingDocx(true)
    try {
      await downloadTranscriptDocx(segments, title, `${title}-transcript.docx`)
    } finally {
      setIsExportingDocx(false)
    }
  }

  // The callbacks below are handed to TranscriptRow, which is memoized so that editing one
  // line doesn't re-render the whole transcript - wrapped in useCallback so their identity
  // stays stable across renders and doesn't defeat that memo.

  const handleReassignSpeaker = useCallback(
    (segmentId: string, speaker: string) => {
      if (!segments) return
      onSegmentsChange(segments.map((segment) => (segment.id === segmentId ? { ...segment, speaker } : segment)))
    },
    [segments, onSegmentsChange],
  )

  const rememberSpeakerName = useCallback(
    (currentSpeaker: string, newName: string) => {
      const order = uniqueSpeakers.indexOf(currentSpeaker)
      if (order < 0) return
      setSpeakerNamesByOrder((prev) => {
        const next = [...prev]
        next[order] = newName
        return next
      })
    },
    [uniqueSpeakers],
  )

  const handleTextChange = useCallback(
    (id: string, text: string) => {
      if (!segments) return
      onSegmentsChange(segments.map((segment) => (segment.id === id ? { ...segment, text } : segment)))
    },
    [segments, onSegmentsChange],
  )

  const handlePlaySegment = useCallback(
    (segment: TranscriptSegment) => {
      const player = playerRef.current
      if (!player) return

      const isCurrentlyPreviewing = previewSegmentId === segment.id && isPlaying && currentTime < segment.end
      if (isCurrentlyPreviewing) {
        player.pause()
        setPreviewSegmentId(null)
        return
      }

      player.seekTo(segment.start)
      player.play()
      setPreviewSegmentId(segment.id)
    },
    [playerRef, previewSegmentId, isPlaying, currentTime],
  )

  const handleSpeakerSelectChange = useCallback(
    (segmentId: string, value: string) => {
      if (value === NEW_SPEAKER_OPTION) {
        setAddingSpeakerFor(segmentId)
        setNewSpeakerName('')
        return
      }
      handleReassignSpeaker(segmentId, value)
    },
    [handleReassignSpeaker],
  )

  const commitNewSpeaker = useCallback(
    (segmentId: string) => {
      const name = newSpeakerName.trim()
      if (name) {
        const previousSpeaker = segments?.find((segment) => segment.id === segmentId)?.speaker
        if (previousSpeaker) rememberSpeakerName(previousSpeaker, name)
        handleReassignSpeaker(segmentId, name)
      }
      setAddingSpeakerFor(null)
      setNewSpeakerName('')
    },
    [newSpeakerName, segments, rememberSpeakerName, handleReassignSpeaker],
  )

  const handleCancelNewSpeaker = useCallback(() => {
    setAddingSpeakerFor(null)
    setNewSpeakerName('')
  }, [])

  function handleSpeakerRename(oldSpeaker: string, newSpeaker: string) {
    if (!segments) return
    rememberSpeakerName(oldSpeaker, newSpeaker)
    onSegmentsChange(
      segments.map((segment) => (segment.speaker === oldSpeaker ? { ...segment, speaker: newSpeaker } : segment)),
    )
  }

  const isBusy = status === 'processing'
  const canPlay = audio !== null
  const canGenerate = audio !== null && !isBusy

  return (
    <div className="transcript-layout">
      <div className="transcript-rail">
        {audioSlot}

        <TranscriptActions
          options={options}
          onEditOptions={onEditOptions}
          isBusy={isBusy}
          progress={progress}
          hasAudio={audio !== null}
          hasSegments={segments !== null}
          canGenerate={canGenerate}
          error={error}
          promptReport={promptReport}
          speakerReport={speakerReport}
          onGenerate={handleGenerate}
          onCancel={handleCancelGenerate}
          reassurance={reassurance}
        />
      </div>

      <section className="transcript-panel card">
        {segments && segments.length > 0 && (
          <div className="panel-header">
            <div className="panel-header__actions">
              <button type="button" className="button button--ghost button--small" onClick={handleDownloadTranscriptTxt}>
                .txt
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={handleDownloadTranscriptDocx}
                disabled={isExportingDocx}
              >
                {isExportingDocx ? 'Preparing…' : '.docx'}
              </button>
            </div>
          </div>
        )}

        <div className="transcript-panel__body">
          {diarize && segments && uniqueSpeakers.length > 0 && (
            <div className="speakers-row">
              {uniqueSpeakers.map((speaker, index) => (
                <SpeakerLabel
                  key={index}
                  speaker={speaker}
                  uniqueSpeakers={uniqueSpeakers}
                  onRename={(newName) => handleSpeakerRename(speaker, newName)}
                />
              ))}
            </div>
          )}

          {segments && segments.length > 0 ? (
            <div className="transcript-rows">
              {segments.map((segment) => {
                const isPreviewing = previewSegmentId === segment.id && isPlaying && currentTime < segment.end
                const isFollowed = followSegmentId === segment.id
                const rowDuration = segment.end - segment.start
                const playbackRatio = isPreviewing && rowDuration > 0
                  ? Math.min(1, Math.max(0, (currentTime - segment.start) / rowDuration))
                  : 0

                return (
                  <TranscriptRow
                    key={segment.id}
                    segment={segment}
                    isFollowed={isFollowed}
                    isPreviewing={isPreviewing}
                    playbackRatio={playbackRatio}
                    includeTimestamps={includeTimestamps}
                    diarize={diarize}
                    canPlay={canPlay}
                    uniqueSpeakers={uniqueSpeakers}
                    isAddingSpeaker={addingSpeakerFor === segment.id}
                    newSpeakerName={newSpeakerName}
                    onPlaySegment={handlePlaySegment}
                    onTextChange={handleTextChange}
                    onSpeakerSelectChange={handleSpeakerSelectChange}
                    onNewSpeakerNameChange={setNewSpeakerName}
                    onCommitNewSpeaker={commitNewSpeaker}
                    onCancelNewSpeaker={handleCancelNewSpeaker}
                  />
                )
              })}
            </div>
          ) : (
            status !== 'processing' && (
              <div className="empty-state">
                <span className="empty-state__icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M8 6h8M8 12h8M8 18h5" />
                  </svg>
                </span>
                <span className="empty-state__title">{segments ? 'No speech detected' : 'No transcript yet'}</span>
                <span className="empty-state__hint">
                  {segments
                    ? "This recording didn't have any detectable speech to transcribe."
                    : 'Generate one to see speaker-labeled, timestamped lines here.'}
                </span>
              </div>
            )
          )}
        </div>
      </section>
    </div>
  )
}
