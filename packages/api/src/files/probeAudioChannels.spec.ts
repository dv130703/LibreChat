import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { probeAudioChannels } from './probeAudioChannels';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

/** A fake `ChildProcess` just real enough for `probeAudioChannels`: emits on
 *  `stdout`/`stderr` (also `EventEmitter`s) and `close`/`error` on itself. */
function fakeChildProcess() {
  const proc = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  return proc;
}

describe('probeAudioChannels (transcription/ARCHITECTURE.md §6.2, Phase 4)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('resolves the channel count ffprobe reports', async () => {
    const proc = fakeChildProcess();
    mockSpawn.mockReturnValue(proc);

    const result = probeAudioChannels('/tmp/fake.m4a');
    (proc as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from('2\n'));
    proc.emit('close', 0);

    await expect(result).resolves.toBe(2);
    expect(mockSpawn).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining(['-select_streams', 'a:0', '/tmp/fake.m4a']),
    );
  });

  it('defaults to 1 when ffprobe exits non-zero', async () => {
    const proc = fakeChildProcess();
    mockSpawn.mockReturnValue(proc);

    const result = probeAudioChannels('/tmp/fake.m4a');
    (proc as unknown as { stderr: EventEmitter }).stderr.emit(
      'data',
      Buffer.from('no audio stream'),
    );
    proc.emit('close', 1);

    await expect(result).resolves.toBe(1);
  });

  it('defaults to 1 when ffprobe cannot be spawned at all', async () => {
    const proc = fakeChildProcess();
    mockSpawn.mockReturnValue(proc);

    const result = probeAudioChannels('/tmp/fake.m4a');
    proc.emit('error', new Error('ENOENT: ffprobe not found'));

    await expect(result).resolves.toBe(1);
  });

  it('defaults to 1 when ffprobe outputs something unparseable', async () => {
    const proc = fakeChildProcess();
    mockSpawn.mockReturnValue(proc);

    const result = probeAudioChannels('/tmp/fake.m4a');
    (proc as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from('N/A\n'));
    proc.emit('close', 0);

    await expect(result).resolves.toBe(1);
  });

  it('defaults to 1 when ffprobe reports zero channels', async () => {
    const proc = fakeChildProcess();
    mockSpawn.mockReturnValue(proc);

    const result = probeAudioChannels('/tmp/fake.m4a');
    (proc as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from('0\n'));
    proc.emit('close', 0);

    await expect(result).resolves.toBe(1);
  });
});
