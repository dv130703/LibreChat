import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'

const CORE_VERSION = '0.12.9'
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`

let ffmpeg: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null

export function getFFmpeg(): FFmpeg {
  if (!ffmpeg) {
    ffmpeg = new FFmpeg()
  }
  return ffmpeg
}

export async function loadFFmpeg(): Promise<FFmpeg> {
  const instance = getFFmpeg()
  if (instance.loaded) {
    return instance
  }

  if (!loadPromise) {
    loadPromise = (async () => {
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
      ])
      await instance.load({ coreURL, wasmURL })
      return instance
    })().catch((error: unknown) => {
      loadPromise = null
      throw error
    })
  }

  return loadPromise
}
