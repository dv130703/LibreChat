import { getSpeakerIdentificationConfig, getTranscriptionApiUrl } from './endpoint';

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

describe('getSpeakerIdentificationConfig', () => {
  const original = {
    model: process.env.SPEAKER_ID_MODEL,
    baseURL: process.env.SPEAKER_ID_BASE_URL,
    apiKey: process.env.SPEAKER_ID_API_KEY,
    ollama: process.env.OLLAMA_BASE_URL,
  };

  afterEach(() => {
    process.env.SPEAKER_ID_MODEL = original.model;
    process.env.SPEAKER_ID_BASE_URL = original.baseURL;
    process.env.SPEAKER_ID_API_KEY = original.apiKey;
    process.env.OLLAMA_BASE_URL = original.ollama;
  });

  function setEnv(values: Record<string, string | undefined>) {
    for (const key of [
      'SPEAKER_ID_MODEL',
      'SPEAKER_ID_BASE_URL',
      'SPEAKER_ID_API_KEY',
      'OLLAMA_BASE_URL',
    ]) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) {
      if (value != null) {
        process.env[key] = value;
      }
    }
  }

  /** Opt-in by configuration: an install that never sets a model gets the
   *  previous behavior exactly, with no calls to anything. */
  it('is disabled when no model is configured', () => {
    setEnv({ OLLAMA_BASE_URL: 'http://localhost:11434' });
    expect(getSpeakerIdentificationConfig()).toBeUndefined();
  });

  /** Interview audio is sensitive, so the default target is the local
   *  Ollama already configured for this instance rather than a cloud API. */
  it('defaults to the local Ollama endpoint', () => {
    setEnv({ SPEAKER_ID_MODEL: 'qwen3.8:27b', OLLAMA_BASE_URL: 'http://localhost:11434' });

    expect(getSpeakerIdentificationConfig()).toEqual({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen3.8:27b',
    });
  });

  it('lets an explicit endpoint and key override the Ollama default', () => {
    setEnv({
      SPEAKER_ID_MODEL: 'gpt-4o-mini',
      SPEAKER_ID_BASE_URL: 'https://api.openai.com/v1',
      SPEAKER_ID_API_KEY: 'sk-test',
      OLLAMA_BASE_URL: 'http://localhost:11434',
    });

    expect(getSpeakerIdentificationConfig()).toEqual({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
  });

  it('is disabled when a model is set but there is no endpoint to call', () => {
    setEnv({ SPEAKER_ID_MODEL: 'qwen3.8:27b' });
    expect(getSpeakerIdentificationConfig()).toBeUndefined();
  });
});
