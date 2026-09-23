import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { extractAudioClip } from './extractAudio';

function ffprobeDurationSeconds(filePath: string): number {
  const result = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return parseFloat(result.stdout.toString().trim());
}

describe('extractAudioClip', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-audio-clip-'));
  const sourcePath = path.join(workDir, 'source.wav');

  beforeAll(() => {
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', sourcePath]);
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('cuts out only the requested [start, end] time range', async () => {
    const outputPath = path.join(workDir, 'clip.wav');

    await extractAudioClip(sourcePath, outputPath, 0.5, 1.5);

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(ffprobeDurationSeconds(outputPath)).toBeCloseTo(1, 1);
  });
});
