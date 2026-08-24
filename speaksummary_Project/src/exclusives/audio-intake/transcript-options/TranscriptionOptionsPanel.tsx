import { useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { containsTerm } from './suggestTerms'
import { effectiveTerms, speakerBoundsInverted, type TranscriptionOptions } from './transcriptionOptions'
import './TranscriptionOptionsPanel.css'

const CONTEXT_PLACEHOLDER = 'Names, organisations and terms used in this recording…'

/** Speaker counts offered on the min/max selects. The backend clamps anyway. */
const SPEAKER_CHOICES = Array.from({ length: 10 }, (_, index) => String(index + 1))

interface TranscriptionOptionsPanelProps {
  options: TranscriptionOptions
  onChange: (patch: Partial<TranscriptionOptions>) => void
  /** Held shut while a transcription is already running with these settings. */
  disabled?: boolean
}

/**
 * How to transcribe, decided on the audio step. Always visible, not behind a
 * disclosure - this is decided on every file, and the column it lives in
 * already carries the "Transcription" heading, so hiding it a second time
 * behind its own toggle only cost a click to see settings that are read on
 * every visit.
 */
export function TranscriptionOptionsPanel({ options, onChange, disabled }: TranscriptionOptionsPanelProps) {
  const [draftTerm, setDraftTerm] = useState('')
  // Speaker counts and the glossary are for the recording that needs them, not
  // for the common case - they sit one level further in.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const terms = effectiveTerms(options)
  const isInverted = speakerBoundsInverted(options)

  function addDraftTerm() {
    const term = draftTerm.trim()
    if (!term) return
    setDraftTerm('')
    if (containsTerm(terms, term)) return
    onChange({
      addedTerms: [...options.addedTerms, term],
      // Re-adding something previously dismissed has to clear the dismissal,
      // or effectiveTerms would filter it straight back out.
      dismissedTerms: options.dismissedTerms.filter((entry) => entry.toLowerCase() !== term.toLowerCase()),
    })
  }

  function removeTerm(term: string) {
    onChange({
      addedTerms: options.addedTerms.filter((entry) => entry.toLowerCase() !== term.toLowerCase()),
      dismissedTerms: containsTerm(options.dismissedTerms, term)
        ? options.dismissedTerms
        : [...options.dismissedTerms, term],
    })
  }

  return (
    <section className="tx-options" aria-label="Transcription settings">
      <div className="tx-options__body">
      <label className="option-toggle">
        <input
          type="checkbox"
          className="checkbox"
          checked={options.includeTimestamps}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange({ includeTimestamps: event.target.checked })}
        />
        <span>
          <strong>Timestamps</strong>
          <small>Mark when each line of the transcript was spoken.</small>
        </span>
      </label>

      <label className="option-toggle">
        <input
          type="checkbox"
          className="checkbox"
          checked={options.diarize}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange({ diarize: event.target.checked })}
        />
        <span>
          <strong>Speaker diarization</strong>
          <small>Detect and label different speakers in the recording.</small>
        </span>
      </label>

      {/* Revealed directly under the checkbox that turns diarization on, rather
          than behind a second disclosure - the previous layout buried the one
          control most people reach for right after turning this on. */}
      {options.diarize && (
        <div className="speaker-count-row">
          <label className="speaker-count-field">
            <span>Min speakers</span>
            <select
              className="select"
              value={options.minSpeakers}
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange({ minSpeakers: event.target.value })}
            >
              <option value="">Auto</option>
              {SPEAKER_CHOICES.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <label className="speaker-count-field">
            <span>Max speakers</span>
            <select
              className="select"
              value={options.maxSpeakers}
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange({ maxSpeakers: event.target.value })}
            >
              <option value="">Auto</option>
              {SPEAKER_CHOICES.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {options.diarize && isInverted && (
        <small className="tx-field__hint tx-field__hint--warn">Minimum is above maximum — these will be swapped.</small>
      )}

      <button
        type="button"
        className="tx-advanced__toggle"
        aria-expanded={showAdvanced}
        aria-controls="tx-advanced"
        onClick={() => setShowAdvanced((open) => !open)}
      >
        <svg className="tx-advanced__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Context &amp; glossary
      </button>

      <div className="tx-advanced" id="tx-advanced" hidden={!showAdvanced}>
      {/* One field the user writes freely in. Whatever they write goes to the
          summariser whole - it follows instructions, so prose is useful there.
          Whisper can't use prose, so terminology is suggested from the text and
          shown below as chips: the user confirms or edits that list, and the
          list is what's sent. Nothing is inferred from how they punctuated it. */}
      <label className="tx-field">
        <span className="tx-field__label">Context &amp; terminology</span>
        <textarea
          rows={4}
          disabled={disabled}
          placeholder={CONTEXT_PLACEHOLDER}
          value={options.context}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange({ context: event.target.value })}
        />
      </label>

      <div className="tx-terms">
        <span className="tx-terms__label">
          Terms sent to the transcriber
          {terms.length > 0 && <span className="tx-field__count">{terms.length}</span>}
        </span>

        {terms.length === 0 && <span className="tx-terms__empty">No terms yet — anything you add here guides spelling.</span>}

        {terms.length > 0 && (
          <span className="tx-terms__chips" aria-live="polite">
            {terms.map((term) => (
              <span key={term} className="tx-terms__chip">
                {term}
                <button
                  type="button"
                  className="tx-terms__remove"
                  disabled={disabled}
                  aria-label={`Remove ${term}`}
                  onClick={() => removeTerm(term)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ))}
          </span>
        )}

        <span className="tx-terms__add">
          <input
            type="text"
            disabled={disabled}
            placeholder="Add a term…"
            aria-label="Add a term for the transcriber"
            value={draftTerm}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftTerm(event.target.value)}
            onBlur={addDraftTerm}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault()
                addDraftTerm()
              }
            }}
          />
        </span>

      </div>
      </div>
      </div>
    </section>
  )
}
