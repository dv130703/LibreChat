import path from 'path';
import { spawn } from 'child_process';
import { logger } from '@librechat/data-schemas';

/** Mirrors `extractAudio.ts`'s `resolveFfmpegBin`, resolving `ffprobe`
 *  against `FFMPEG_PATH` when set. */
function resolveFfprobeBin(): string {
  const dir = process.env.FFMPEG_PATH;
  if (!dir) {
    return 'ffprobe';
  }
  return path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

/**
 * Server-side replacement for the Audio Transcriber composer's client-side
 * multi-channel heuristic (`probeMultiChannelAudio` in `UploadStep.tsx`) -
 * that heuristic decodes a possibly-truncated chunk of the file via the
 * browser's Web Audio API, which can silently mis-detect on large files or
 * codecs the browser can't decode at all. `ffprobe` reads container metadata
 * directly, so it's deterministic and has no size ceiling.
 *
 * Mirrors `extractAudioTrack` (same file, `child_process.spawn`, no wrapper
 * library) and the transcription service's own channel-probe step -
 * `ffprobe -select_streams a:0 -show_entries stream=channels -of csv=p=0`,
 * same fallback behavior (an unreadable channel count is treated as `1`
 * rather than raised, so it silently routes into the normal single-stream
 * diarization path instead of failing the whole probe).
 */
export function probeAudioChannels(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffprobe = spawn(resolveFfprobeBin(), [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=channels',
      '-of',
      'csv=p=0',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';
    ffprobe.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    ffprobe.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffprobe.on('error', (error) => {
      logger.warn('[probeAudioChannels] Failed to spawn ffprobe, defaulting to 1 channel', error);
      resolve(1);
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        logger.warn(
          `[probeAudioChannels] ffprobe exited with code ${code}, defaulting to 1 channel: ${stderr.slice(-500)}`,
        );
        resolve(1);
        return;
      }
      const channels = parseInt(stdout.trim(), 10);
      resolve(Number.isFinite(channels) && channels > 0 ? channels : 1);
    });
  });
}
