import { useState } from 'react'
import { describeTranscriptionOptions, type TranscriptionOptions } from './transcriptionOptions'
import './TranscriptActions.css'

interface TranscriptActionsProps {
  options: TranscriptionOptions
  /** Back to the audio step, where the settings above are actually changed. */
  onEditOptions: () => void
  isBusy: boolean
  progress: number
  hasAudio: boolean
  hasSegments: boolean
  canGenerate: boolean
  error: string | null
  /** What the last run's prompt window took. Null before any run. */
  promptReport?: PromptReport | null
  /** How the last run's speaker-count hint fared. Null before any run. */
  speakerReport?: SpeakerReport | null
  /** What the last run's permissive VAD tier recovered. Null before any run. */
  vadReport?: VadReport | null
  onGenerate: () => void
  onCancel: () => void
  /** Rotating reassurance copy shown next to the progress bar while busy - there's
   *  no real progress signal from the backend, so this is what fills the wait. */
  reassurance?: string
}

/** How the speaker-count hint fared on the last transcription. */
export interface SpeakerReport {
  found: number
  min: number | null
  max: number | null
  /** False when a hint was set but the diarization backend couldn't take it. */
  hintApplied: boolean
  /** Bounds the server clamped or reordered, described in words. */
  adjustments: string[]
  /** Null when there was no hint to measure the result against. */
  withinHint: boolean | null
}

function describeBounds(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return min === max ? `exactly ${min}` : `${min}–${max}`
  if (min !== null) return `at least ${min}`
  if (max !== null) return `at most ${max}`
  return 'auto'
}

/** What the permissive VAD tier recovered on the last transcription. */
export interface VadReport {
  /** Seconds of speech only the permissive tier found. */
  borderlineSeconds: number
  /** Lines holding that speech, flagged in the transcript for review. */
  borderlineLines: number
  /** Share of the recording the confident tier called speech. */
  speechRatio: number | null
}

function describeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

/** How the model's prompt window was spent on the last transcription. */
export interface PromptReport {
  /** Terms that didn't fit and were not applied. */
  dropped: string[]
  /** Names lifted from the prose description to fill leftover room. */
  harvested: string[]
  tokens: number
  budget: number
}

/**
 * The transcript rail's one action. The settings themselves live on the audio
 * step, so this only reads them back - enough to see what the next run will do
 * without leaving the page, and a way back to change it.
 */
