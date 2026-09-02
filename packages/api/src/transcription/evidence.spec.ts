import { extractChunkEvidence } from './evidence';

describe('extractChunkEvidence', () => {
  it('recovers the time span and speaker set from timestamped transcript lines', () => {
    const chunk =
      '[00:42.0-00:46.5] Speaker 1: We agreed on the payment terms.\n' +
      '[00:46.5-00:50.0] Speaker 2: Yes, that sounds right.';

    expect(extractChunkEvidence(chunk)).toEqual({
      startS: 42,
      endS: 50,
      speakers: ['Speaker 1', 'Speaker 2'],
    });
  });

  it('uses the min start and max end across every line in the chunk, not just the first/last', () => {
    const chunk =
      '[01:00.0-01:05.0] Speaker 1: middle line\n' +
      '[00:30.0-00:35.0] Speaker 2: an earlier line further down the chunk\n' +
      '[02:00.0-02:10.0] Speaker 1: a later line';

    const evidence = extractChunkEvidence(chunk);
    expect(evidence.startS).toBe(30);
    expect(evidence.endS).toBe(130);
  });

  it('deduplicates repeated speakers', () => {
    const chunk =
      '[00:00.0-00:05.0] Speaker 1: one\n' +
      '[00:05.0-00:10.0] Speaker 1: two\n' +
      '[00:10.0-00:15.0] Speaker 2: three';

    expect(extractChunkEvidence(chunk).speakers).toEqual(['Speaker 1', 'Speaker 2']);
  });

  it('returns no time range or speakers for a chunk with no timestamped lines', () => {
    expect(extractChunkEvidence('Just a plain paragraph with no transcript markup.')).toEqual({
      startS: undefined,
      endS: undefined,
      speakers: [],
    });
  });

  it('returns an empty result for an empty chunk', () => {
    expect(extractChunkEvidence('')).toEqual({
      startS: undefined,
      endS: undefined,
      speakers: [],
    });
  });
});
