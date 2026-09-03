import {
  TRANSCRIPT_LINE_PATTERN,
  formatTranscriptLine,
  formatTranscriptTimestamp,
  parseTranscriptLine,
  parseTranscriptText,
  parseTranscriptTimestamp,
} from './transcript';

/** I1 (transcription/ARCHITECTURE.md §8): the transcript line format must
 *  round-trip identically through every consumer. Since all three consumers
 *  now import this single module instead of keeping their own copy, a
 *  round-trip test here protects all of them at once - there is no second
 *  implementation left to drift out of sync with. */
describe('transcript line format round-trip (I1)', () => {
  const cases: Array<{ name: string; start: number; end: number; speaker?: string; text: string }> =
    [
      {
        name: 'short duration, one-digit speaker',
        start: 1.2,
        end: 3.45,
        speaker: 'Speaker 1',
        text: 'Hello there.',
      },
      {
        name: 'double-digit speaker number',
        start: 0,
        end: 2,
        speaker: 'Speaker 12',
        text: 'Testing.',
      },
      {
        name: 'text containing a colon',
        start: 4,
        end: 6,
        speaker: 'Speaker 2',
        text: 'He said: hello, how are you?',
      },
      {
        name: 'text containing a bracketed timestamp-looking substring',
        start: 4,
        end: 6,
        speaker: 'Speaker 2',
        text: '[not a real timestamp] just text',
      },
      {
        name: 'unicode speaker text',
        start: 10,
        end: 12.6,
        speaker: 'Speaker 3',
        text: 'Café résumé 日本語 emoji 🎙️',
      },
      {
        name: 'over an hour',
        start: 3661.05,
        end: 3720.9,
        speaker: 'Speaker 1',
        text: 'Long recording line.',
      },
      {
        name: 'tenths-carry rounding at a minute boundary',
        start: 59.96,
        end: 61,
        speaker: 'Speaker 1',
        text: 'Carries into the next minute.',
      },
      { name: 'zero start', start: 0, end: 0.04, speaker: 'Speaker 1', text: 'Starts at zero.' },
      {
        name: 'negative-adjacent start (float drift, clamps to zero)',
        start: -0.001,
        end: 1,
        speaker: 'Speaker 1',
        text: 'Should clamp, not go negative.',
      },
      {
        name: 'unknown speaker label',
        start: 5,
        end: 7,
        speaker: 'Unknown',
        text: 'Unattributed line.',
      },
    ];

  it.each(cases)('round-trips: $name', ({ start, end, speaker, text }) => {
    const line = formatTranscriptLine(
      { start, end, speaker, text },
      { includeTimestamps: true, diarize: true },
    );
    const parsed = parseTranscriptLine(line, 0);

    expect(parsed.text).toBe(text);
    expect(parsed.speaker).toBe(speaker);
    // formatTranscriptTimestamp rounds to the nearest tenth of a second and
    // clamps negatives to zero, so the round-tripped value can differ from
    // the input by at most half a tenth (0.05s) plus that clamp.
    expect(parsed.seconds).toBeCloseTo(Math.max(0, start), 1);
    expect(parsed.endSeconds).toBeCloseTo(end, 1);
  });

  it('omits the timestamp prefix entirely when includeTimestamps is false', () => {
    const line = formatTranscriptLine(
      { start: 1, end: 2, speaker: 'Speaker 1', text: 'No timestamps here.' },
      { includeTimestamps: false, diarize: true },
    );
    expect(line).toBe('Speaker 1: No timestamps here.');
    const parsed = parseTranscriptLine(line, 0);
    expect(parsed.seconds).toBeUndefined();
    expect(parsed.endSeconds).toBeUndefined();
    expect(parsed.speaker).toBe('Speaker 1');
    expect(parsed.text).toBe('No timestamps here.');
  });

  it('omits the speaker prefix entirely when diarize is false', () => {
    const line = formatTranscriptLine(
      { start: 1, end: 2, speaker: 'Speaker 1', text: 'No speaker label.' },
      { includeTimestamps: true, diarize: false },
    );
    expect(line).not.toContain('Speaker 1:');
    const parsed = parseTranscriptLine(line, 0);
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.text).toBe('No speaker label.');
  });

  it('omits both prefixes when neither is requested, leaving bare text', () => {
    const line = formatTranscriptLine(
      { start: 1, end: 2, speaker: 'Speaker 1', text: 'Just the words.' },
      { includeTimestamps: false, diarize: false },
    );
    expect(line).toBe('Just the words.');
    const parsed = parseTranscriptLine(line, 0);
    expect(parsed.timestamp).toBeUndefined();
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.text).toBe('Just the words.');
  });

  it('parses an end-timestamp-less legacy line ([start] only, pre end-timestamp persistence)', () => {
    const parsed = parseTranscriptLine('[01:02.5] Speaker 1: legacy line', 0);
    expect(parsed.seconds).toBeCloseTo(62.5, 1);
    expect(parsed.endSeconds).toBeUndefined();
    expect(parsed.speaker).toBe('Speaker 1');
    expect(parsed.text).toBe('legacy line');
  });

  it('parses a full multi-line transcript, skipping blank lines and assigning sequential lineIndex', () => {
    const text = [
      '[00:00.0-00:02.0] Speaker 1: First line.',
      '',
      '[00:02.0-00:04.0] Speaker 2: Second line.',
      '[00:04.0-00:06.0] Speaker 1: Third line: with a colon.',
    ].join('\n');

    const parsed = parseTranscriptText(text);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((line) => line.lineIndex)).toEqual([0, 1, 2]);
    expect(parsed[2].text).toBe('Third line: with a colon.');
    expect(parsed[2].speaker).toBe('Speaker 1');
  });

  describe('formatTranscriptTimestamp', () => {
    it('formats sub-hour durations as mm:ss.t', () => {
      expect(formatTranscriptTimestamp(125.34)).toBe('02:05.3');
    });

    it('formats hour-plus durations as h:mm:ss.t', () => {
      expect(formatTranscriptTimestamp(3661.05)).toBe('1:01:01.1');
    });

    it('carries tenths correctly across a minute boundary (no float rollover)', () => {
      expect(formatTranscriptTimestamp(59.96)).toBe('01:00.0');
    });

    it('clamps negative input to zero rather than producing a negative timestamp', () => {
      expect(formatTranscriptTimestamp(-5)).toBe('00:00.0');
    });
  });

  describe('parseTranscriptTimestamp', () => {
    it('is the exact inverse of formatTranscriptTimestamp for whole-tenth values', () => {
      expect(parseTranscriptTimestamp('02:05.3')).toBeCloseTo(125.3, 5);
      expect(parseTranscriptTimestamp('1:01:01.1')).toBeCloseTo(3661.1, 5);
    });

    it('returns undefined for a non-numeric timestamp', () => {
      expect(parseTranscriptTimestamp('not:a:time')).toBeUndefined();
    });
  });

  it('TRANSCRIPT_LINE_PATTERN always matches (every group is optional)', () => {
    expect(TRANSCRIPT_LINE_PATTERN.test('')).toBe(true);
    expect(TRANSCRIPT_LINE_PATTERN.test('plain text, no prefixes at all')).toBe(true);
  });
});
