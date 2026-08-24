import { useEffect, useRef, useState } from 'react'
import {
  listOllamaModels,
  summarizeTranscript,
  summaryToPlainText,
  buildSummaryMarkdown,
  parseMarkdown,
  countSpeakers,
  countWords,
  formatTimestamp,
  useRotatingMessage,
  type SummaryLength,
  type SummaryResult,
  type SummaryStyle,
  type TranscriptSegment,
} from '../logic'
import { SummaryOptions } from '../summary-options'
import './SummaryPanel.css'

interface SummaryPanelProps {
  segments: TranscriptSegment[] | null
  summary: SummaryResult | null
  onSummaryChange: (summary: SummaryResult | null) => void
  /** The prose description of the recording, given on the audio step. Framing
   *  for the report - the summariser, unlike Whisper, can act on it. */
  context?: string
}

type GenerationStatus = 'idle' | 'processing' | 'done' | 'error'
type ModelsStatus = 'loading' | 'ready' | 'error'

const SUMMARISING_MESSAGES = [
  'Still working — the model is reading through the full transcript.',
  'Longer transcripts and the "Detailed" style both take a bit more time.',
  'Almost every summary finishes within a minute or two — hang tight.',
]

export function SummaryPanel({ segments, summary, onSummaryChange, context }: SummaryPanelProps) {
  const [style, setStyle] = useState<SummaryStyle>(summary?.style ?? 'concise')
  const [length, setLength] = useState<SummaryLength>(summary?.length ?? 'short')
  const [status, setStatus] = useState<GenerationStatus>(summary ? 'done' : 'idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draftMarkdown, setDraftMarkdown] = useState('')

  const [models, setModels] = useState<string[]>([])
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>('loading')
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState('')

  const copyTimeoutRef = useRef<number | undefined>(undefined)
  const abortControllerRef = useRef<AbortController | null>(null)
  const reassurance = useRotatingMessage(SUMMARISING_MESSAGES, status === 'processing')

  useEffect(() => {
    return () => window.clearTimeout(copyTimeoutRef.current)
  }, [])

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
    let cancelled = false

    listOllamaModels()
      .then((names) => {
        if (cancelled) return
        setModels(names)
        setModelsStatus('ready')
        setSelectedModel((current) => current || names[0] || '')
      })
      .catch((err) => {
        if (cancelled) return
        setModelsError(err instanceof Error ? err.message : 'Could not reach Ollama')
        setModelsStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function handleGenerate() {
    if (!segments || !selectedModel) return

    const controller = new AbortController()
    abortControllerRef.current = controller

    setStatus('processing')
    setError(null)
    setProgress(0)

    try {
      const result = await summarizeTranscript(
        segments,
        { style, length, model: selectedModel, context },
        controller.signal,
      )
      setProgress(1)
      onSummaryChange({
        style,
        length,
        markdown: buildSummaryMarkdown(style, result.overview, result.keyPoints, result.actionItems),
      })
      setIsEditing(false)
      setStatus('done')
    } catch (err) {
      setProgress(0)
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatus(summary ? 'done' : 'idle')
        return
      }
      setError(err instanceof Error ? err.message : 'Summarization failed')
      setStatus('error')
    } finally {
      abortControllerRef.current = null
    }
  }

  function handleCancelGenerate() {
    abortControllerRef.current?.abort()
  }

  async function handleCopy() {
    if (!summary) return
    try {
      await navigator.clipboard.writeText(summaryToPlainText(summary))
      setCopied(true)
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied by the browser; the button simply won't confirm.
    }
  }

  function handleDownload() {
    if (!summary) return
    const blob = new Blob([summaryToPlainText(summary)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'summary.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function handleStartEdit() {
    if (!summary) return
    setDraftMarkdown(summary.markdown)
    setIsEditing(true)
  }

  function handleSaveEdit() {
    if (!summary) return
    onSummaryChange({ ...summary, markdown: draftMarkdown })
    setIsEditing(false)
  }

  function handleCancelEdit() {
    setIsEditing(false)
  }

  const isBusy = status === 'processing'
  const wordCount = segments ? countWords(segments) : 0
  const speakerCount = segments ? countSpeakers(segments) : 0
  const duration = segments && segments.length > 0 ? formatTimestamp(segments[segments.length - 1].end) : '0:00'
  const canGenerate = !isBusy && !!selectedModel && !!segments && segments.length > 0

  return (
    <div className="summary-layout">
      <div className="summary-rail card">
        {segments && (
          <div className="summary-stats">
            <div>
              <span className="summary-stats__value">{wordCount}</span>
              <span className="summary-stats__label">Words</span>
            </div>
            <div>
              <span className="summary-stats__value">{duration}</span>
              <span className="summary-stats__label">Duration</span>
            </div>
            <div>
              <span className="summary-stats__value">{speakerCount}</span>
              <span className="summary-stats__label">Speakers</span>
            </div>
          </div>
        )}

        <SummaryOptions
          models={models}
          modelsStatus={modelsStatus}
          modelsError={modelsError}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          style={style}
          onStyleChange={setStyle}
          length={length}
          onLengthChange={setLength}
          isBusy={isBusy}
          progress={progress}
          hasSegments={segments !== null}
          hasSummary={summary !== null}
          canGenerate={canGenerate}
          error={error}
          onGenerate={handleGenerate}
          onCancel={handleCancelGenerate}
          reassurance={reassurance}
        />
      </div>

      <section className="summary-panel card">
        {summary && (
          <div className="panel-header">
            <div className="panel-header__actions">
              {isEditing ? (
                <>
                  <button type="button" className="button button--ghost button--small" onClick={handleCancelEdit}>
                    Cancel
                  </button>
                  <button type="button" className="button button--primary button--small" onClick={handleSaveEdit}>
                    Save
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="button button--ghost button--small" onClick={handleStartEdit}>
                    Edit
                  </button>
                  <button type="button" className="button button--ghost button--small" onClick={handleCopy}>
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                  <button type="button" className="button button--ghost button--small" onClick={handleDownload}>
                    .txt
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <div className="summary-panel__body">
          {summary && isEditing ? (
            <textarea
              className="summary-editor"
              value={draftMarkdown}
              onChange={(event) => setDraftMarkdown(event.target.value)}
              placeholder="Write the summary in markdown…"
              autoFocus
            />
          ) : summary && status !== 'processing' ? (
            <div className="summary-content">{parseMarkdown(summary.markdown)}</div>
          ) : (
            segments &&
            status !== 'processing' && (
              <div className="empty-state">
                <span className="empty-state__icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M7 8h10M7 12h10M7 16h6" />
                  </svg>
                </span>
                <span className="empty-state__title">No summary yet</span>
                <span className="empty-state__hint">Generate one to get an overview, key points, and action items.</span>
              </div>
            )
          )}
        </div>
      </section>
    </div>
  )
}
