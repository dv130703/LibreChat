import { useCallback, useState } from 'react'
import { convertAudio, type ConversionResult } from './convertAudio'
import type { AudioFormat } from './formats'

export type ConversionStatus = 'idle' | 'loading' | 'converting' | 'done' | 'error'

export function useAudioConverter() {
  const [status, setStatus] = useState<ConversionStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<ConversionResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * Returns the finished file, or null when the conversion failed. Callers that
   * have to act the moment it lands - handing it onward, moving to the next
   * stage - need it in hand here; waiting on `result` would put them a render
   * behind. The state is still set either way, for everything that just renders.
   */
  const convert = useCallback(async (file: File, format: AudioFormat): Promise<ConversionResult | null> => {
    setStatus('loading')
    setProgress(0)
    setError(null)
    setResult(null)

    try {
      const converted = await convertAudio(file, format, (ratio) => {
        setStatus('converting')
        setProgress(ratio)
      })
      setResult(converted)
      setStatus('done')
      return converted
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed')
      setStatus('error')
      return null
    }
  }, [])

  const adoptOriginal = useCallback((file: File) => {
    setError(null)
    setResult({ blob: file, url: URL.createObjectURL(file), fileName: file.name })
    setProgress(1)
    setStatus('done')
  }, [])

  const reset = useCallback(() => {
    setStatus('idle')
    setProgress(0)
    setResult(null)
    setError(null)
  }, [])

  return { status, progress, result, error, convert, adoptOriginal, reset }
}
