/**
 * Session API client for the new tier 2.0 backend.
 * Replaces the old transcribeApi for the session-based workflow.
 */

import type { AudioQualityAssessment, Manifest, TranscriptionResponse } from './types'

// Same-origin by default; see ../apiBaseUrl.ts for why (dev-server proxy).
const API_BASE = import.meta.env.VITE_API_URL || '/api'

export interface SessionApiError {
  message: string
  status: number
}

/**
 * Create a new session: upload file and register it with the backend.
 * Returns a Manifest with file metadata, artifact hashes, and initial quality assessment.
 */
export async function createSession(file: File): Promise<{ manifest: Manifest; error?: never } | { error: SessionApiError; manifest?: never }> {
  try {
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const text = await response.text()
      return {
        error: {
          message: text || `Session creation failed: ${response.status}`,
          status: response.status,
        },
      }
    }

    const manifest = (await response.json()) as Manifest
    return { manifest }
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error',
        status: 0,
      },
    }
  }
}

/**
 * Get quality assessment for a registered session (from cached manifest).
 * Does not re-upload or re-measure — uses the assessment computed during ingest.
 */
export async function getQuality(sha256: string): Promise<{ assessment: AudioQualityAssessment; error?: never } | { error: SessionApiError; assessment?: never }> {
  try {
    const response = await fetch(`${API_BASE}/sessions/${sha256}/quality`)

    if (!response.ok) {
      const text = await response.text()
      return {
        error: {
          message: text || `Quality check failed: ${response.status}`,
          status: response.status,
        },
      }
    }

    const assessment = (await response.json()) as AudioQualityAssessment
    return { assessment }
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error',
        status: 0,
      },
    }
  }
}

/**
 * Apply optional preprocessing (loudness normalization).
 * Returns the quality assessment of the preprocessed audio.
 * If replace=true, updates the manifest to prefer the preprocessed artifact for transcription.
 */
export async function preprocessSession(
  sha256: string,
  options: {
    adjustGain?: boolean
    replace?: boolean
  } = {},
): Promise<{ assessment: AudioQualityAssessment; error?: never } | { error: SessionApiError; assessment?: never }> {
  try {
    const formData = new FormData()
    if (options.adjustGain) formData.append('adjust_gain', 'true')
    if (options.replace) formData.append('replace', 'true')

    const response = await fetch(`${API_BASE}/sessions/${sha256}/preprocess`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const text = await response.text()
      return {
        error: {
          message: text || `Preprocessing failed: ${response.status}`,
          status: response.status,
        },
      }
    }

    const assessment = (await response.json()) as AudioQualityAssessment
    return { assessment }
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error',
        status: 0,
      },
    }
  }
}

/**
 * Transcribe audio (synchronous).
 * Uses the manifest's preferred ASR artifact (original or preprocessed).
 * Diarization always uses the unpreprocessed artifact.
 */
export async function transcribeSession(
  sha256: string,
  options: {
    diarize?: boolean
    language?: string
    autoDetect?: boolean
    minSpeakers?: number
    maxSpeakers?: number
  } = {},
): Promise<{ response: TranscriptionResponse; error?: never } | { error: SessionApiError; response?: never }> {
  try {
    const formData = new FormData()
    if (options.diarize !== undefined) formData.append('diarize', options.diarize ? 'true' : 'false')
    if (options.language) formData.append('language', options.language)
    if (options.autoDetect) formData.append('auto_detect', 'true')
    if (options.minSpeakers !== undefined) formData.append('min_speakers', String(options.minSpeakers))
    if (options.maxSpeakers !== undefined) formData.append('max_speakers', String(options.maxSpeakers))

    const response = await fetch(`${API_BASE}/sessions/${sha256}/transcribe`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const text = await response.text()
      return {
        error: {
          message: text || `Transcription failed: ${response.status}`,
          status: response.status,
        },
      }
    }

    const transcriptionResponse = (await response.json()) as TranscriptionResponse
    return { response: transcriptionResponse }
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error',
        status: 0,
      },
    }
  }
}

/**
 * Retrieve cached transcription result (if available).
 * Returns 404 if the result hasn't been computed yet (e.g., for async operations).
 */
export async function getResult(sha256: string): Promise<{ response: TranscriptionResponse; error?: never } | { error: SessionApiError; response?: never }> {
  try {
    const response = await fetch(`${API_BASE}/sessions/${sha256}/result`)

    if (!response.ok) {
      const text = await response.text()
      return {
        error: {
          message: text || `Result retrieval failed: ${response.status}`,
          status: response.status,
        },
      }
    }

    const transcriptionResponse = (await response.json()) as TranscriptionResponse
    return { response: transcriptionResponse }
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error',
        status: 0,
      },
    }
  }
}
