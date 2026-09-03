import { resolveTranscriptionMeta } from './meta';

describe('resolveTranscriptionMeta (transcription/ARCHITECTURE.md §4.3, dual-read)', () => {
  it("prefers the source file's effectiveOptions when present", () => {
    const result = resolveTranscriptionMeta(
      { transcription: { effectiveOptions: { model: 'large-v3-turbo' } } as never },
      { transcription: { model: 'stale-from-conversation' } },
    );
    expect(result).toEqual({ model: 'large-v3-turbo' });
  });

  it('falls back to Conversation.transcription when the source file has no job state', () => {
    const result = resolveTranscriptionMeta(
      { transcription: undefined },
      { transcription: { model: 'legacy-model' } },
    );
    expect(result).toEqual({ model: 'legacy-model' });
  });

  it('falls back to Conversation.transcription when the source file itself is missing', () => {
    const result = resolveTranscriptionMeta(null, { transcription: { model: 'legacy-model' } });
    expect(result).toEqual({ model: 'legacy-model' });
  });

  it('falls back to Conversation.transcription when the job exists but has no effectiveOptions yet (e.g. still queued)', () => {
    const result = resolveTranscriptionMeta(
      { transcription: { status: 'queued' } as never },
      { transcription: { model: 'legacy-model' } },
    );
    expect(result).toEqual({ model: 'legacy-model' });
  });

  it('returns undefined when neither source has anything (never-transcribed conversation)', () => {
    expect(resolveTranscriptionMeta(undefined, undefined)).toBeUndefined();
    expect(resolveTranscriptionMeta(null, null)).toBeUndefined();
  });
});
