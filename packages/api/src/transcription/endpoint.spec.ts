import { getTranscriptionApiUrl } from './endpoint';

describe('getTranscriptionApiUrl', () => {
  const { TRANSCRIPTION_API_URL, RAG_API_URL } = process.env;

  afterEach(() => {
    process.env.TRANSCRIPTION_API_URL = TRANSCRIPTION_API_URL;
    process.env.RAG_API_URL = RAG_API_URL;
  });

  function setEnv(values: { transcription?: string; rag?: string }) {
    delete process.env.TRANSCRIPTION_API_URL;
    delete process.env.RAG_API_URL;
    if (values.transcription != null) {
      process.env.TRANSCRIPTION_API_URL = values.transcription;
    }
    if (values.rag != null) {
      process.env.RAG_API_URL = values.rag;
    }
  }

  it('returns undefined when neither is configured', () => {
    setEnv({});
    expect(getTranscriptionApiUrl()).toBeUndefined();
  });

  it('falls back to RAG_API_URL, the single-machine default', () => {
    setEnv({ rag: 'http://127.0.0.1:1234' });
    expect(getTranscriptionApiUrl()).toBe('http://127.0.0.1:1234');
  });

  it('prefers TRANSCRIPTION_API_URL so ASR can run on another machine', () => {
    setEnv({ rag: 'http://127.0.0.1:1234', transcription: 'http://192.168.1.123:1234' });
    expect(getTranscriptionApiUrl()).toBe('http://192.168.1.123:1234');
  });

  /** The value is concatenated with `/transcribe`, so a trailing slash would
   *  produce a double-slashed path against the worker. */
  it('trims trailing slashes from either source', () => {
    setEnv({ transcription: 'http://192.168.1.123:1234//' });
    expect(getTranscriptionApiUrl()).toBe('http://192.168.1.123:1234');

    setEnv({ rag: 'http://127.0.0.1:1234/' });
    expect(getTranscriptionApiUrl()).toBe('http://127.0.0.1:1234');
  });

  it('ignores an empty TRANSCRIPTION_API_URL rather than disabling transcription', () => {
    setEnv({ rag: 'http://127.0.0.1:1234', transcription: '' });
    expect(getTranscriptionApiUrl()).toBe('http://127.0.0.1:1234');
  });
});
