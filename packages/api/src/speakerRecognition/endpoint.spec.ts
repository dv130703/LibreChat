import { getSpeakerRecognitionApiUrl } from './endpoint';

describe('getSpeakerRecognitionApiUrl', () => {
  const { SPEAKER_RECOGNITION_API_URL } = process.env;

  afterEach(() => {
    process.env.SPEAKER_RECOGNITION_API_URL = SPEAKER_RECOGNITION_API_URL;
  });

  it('returns undefined when not configured', () => {
    delete process.env.SPEAKER_RECOGNITION_API_URL;
    expect(getSpeakerRecognitionApiUrl()).toBeUndefined();
  });

  it('ignores an empty value rather than treating it as configured', () => {
    process.env.SPEAKER_RECOGNITION_API_URL = '';
    expect(getSpeakerRecognitionApiUrl()).toBeUndefined();
  });

  it('returns the configured URL', () => {
    process.env.SPEAKER_RECOGNITION_API_URL = 'http://127.0.0.1:4444';
    expect(getSpeakerRecognitionApiUrl()).toBe('http://127.0.0.1:4444');
  });

  /** The value is concatenated with `/embed`/`/recognize`, so a trailing
   *  slash would produce a double-slashed path against the worker. */
  it('trims trailing slashes', () => {
    process.env.SPEAKER_RECOGNITION_API_URL = 'http://127.0.0.1:4444//';
    expect(getSpeakerRecognitionApiUrl()).toBe('http://127.0.0.1:4444');
  });
});
