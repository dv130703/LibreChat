import { useCallback, useState } from 'react'
import type { AudioQuality } from '../../audio-intake/audio-quality'
import { API_BASE_URL } from '../apiBaseUrl'

interface QualityCheckOptions {
  file: File
  onQualityDetected?: (quality: AudioQuality) => void
}

/** The repaired recording, and what it measures at now that it's been fixed. */
export interface PreprocessResult {
  file: File
  quality: AudioQuality
}

// Fallback quality estimation when backend is unavailable
function estimateQualityFallback(): AudioQuality {
  return {
    rating: 'acceptable',
    description: 'Basic quality assessment (backend unavailable - showing estimates)',
    should_adjust_gain: false,
    show_clipping_warning: false,
    // Typical for speech, and nothing to measure against without the backend.
    lufs_integrated: -20,
    clipping_percentage: 0,
  }
}

export function useAudioQualityCheck() {
  const [isChecking, setIsChecking] = useState(false)
  const [quality, setQuality] = useState<AudioQuality | null>(null)
  const [error, setError] = useState<string | null>(null)

  const checkQuality = useCallback(async ({ file, onQualityDetected }: QualityCheckOptions) => {
    setIsChecking(true)
    setError(null)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(`${API_BASE_URL}/api/quality-check`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        // Fallback to estimation when backend is unavailable
        console.log('Quality check API failed, using fallback estimation')
        const fallbackQuality = estimateQualityFallback()
        setQuality(fallbackQuality)
        onQualityDetected?.(fallbackQuality)
        return
      }

      const data = await response.json()
      const qualityMetrics = data.quality_metrics

      // Transform backend response to frontend type
      const quality: AudioQuality = {
        rating: qualityMetrics.assessment?.rating ?? 'acceptable',
        description: qualityMetrics.assessment?.description ?? 'Unable to assess audio quality',
        should_adjust_gain: qualityMetrics.assessment?.should_adjust_gain ?? false,
        show_clipping_warning: qualityMetrics.assessment?.show_clipping_warning ?? false,
        lufs_integrated: qualityMetrics.lufs_integrated,
        clipping_percentage: qualityMetrics.clipping?.clipping_percentage,
      }

      setQuality(quality)
      onQualityDetected?.(quality)
    } catch (err) {
      // Fallback to estimation when API call fails
      console.log('Quality check API error, using fallback estimation:', err)
      const fallbackQuality = estimateQualityFallback()
      setQuality(fallbackQuality)
      onQualityDetected?.(fallbackQuality)
    } finally {
      setIsChecking(false)
    }
  }, [])

  /**
   * Normalise the recording's level on the backend and hand back the repaired
   * audio itself.
   *
   * The returned file is the point: the caller swaps it in for the one it holds
   * so the player, the waveform and the transcription all work from the fixed
   * recording. Returns null when nothing could be repaired, leaving the original
   * in place and the reason in `error`.
   */
  const applyPreprocessing = useCallback(
    async (file: File): Promise<PreprocessResult | null> => {
      setIsChecking(true)
      setError(null)

      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('apply_gain', 'true')

        const response = await fetch(`${API_BASE_URL}/api/preprocess`, {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }))
          setError(errorData.detail || 'Preprocessing failed')
          return null
        }

        // The repaired audio is the body; its re-measured quality rides in the header.
        const blob = await response.blob()
        const header = response.headers.get('X-Quality-Metrics')
        if (!header) {
          setError('The server returned repaired audio without its measurements.')
          return null
        }

        const qualityMetrics = JSON.parse(header)
        const quality: AudioQuality = {
          rating: qualityMetrics.assessment?.rating ?? 'acceptable',
          description: qualityMetrics.assessment?.description ?? 'Unable to assess audio quality',
          should_adjust_gain: qualityMetrics.assessment?.should_adjust_gain ?? false,
          show_clipping_warning: qualityMetrics.assessment?.show_clipping_warning ?? false,
          lufs_integrated: qualityMetrics.lufs_integrated,
          clipping_percentage: qualityMetrics.clipping?.clipping_percentage,
        }

        // Named off the original so the file stays recognisable after the swap.
        const baseName = file.name.replace(/\.[^.]+$/, '')
        const repaired = new File([blob], `${baseName}-repaired.wav`, { type: 'audio/wav' })

        setQuality(quality)
        return { file: repaired, quality }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Preprocessing failed'
        setError(errorMessage)
        return null
      } finally {
        setIsChecking(false)
      }
    },
    [],
  )

  const reset = useCallback(() => {
    setQuality(null)
    setError(null)
    setIsChecking(false)
  }, [])

  return {
    isChecking,
    quality,
    error,
    checkQuality,
    applyPreprocessing,
    reset,
  }
}