export function TranscriptActions({
  options,
  onEditOptions,
  isBusy,
  progress,
  hasAudio,
  hasSegments,
  canGenerate,
  error,
  promptReport,
  speakerReport,
  vadReport,
  onGenerate,
  onCancel,
  reassurance,
}: TranscriptActionsProps) {
  const hasHint = speakerReport ? speakerReport.min !== null || speakerReport.max !== null : false
  // Regenerating overwrites any hand-edited transcript text/speaker names with no
  // way back, so it asks first - the same in-place confirm as removing a recording
  // on the audio step. The very first Generate has nothing to lose, so it skips it.
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)

  function handlePrimaryClick() {
    if (hasSegments) {
      setConfirmingRegenerate(true)
      return
    }
    onGenerate()
  }

  return (
    <div className="card transcript-actions">
      <div className="transcript-actions__settings">
        <span className="eyebrow">Transcription</span>
        <span className="transcript-actions__summary">{describeTranscriptionOptions(options)}</span>
        <button type="button" className="transcript-actions__edit" onClick={onEditOptions} disabled={isBusy}>
          Change on the audio step
        </button>
      </div>

      {confirmingRegenerate ? (
        <p className="confirm-inline" role="status">
          <span>Overwrite the current transcript?</span>
          <button
            type="button"
            className="confirm-inline__danger"
            onClick={() => {
              setConfirmingRegenerate(false)
              onGenerate()
            }}
          >
            Regenerate
          </button>
          <button type="button" className="confirm-inline__cancel" onClick={() => setConfirmingRegenerate(false)}>
            Keep it
          </button>
        </p>
      ) : isBusy ? (
        <div className="transcript-actions__busy-row">
          <button type="button" className="button button--primary" disabled>
            {`Transcribing… ${Math.round(progress * 100)}%`}
          </button>
          <button type="button" className="button button--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="button button--primary" onClick={handlePrimaryClick} disabled={!canGenerate}>
          {hasSegments ? 'Regenerate transcript' : 'Generate transcript'}
        </button>
      )}

      {isBusy && (
        <div className="progress-bar">
          <div className="progress-bar__fill" style={{ transform: `scaleX(${Math.max(0.06, progress)})` }} />
        </div>
      )}

      {isBusy && reassurance && <p className="status-message status-message--hint">{reassurance}</p>}

      {!hasAudio && !hasSegments && (
        <p className="status-message status-message--hint">Add audio above to generate a transcript.</p>
      )}

      {!hasAudio && hasSegments && (
        <p className="status-message status-message--hint">
          Viewing a saved transcript — re-add the original file to play audio or regenerate.
        </p>
      )}

      {promptReport && promptReport.budget > 0 && (
        <div className="transcript-actions__prompt">
          <span className="transcript-actions__prompt-head">
            Prompt window
            <span>
              {promptReport.tokens}/{promptReport.budget} tokens
            </span>
          </span>
          <span className="transcript-actions__prompt-bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${Math.min(1, promptReport.tokens / promptReport.budget)})` }} />
          </span>
          {promptReport.harvested.length > 0 && (
            <small>
              Added from your description: {promptReport.harvested.slice(0, 4).join(', ')}
              {promptReport.harvested.length > 4 ? '…' : ''}
            </small>
          )}
          {promptReport.dropped.length > 0 && (
            <small className="transcript-actions__prompt-warn">
              {promptReport.dropped.length} term{promptReport.dropped.length === 1 ? '' : 's'} didn&rsquo;t fit and
              weren&rsquo;t applied: {promptReport.dropped.slice(0, 4).join(', ')}
              {promptReport.dropped.length > 4 ? '…' : ''}
            </small>
          )}
        </div>
      )}

      {speakerReport && speakerReport.found > 0 && (
        <div className="transcript-actions__prompt">
          <span className="transcript-actions__prompt-head">
            Speakers
            <span>
              {speakerReport.found} found{hasHint ? ` · asked ${describeBounds(speakerReport.min, speakerReport.max)}` : ''}
            </span>
          </span>
          {speakerReport.adjustments.map((adjustment) => (
            <small key={adjustment} className="transcript-actions__prompt-warn">
              {adjustment}.
            </small>
          ))}
          {hasHint && !speakerReport.hintApplied && (
            <small className="transcript-actions__prompt-warn">
              This diarization backend doesn&rsquo;t accept a speaker count, so the range wasn&rsquo;t applied.
            </small>
          )}
          {speakerReport.withinHint === false && (
            <small className="transcript-actions__prompt-warn">
              Outside the range you asked for — the count is a hint, not a limit. Check the speaker labels before
              relying on them.
            </small>
          )}
        </div>
      )}

      {vadReport && vadReport.borderlineLines > 0 && (
        <div className="transcript-actions__prompt">
          <span className="transcript-actions__prompt-head">
            Quiet speech
            <span>
              {describeSeconds(vadReport.borderlineSeconds)} recovered
              {vadReport.speechRatio !== null
                ? ` · ${Math.round(vadReport.speechRatio * 100)}% clear speech`
                : ''}
            </span>
          </span>
          <small className="transcript-actions__prompt-warn">
            {vadReport.borderlineLines} line{vadReport.borderlineLines === 1 ? '' : 's'} came from below the
            main detection threshold and {vadReport.borderlineLines === 1 ? 'is' : 'are'} marked unverified. A
            single threshold would have dropped this audio without recording it — check the marked lines
            against the recording.
          </small>
        </div>
      )}

      {error && (
        <p role="alert" className="status-message status-message--error">
          {error}
        </p>
      )}
    </div>
  )
}
