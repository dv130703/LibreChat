import { fetchFile } from '@ffmpeg/util'
import { loadFFmpeg } from './ffmpegClient'
import type { AudioFormat } from './formats'

export interface ConversionResult {
  blob: Blob
  url: string
  fileName: string
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '')
}

export async function convertAudio(
  file: File,
  targetFormat: AudioFormat,
  onProgress?: (ratio: number) => void,
): Promise<ConversionResult> {
  const ffmpeg = await loadFFmpeg()

  const inputFileName = file.name
  const outputFileName = `output.${targetFormat.extension}`

  const handleProgress = onProgress
    ? ({ progress }: { progress: number }) => onProgress(Math.min(1, Math.max(0, progress)))
    : undefined

  if (handleProgress) {
    ffmpeg.on('progress', handleProgress)
  }

  try {
    await ffmpeg.writeFile(inputFileName, await fetchFile(file))
    // -vn: drop any video stream so video files are reduced to audio-only output.
    // The format's encoderArgs pin the bitrate ffmpeg would otherwise choose for
    // itself, keeping the output in line with the size quoted on the intake page.
    await ffmpeg.exec(['-i', inputFileName, '-vn', ...targetFormat.encoderArgs, outputFileName])
    const data = await ffmpeg.readFile(outputFileName)

    const blob = new Blob([data as BlobPart], { type: targetFormat.mimeType })
    const url = URL.createObjectURL(blob)

    return { blob, url, fileName: `${stripExtension(inputFileName)}.${targetFormat.extension}` }
  } finally {
    if (handleProgress) {
      ffmpeg.off('progress', handleProgress)
    }
    await Promise.all([
      ffmpeg.deleteFile(inputFileName).catch(() => undefined),
      ffmpeg.deleteFile(outputFileName).catch(() => undefined),
    ])
  }
}
