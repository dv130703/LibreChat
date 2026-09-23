import {
  acceptAttributionFixes,
  planAttributionCorrections,
  reviewAttribution,
  selectAttributionCandidates,
} from './attribution';
import type { ParsedTranscriptLine } from 'librechat-data-provider';
import type { AttributionFix } from './attribution';

function line(lineIndex: number, speaker: string, text: string): ParsedTranscriptLine {
  return { lineIndex, speaker, text, seconds: lineIndex * 2, endSeconds: lineIndex * 2 + 2 };
}

describe('selectAttributionCandidates', () => {
  /** A short turn whose speaker differs from both neighbours is where a
   *  stolen answer hides - "Jordan: Yes." in the middle of Alex's questions. */
  it('flags a short turn whose speaker differs from both neighbours', () => {
    const candidates = selectAttributionCandidates([
      line(0, 'Alex', 'Is that your full name?'),
      line(1, 'Jordan', 'Yes.'),
      line(2, 'Alex', 'Thank you.'),
    ]);

    expect(candidates.map((entry) => entry.lineIndex)).toContain(1);
  });

  /** A question answered by the same voice that asked it is not possible. */
  it('flags a question answered by the speaker who asked it', () => {
    const candidates = selectAttributionCandidates([
      line(0, 'Alex', 'And what does that entail?'),
      line(1, 'Alex', 'Yes.'),
      line(2, 'Priya', 'It is my job to promote things.'),
    ]);

    expect(candidates.map((entry) => entry.lineIndex)).toContain(1);
  });

  it('flags a long turn ending in a short interjection', () => {
    const candidates = selectAttributionCandidates([
      line(0, 'Alex', 'Thank you for coming in for this voluntary interview. Absolutely.'),
      line(1, 'Priya', 'No problem at all.'),
    ]);

    expect(candidates.map((entry) => entry.lineIndex)).toContain(0);
  });

  it('leaves an ordinary exchange alone', () => {
    const candidates = selectAttributionCandidates([
      line(0, 'Alex', 'What is your role with the social club?'),
      line(1, 'Priya', 'I am the marketing and promotions coordinator.'),
      line(2, 'Alex', 'And how long have you done that?'),
    ]);

    expect(candidates).toEqual([]);
  });

  it('carries surrounding turns so the model can see the exchange', () => {
    const lines = [
      line(0, 'Alex', 'One.'),
      line(1, 'Alex', 'Is that your full name?'),
      line(2, 'Jordan', 'Yes.'),
      line(3, 'Alex', 'Thank you.'),
      line(4, 'Alex', 'Five.'),
    ];

    const [candidate] = selectAttributionCandidates(lines, { context: 2 });

    expect(candidate.context.map((entry) => entry.lineIndex)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('acceptAttributionFixes', () => {
  const lines = [
    line(0, 'Alex', 'Is that your full name?'),
    line(1, 'Jordan', 'Yes.'),
    line(2, 'Alex', 'Thank you for coming in. Absolutely.'),
  ];
  const speakers = ['Alex', 'Priya', 'Jordan'];

  function reassign(overrides: Partial<AttributionFix> = {}): AttributionFix {
    return {
      kind: 'reassign',
      lineIndex: 1,
      toSpeaker: 'Priya',
      quote: 'Yes.',
      confidence: 0.9,
      ...overrides,
    } as AttributionFix;
  }

  it('accepts a reassignment whose quote really is on that line', () => {
    const { accepted } = acceptAttributionFixes([reassign()], { lines, speakers });

    expect(accepted).toHaveLength(1);
    expect(accepted[0].toSpeaker).toBe('Priya');
  });

  /** Same hallucination gate as speaker identification: a model that invented
   *  its reasoning cannot quote the line it claims to have read. */
  it('rejects a fix quoting words the line does not contain', () => {
    const { accepted, rejected } = acceptAttributionFixes(
      [reassign({ quote: 'No, that is not my name.' })],
      { lines, speakers },
    );

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe('quote_not_found');
  });

  /** Attribution may only move between people already in the recording -
   *  inventing a speaker on an evidential transcript is unacceptable. */
  it('rejects a fix naming someone who is not in the transcript', () => {
    const { rejected } = acceptAttributionFixes([reassign({ toSpeaker: 'Gavin Biscuit' })], {
      lines,
      speakers,
    });

    expect(rejected[0].reason).toBe('unknown_speaker');
  });

  it('rejects a fix that changes nothing', () => {
    const { rejected } = acceptAttributionFixes([reassign({ toSpeaker: 'Jordan' })], {
      lines,
      speakers,
    });

    expect(rejected[0].reason).toBe('no_change');
  });

  it('rejects a fix below the confidence floor', () => {
    const { rejected } = acceptAttributionFixes([reassign({ confidence: 0.4 })], {
      lines,
      speakers,
      minConfidence: 0.7,
    });

    expect(rejected[0].reason).toBe('low_confidence');
  });

  it('rejects a fix pointing at a line that does not exist', () => {
    const { rejected } = acceptAttributionFixes([reassign({ lineIndex: 99 })], { lines, speakers });

    expect(rejected[0].reason).toBe('line_not_found');
  });

  /** The runaway guard. A model that decides most of the interview is
   *  misattributed has misunderstood it, and on evidential material the
   *  right response is to apply none of it rather than most of it. */
  it('rejects the whole batch when it would rewrite too much of the transcript', () => {
    const many = lines.map((entry) => ({
      kind: 'reassign' as const,
      lineIndex: entry.lineIndex,
      toSpeaker: 'Priya',
      quote: entry.text,
      confidence: 0.95,
    }));

    const { accepted, rejected } = acceptAttributionFixes(many, {
      lines,
      speakers,
      maxChangeRatio: 0.25,
    });

    expect(accepted).toEqual([]);
    expect(rejected.every((entry) => entry.reason === 'batch_too_large')).toBe(true);
  });

  describe('splitting a trailing interjection', () => {
    function split(overrides: Partial<AttributionFix> = {}): AttributionFix {
      return {
        kind: 'split',
        lineIndex: 2,
        toSpeaker: 'Priya',
        quote: 'Absolutely.',
        confidence: 0.9,
        ...overrides,
      } as AttributionFix;
    }

    it('accepts a split whose trailing text ends the line', () => {
      const { accepted } = acceptAttributionFixes([split()], { lines, speakers });

      expect(accepted).toHaveLength(1);
    });

    /** Only a trailing portion can be split off; text from the middle would
     *  leave the line in two disconnected pieces. */
    it('rejects a split whose text is not at the end of the line', () => {
      const { rejected } = acceptAttributionFixes([split({ quote: 'Thank you for coming in.' })], {
        lines,
        speakers,
      });

      expect(rejected[0].reason).toBe('not_trailing');
    });

    it('rejects a split that would empty the original line', () => {
      const { rejected } = acceptAttributionFixes(
        [split({ quote: 'Thank you for coming in. Absolutely.' })],
        { lines, speakers },
      );

      expect(rejected[0].reason).toBe('not_trailing');
    });
  });
});

describe('planAttributionCorrections', () => {
  const lines = [
    line(0, 'Alex', 'Is that your full name?'),
    line(1, 'Jordan', 'Yes.'),
    line(2, 'Alex', 'Thank you for coming in. Absolutely.'),
  ];

  it('turns a reassignment into a segment_reassign correction', () => {
    const [correction] = planAttributionCorrections(
      [{ kind: 'reassign', lineIndex: 1, toSpeaker: 'Priya', quote: 'Yes.', confidence: 0.9 }],
      lines,
    );

    expect(correction).toMatchObject({
      type: 'segment_reassign',
      lineIndex: 1,
      fromSpeakerId: 'Jordan',
      toSpeakerId: 'Priya',
    });
  });

  /** A split is two writes: the original line loses its tail, and the tail
   *  becomes a line of its own attributed to whoever actually said it. */
  it('turns a split into a text_edit plus an inserted line', () => {
    const corrections = planAttributionCorrections(
      [
        {
          kind: 'split',
          lineIndex: 2,
          toSpeaker: 'Priya',
          quote: 'Absolutely.',
          confidence: 0.9,
        },
      ],
      lines,
    );

    expect(corrections[0]).toMatchObject({
      type: 'text_edit',
      lineIndex: 2,
      fromText: 'Thank you for coming in. Absolutely.',
      toText: 'Thank you for coming in.',
    });
    expect(corrections[1]).toMatchObject({
      type: 'line_insert',
      speaker: 'Priya',
      text: 'Absolutely.',
    });
  });

  /** The inserted line has to sort after the line it came from and stay
   *  inside that line's own time range, or it lands in the wrong place. */
  it('places the split-off line just after its origin, within its time range', () => {
    const [, insert] = planAttributionCorrections(
      [
        {
          kind: 'split',
          lineIndex: 2,
          toSpeaker: 'Priya',
          quote: 'Absolutely.',
          confidence: 0.9,
        },
      ],
      lines,
    );

    expect(insert.lineIndex).toBeGreaterThan(2);
    expect(insert.lineIndex).toBeLessThan(3);
    expect(insert.seconds).toBeGreaterThanOrEqual(4);
    expect(insert.endSeconds).toBeLessThanOrEqual(6);
  });
});

describe('reviewAttribution', () => {
  const lines = [
    line(0, 'Alex', 'Is that your full name?'),
    line(1, 'Jordan', 'Yes.'),
    line(2, 'Alex', 'Thank you.'),
    line(3, 'Alex', 'And your role?'),
    line(4, 'Jordan', 'Coordinator.'),
    line(5, 'Alex', 'Thank you.'),
  ];

  it('returns the corrections for the fixes the model proposed', async () => {
    const { corrections } = await reviewAttribution({
      lines,
      askModel: async () => [
        { kind: 'reassign', lineIndex: 1, toSpeaker: 'Priya', quote: 'Yes.', confidence: 0.95 },
      ],
      speakers: ['Alex', 'Jordan', 'Priya'],
    });

    expect(corrections).toEqual([
      expect.objectContaining({ type: 'segment_reassign', lineIndex: 1, toSpeakerId: 'Priya' }),
    ]);
  });

  /** Observed against a real local model: one batch in six failed on a
   *  malformed tool call. Losing that batch is acceptable; losing the whole
   *  pass, and every sound fix in it, is not. */
  it('keeps the fixes from other batches when one batch fails', async () => {
    const errors: unknown[] = [];
    let call = 0;

    const { corrections } = await reviewAttribution({
      lines,
      batchSize: 1,
      speakers: ['Alex', 'Jordan', 'Priya'],
      askModel: async () => {
        call++;
        if (call === 1) {
          throw new Error('malformed tool call');
        }
        return [
          {
            kind: 'reassign',
            lineIndex: 4,
            toSpeaker: 'Priya',
            quote: 'Coordinator.',
            confidence: 0.95,
          },
        ];
      },
      onError: (error) => errors.push(error),
    });

    expect(errors).toHaveLength(1);
    expect(corrections).toHaveLength(1);
  });

  it('never calls the model when nothing is suspect', async () => {
    let asked = false;
    const { corrections } = await reviewAttribution({
      lines: [
        line(0, 'Alex', 'What is your role with the club?'),
        line(1, 'Priya', 'I coordinate marketing and promotions.'),
      ],
      speakers: ['Alex', 'Priya'],
      askModel: async () => {
        asked = true;
        return [];
      },
    });

    expect(asked).toBe(false);
    expect(corrections).toEqual([]);
  });

  it('derives the speaker list from the transcript when none is given', async () => {
    let seen: string[] = [];
    await reviewAttribution({
      lines,
      askModel: async (_candidates, speakers) => {
        seen = speakers;
        return [];
      },
    });

    expect(seen.sort()).toEqual(['Alex', 'Jordan']);
  });

  it('reports rejected proposals rather than silently dropping them', async () => {
    const { rejected } = await reviewAttribution({
      lines,
      speakers: ['Alex', 'Jordan', 'Priya'],
      askModel: async () => [
        { kind: 'reassign', lineIndex: 1, toSpeaker: 'Nobody', quote: 'Yes.', confidence: 0.95 },
      ],
    });

    expect(rejected[0].reason).toBe('unknown_speaker');
  });
});
