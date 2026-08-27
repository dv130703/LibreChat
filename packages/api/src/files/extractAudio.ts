import { spawn } from 'child_process';
import { logger } from '@librechat/data-schemas';

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
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-acodec',
      'aac',
      '-b:a',
      '128k',
      outputPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (error) => {
      logger.error('[extractAudioTrack] Failed to spawn ffmpeg', error);
      reject(error);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`);
      logger.error('[extractAudioTrack] ffmpeg failed', error);
      reject(error);
    });
  });
}
