import type { TranscriptSegment } from './transcript'
import { API_BASE_URL } from '../apiBaseUrl'

export interface TranscribeOptions {
  diarize: boolean
  language?: string
  minSpeakers?: number
  maxSpeakers?: number
  /** The terms the user confirmed, as shown on screen. Sent explicitly so the
   *  server never has to re-derive intent from the prose. */
  contextTerms?: string[]
  /** Free text about the recording. Mined server-side for proper nouns to fill
   *  budget the confirmed terms didn't need; never sent to Whisper as prose. */
  context?: string
}

/** Wire shape - snake_case, straight off the FastAPI response. */
export interface TranscribeDiagnostics {
  context_terms_used?: number
  /** Terms that didn't fit the model's prompt window and were left out. */
  context_terms_dropped?: string[]
  /** Names the server lifted out of the prose to fill unused window. */
  context_terms_harvested?: string[]
  context_prompt_tokens?: number
  context_prompt_budget?: number
  diarization_speaker_count?: number
  speaker_min_requested?: number | null
  speaker_max_requested?: number | null
  /** False when a hint was given and the active backend couldn't take it. */
  speaker_hint_applied?: boolean
  /** Bounds the server had to clamp or reorder, described in words. */
  speaker_hint_adjustments?: string[]
  /** Null when there was no hint to measure the result against. */
  speaker_count_within_hint?: boolean | null
}

export interface TranscribeResult {
  segments: TranscriptSegment[]
  language: string
  diagnostics?: TranscribeDiagnostics
}

export async function transcribeAudio(
  file: Blob,
  fileName: string,
  { diarize, language, minSpeakers, maxSpeakers, contextTerms, context }: TranscribeOptions,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const formData = new FormData()
  formData.append('file', file, fileName)
  formData.append('diarize', String(diarize))
  if (language) formData.append('language', language)
  if (minSpeakers != null) formData.append('min_speakers', String(minSpeakers))
  if (maxSpeakers != null) formData.append('max_speakers', String(maxSpeakers))
  if (contextTerms?.length) formData.append('context_terms', contextTerms.join(', '))
  if (context?.trim()) formData.append('context', context.trim())

  const response = await fetch(`${API_BASE_URL}/api/transcribe`, {
    method: 'POST',
    body: formData,
    signal,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.detail || `Transcription failed (${response.status})`)
  }

  return response.json()
}
