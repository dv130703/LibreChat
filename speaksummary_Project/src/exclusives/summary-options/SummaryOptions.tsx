import { useState } from 'react'
import { Disclosure } from '../disclosure'
import type { SummaryLength, SummaryStyle } from '../logic'
import './SummaryOptions.css'

type ModelsStatus = 'loading' | 'ready' | 'error'

export const STYLE_OPTIONS: { value: SummaryStyle; label: string; description: string }[] = [
  { value: 'concise', label: 'Concise', description: 'A short paragraph overview.' },
  { value: 'bullets', label: 'Bullet points', description: 'Key points as a scannable list.' },
  { value: 'detailed', label: 'Detailed', description: 'Overview, key points, and action items.' },
]

interface SummaryOptionsProps {
  models: string[]
  modelsStatus: ModelsStatus
  modelsError: string | null
  selectedModel: string
  onSelectedModelChange: (model: string) => void
  style: SummaryStyle
  onStyleChange: (style: SummaryStyle) => void
  length: SummaryLength
  onLengthChange: (length: SummaryLength) => void
  isBusy: boolean
  progress: number
  hasSegments: boolean
  hasSummary: boolean
  canGenerate: boolean
  error: string | null
  onGenerate: () => void
  onCancel: () => void
  /** Rotating reassurance copy shown next to the progress bar while busy - there's
   *  no real progress signal from the backend, so this is what fills the wait. */
  reassurance?: string
}

export function SummaryOptions({
  models,
  modelsStatus,
  modelsError,
  selectedModel,
  onSelectedModelChange,
  style,
  onStyleChange,
  length,
  onLengthChange,
  isBusy,
  progress,
  hasSegments,
  hasSummary,
  canGenerate,
  error,
  onGenerate,
  onCancel,
  reassurance,
}: SummaryOptionsProps) {
  const optionsSummary = `${selectedModel || 'no model'} · ${STYLE_OPTIONS.find((o) => o.value === style)?.label} · ${length}`

  // Regenerating overwrites any hand-edited summary text with no way back, so it
  // asks first, same as the transcript step's Regenerate. The first Generate has
  // nothing to lose, so it skips it.
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)

  function handlePrimaryClick() {
    if (hasSummary) {
      setConfirmingRegenerate(true)
      return
    }
    onGenerate()
  }

  return (
    <div className="summary-rail__body">
      <Disclosure label="Options" summary={optionsSummary} disabled={isBusy}>
        <div className="option-field">
          <label className="option-field__label" htmlFor="summary-options-model">
            Model
          </label>
          {modelsStatus === 'loading' && <p className="status-message status-message--hint">Loading Ollama models…</p>}
          {modelsStatus === 'error' && (
            <p className="status-message status-message--error">
              {modelsError} — make sure Ollama is running (<code>ollama serve</code>).
            </p>
          )}
          {modelsStatus === 'ready' && models.length === 0 && (
            <p className="status-message status-message--error">
              No chat-capable models found. Pull one with e.g. <code>ollama pull llama3.1</code>.
            </p>
          )}
          {modelsStatus === 'ready' && models.length > 0 && (
            <select
              id="summary-options-model"
              className="option-select"
              value={selectedModel}
              disabled={isBusy}
              onChange={(event) => onSelectedModelChange(event.target.value)}
            >
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="option-field">
          <span className="option-field__label">Style</span>
          <div className="option-field__choices">
            {STYLE_OPTIONS.map((option) => (
              <label key={option.value} className={`option-card${style === option.value ? ' option-card--checked' : ''}`}>
                <input
                  type="radio"
                  name="summary-style"
                  value={option.value}
                  checked={style === option.value}
                  disabled={isBusy}
                  onChange={() => onStyleChange(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small> — {option.description}</small>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="option-field">
          <span className="option-field__label">Length</span>
          <div className="option-field__choices option-field__choices--row">
            <label className="option-radio option-radio--compact">
              <input
                type="radio"
                name="summary-length"
                value="short"
                checked={length === 'short'}
                disabled={isBusy}
                onChange={() => onLengthChange('short')}
              />
              <span>Short</span>
            </label>
            <label className="option-radio option-radio--compact">
              <input
                type="radio"
                name="summary-length"
                value="long"
                checked={length === 'long'}
                disabled={isBusy}
                onChange={() => onLengthChange('long')}
              />
              <span>Long</span>
            </label>
          </div>
        </div>
      </Disclosure>

      {confirmingRegenerate ? (
        <p className="confirm-inline" role="status">
          <span>Overwrite the current summary?</span>
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
        <div className="summary-rail__busy-row">
          <button type="button" className="button button--primary" disabled>
            {`Summarising… ${Math.round(progress * 100)}%`}
          </button>
          <button type="button" className="button button--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button button--primary button--full"
          onClick={handlePrimaryClick}
          disabled={!canGenerate}
        >
          {hasSummary ? 'Regenerate summary' : 'Generate summary'}
        </button>
      )}

      {isBusy && (
        <div className="progress-bar">
          <div className="progress-bar__fill" style={{ transform: `scaleX(${Math.max(0.06, progress)})` }} />
        </div>
      )}

      {isBusy && reassurance && <p className="status-message status-message--hint">{reassurance}</p>}

      {!hasSegments && (
        <p className="status-message status-message--hint">Generate a transcript first to summarise it.</p>
      )}

      {error && (
        <p role="alert" className="status-message status-message--error">
          {error}
        </p>
      )}
    </div>
  )
}
