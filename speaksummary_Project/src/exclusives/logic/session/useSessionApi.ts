/**
 * React hooks for the Session API (Tier 4b).
 * Provides useSessionQuality, useSessionTranscribe, etc.
 */

import { useState, useCallback } from 'react'
import * as sessionApi from './sessionApi'
import type { Manifest, AudioQualityAssessment, TranscriptionResponse } from './types'

export interface UseSessionQualityState {
  isLoading: boolean
  manifest: Manifest | null
  error: string | null
}

/**
 * Hook: Create a session and check quality.
 * Replaces useAudioQualityCheck for the new session API.
 */
export function useSessionQuality() {
  const [state, setState] = useState<UseSessionQualityState>({
    isLoading: false,
    manifest: null,
    error: null,
  })

  const checkQuality = useCallback(async (file: File) => {
    setState({ isLoading: true, manifest: null, error: null })

    // Create session (uploads file, derives artifacts, measures quality)
    const createResult = await sessionApi.createSession(file)

    if ('error' in createResult && createResult.error) {
      setState({
        isLoading: false,
        manifest: null,
        error: createResult.error.message,
      })
      return
    }

    setState({
      isLoading: false,
      manifest: createResult.manifest,
      error: null,
    })
  }, [])

  return {
    ...state,
    checkQuality,
  }
}

export interface UseSessionPreprocessState {
  isLoading: boolean
  assessment: AudioQualityAssessment | null
  error: string | null
}

/**
 * Hook: Preprocess a session and get updated quality assessment.
 */
export function useSessionPreprocess() {
  const [state, setState] = useState<UseSessionPreprocessState>({
    isLoading: false,
    assessment: null,
    error: null,
  })

  const preprocess = useCallback(
    async (sha256: string, options: { adjustGain?: boolean; replace?: boolean } = {}) => {
      setState({ isLoading: true, assessment: null, error: null })

      const result = await sessionApi.preprocessSession(sha256, options)

      if ('error' in result && result.error) {
        setState({
          isLoading: false,
          assessment: null,
          error: result.error.message,
        })
        return
      }

      setState({
        isLoading: false,
        assessment: result.assessment,
        error: null,
      })
    },
    [],
  )

  return {
    ...state,
    preprocess,
  }
}

export interface UseSessionTranscribeState {
  isLoading: boolean
  response: TranscriptionResponse | null
  error: string | null
}

/**
 * Hook: Transcribe a session.
 */
export function useSessionTranscribe() {
  const [state, setState] = useState<UseSessionTranscribeState>({
    isLoading: false,
    response: null,
    error: null,
  })

  const transcribe = useCallback(
    async (
      sha256: string,
      options: {
        diarize?: boolean
        language?: string
        autoDetect?: boolean
        minSpeakers?: number
        maxSpeakers?: number
      } = {},
    ) => {
      setState({ isLoading: false, response: null, error: null })

      const result = await sessionApi.transcribeSession(sha256, options)

      if ('error' in result && result.error) {
        setState({
          isLoading: false,
          response: null,
          error: result.error.message,
        })
        return
      }

      setState({
        isLoading: false,
        response: result.response,
        error: null,
      })
    },
    [],
  )

  return {
    ...state,
    transcribe,
  }
}
