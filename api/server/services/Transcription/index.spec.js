const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  generateShortLivedToken: jest.fn(() => 'fake-jwt'),
  logAxiosError: jest.fn(),
}));
jest.mock('fs', () => ({
  createReadStream: jest.fn(() => require('stream').Readable.from(['fake-audio-bytes'])),
}));
jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('~/server/services/Files/VectorDB/crud', () => ({
  uploadVectors: jest.fn(),
}));

const { uploadVectors } = require('~/server/services/Files/VectorDB/crud');
const fsPromises = require('fs/promises');
const fs = require('fs');
const { transcribeAndEmbed, embedTranscript, formatTimestamp, formatLine } = require('./index');

const req = { user: { id: 'user-1' } };
const multerFile = { path: '/tmp/upload-1', originalname: 'meeting.mp3', mimetype: 'audio/mpeg' };

describe('formatTimestamp / formatLine', () => {
  it('formats seconds under an hour as mm:ss.s', () => {
    expect(formatTimestamp(125.4)).toBe('02:05.4');
  });

  it('formats seconds over an hour as h:mm:ss.s', () => {
    expect(formatTimestamp(3725)).toBe('1:02:05.0');
  });

  it('keeps tenths-of-a-second precision instead of rounding to a whole second', () => {
    // Whole-second rounding would collapse both of these to "02:05" -
    // indistinguishable, and imprecise enough to leak into neighboring lines
    // when used as an auto-stop boundary for bounded playback.
    expect(formatTimestamp(125.04)).toBe('02:05.0');
    expect(formatTimestamp(125.94)).toBe('02:05.9');
  });

  it('rolls a tenths-rounding carry over into the next second correctly', () => {
    expect(formatTimestamp(59.96)).toBe('01:00.0');
  });

  it('honors includeTimestamps/diarize independently', () => {
    const segment = { start: 5, end: 7.2, speaker: 'Speaker 1', text: 'Hi.' };
    expect(formatLine(segment, { includeTimestamps: true, diarize: true })).toBe(
      '[00:05.0-00:07.2] Speaker 1: Hi.',
    );
    expect(formatLine(segment, { includeTimestamps: false, diarize: true })).toBe('Speaker 1: Hi.');
    expect(formatLine(segment, { includeTimestamps: true, diarize: false })).toBe(
      '[00:05.0-00:07.2] Hi.',
    );
    expect(formatLine(segment, { includeTimestamps: false, diarize: false })).toBe('Hi.');
  });
});

describe('transcribeAndEmbed', () => {
  beforeEach(() => {
    process.env.RAG_API_URL = 'http://rag.test';
    uploadVectors.mockResolvedValue({ embedded: true });
    axios.post.mockResolvedValue({
      data: {
        segments: [
          { start: 0, end: 2, speaker: 'SPEAKER_00', text: 'Hello there.' },
          { start: 2, end: 4, speaker: 'SPEAKER_01', text: 'General Kenobi.' },
        ],
        language: 'en',
        diagnostics: { diarization_speaker_count: 2 },
      },
    });
  });

  afterEach(() => {
    delete process.env.RAG_API_URL;
    jest.clearAllMocks();
  });

  it('throws when RAG_API_URL is not configured', async () => {
    delete process.env.RAG_API_URL;
    await expect(
      transcribeAndEmbed({ req, file: multerFile, sourceFileId: 'source-1' }),
    ).rejects.toThrow('RAG_API_URL is not set');
  });

  it('posts diarize/min/max speakers from options, reading from the multer file path', async () => {
    await transcribeAndEmbed({
      req,
      file: multerFile,
      sourceFileId: 'source-1',
      options: { diarize: true, minSpeakers: 2, maxSpeakers: 4 },
    });

    expect(fs.createReadStream).toHaveBeenCalledWith(multerFile.path);
    const [url] = axios.post.mock.calls[0];
    expect(url).toBe('http://rag.test/transcribe');
  });

  it('embeds the transcript under a deterministic id derived from sourceFileId', async () => {
    const result = await transcribeAndEmbed({
      req,
      file: multerFile,
      sourceFileId: 'source-1',
      options: { includeTimestamps: true, diarize: true },
    });

    expect(result.transcriptFileId).toBe('source-1-transcript');
    expect(result.embedded).toBe(true);
    expect(result.text).toBe(
      '[00:00.0-00:02.0] SPEAKER_00: Hello there.\n[00:02.0-00:04.0] SPEAKER_01: General Kenobi.',
    );
    expect(uploadVectors).toHaveBeenCalledWith(
      expect.objectContaining({ req, file_id: 'source-1-transcript' }),
    );
    expect(fsPromises.writeFile).toHaveBeenCalled();
    expect(fsPromises.unlink).toHaveBeenCalled();
  });

  it('returns no transcript when no speech segments are found, without embedding', async () => {
    axios.post.mockResolvedValue({ data: { segments: [], language: 'en' } });

    const result = await transcribeAndEmbed({ req, file: multerFile, sourceFileId: 'source-1' });

    expect(result.transcriptFileId).toBeNull();
    expect(result.embedded).toBe(false);
    expect(uploadVectors).not.toHaveBeenCalled();
  });

  it('defaults to includeTimestamps/diarize=true when no options are provided', async () => {
    const result = await transcribeAndEmbed({ req, file: multerFile, sourceFileId: 'source-1' });
    expect(result.text).toBe(
      '[00:00.0-00:02.0] SPEAKER_00: Hello there.\n[00:02.0-00:04.0] SPEAKER_01: General Kenobi.',
    );
  });
});

describe('embedTranscript retry behavior', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not retry when the first attempt succeeds', async () => {
    uploadVectors.mockResolvedValueOnce({ embedded: true });

    const result = await embedTranscript({
      req,
      file_id: 'file-1',
      filename: 'transcript.md',
      text: 'Speaker 1: Hi.',
    });

    expect(result).toBe(true);
    expect(uploadVectors).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds on the second attempt', async () => {
    uploadVectors
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ embedded: true });

    const result = await embedTranscript({
      req,
      file_id: 'file-1',
      filename: 'transcript.md',
      text: 'Speaker 1: Hi.',
    });

    expect(result).toBe(true);
    expect(uploadVectors).toHaveBeenCalledTimes(2);
  });

  it('gives up and returns false after exhausting every attempt', async () => {
    uploadVectors.mockRejectedValue(new Error('RAG server unreachable'));

    const result = await embedTranscript({
      req,
      file_id: 'file-1',
      filename: 'transcript.md',
      text: 'Speaker 1: Hi.',
    });

    expect(result).toBe(false);
    expect(uploadVectors).toHaveBeenCalledTimes(3);
  }, 10000);

  it('always cleans up the temp file, even after every attempt fails', async () => {
    uploadVectors.mockRejectedValue(new Error('RAG server unreachable'));

    await embedTranscript({ req, file_id: 'file-1', filename: 'transcript.md', text: 'Hi.' });

    expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
  }, 10000);
});
