import type { TranscriptSegment } from '../transcript/transcript'
import type { SummaryLength, SummaryStyle } from './summary'
import { API_BASE_URL } from '../apiBaseUrl'

export interface SummarizeOptions {
  style: SummaryStyle
  length: SummaryLength
  model: string
  /** What the recording is about, as supplied on the audio step. Unlike
   *  Whisper, the summariser follows instructions, so prose is useful here. */
  context?: string
}

export interface SummarizeResult {
  overview: string
  keyPoints: string[]
  actionItems: string[]
}

async function handleResponse<T>(response: Response, failureMessage: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.detail || `${failureMessage} (${response.status})`)
  }
  return response.json()
}

export async function listOllamaModels(): Promise<string[]> {
  const response = await fetch(`${API_BASE_URL}/api/ollama/models`)
  const data = await handleResponse<{ models: { name: string }[] }>(response, 'Could not list Ollama models')
  return data.models.map((model) => model.name)
}

export async function summarizeTranscript(
  segments: TranscriptSegment[],
  { style, length, model, context }: SummarizeOptions,
  signal?: AbortSignal,
): Promise<SummarizeResult> {
  const response = await fetch(`${API_BASE_URL}/api/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments, style, length, model, context: context?.trim() || null }),
    signal,
  })

  const data = await handleResponse<{ overview: string; key_points: string[]; action_items: string[] }>(
    response,
    'Summarization failed',
  )

  return { overview: data.overview, keyPoints: data.key_points, actionItems: data.action_items }
}
