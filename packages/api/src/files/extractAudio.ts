import path from 'path';
import { spawn } from 'child_process';
import { logger } from '@librechat/data-schemas';

/** Resolves to `FFMPEG_PATH/ffmpeg.exe` (or `/ffmpeg` on POSIX) when
 *  `FFMPEG_PATH` is set, otherwise falls back to the bare command, relying
 *  on ffmpeg being present on the system `PATH`. */
function resolveFfmpegBin(): string {
  const dir = process.env.FFMPEG_PATH;
  if (!dir) {
    return 'ffmpeg';
  }
  return path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

/**
 * Extracts (and normalizes) just the audio track from a media file into a
 * new AAC/M4A file at `outputPath`.
 *
 * Why this exists: video containers typically place keyframes several
 * seconds apart (sometimes 5-10s+), and browsers seek video by snapping to
 * the nearest keyframe rather than the exact requested time - fine for
 * scrubbing a movie, but far too imprecise for jumping to one transcript
 * line. Audio-only containers don't have this problem (any AAC frame
 * boundary is independently seekable), so extracting to one here is what
 * makes the Audio Transcriber's per-line/per-turn playback land where it's
 * supposed to. Applied uniformly to every upload, audio or video, so there's
 * one code path rather than a video/audio branch.
 */
export function extractAudioTrack(inputPath: string, outputPath: string): Promise<void> {
  return runFfmpeg(
    ['-y', '-i', inputPath, '-vn', '-acodec', 'aac', '-b:a', '128k', outputPath],
    'extractAudioTrack',
  );
}

/**
 * Cuts a `[startSeconds, endSeconds]` slice out of an audio/video file into
 * its own file at `outputPath` - used to grab one speaker's longest turn out
 * of the source recording so it can be sent to the Speaker Recognition
 * service for identification, without re-encoding the whole file.
 */
export function extractAudioClip(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<void> {
  return runFfmpeg(
    [
      '-y',
      '-ss',
      String(startSeconds),
      '-to',
      String(endSeconds),
      '-i',
      inputPath,
      '-vn',
      outputPath,
    ],
    'extractAudioClip',
  );
}

function runFfmpeg(args: string[], callerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(resolveFfmpegBin(), args);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (error) => {
      logger.error(`[${callerName}] Failed to spawn ffmpeg`, error);
      reject(error);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`);
      logger.error(`[${callerName}] ffmpeg failed`, error);
      reject(error);
    });
  });
}
