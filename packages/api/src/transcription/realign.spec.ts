import {
  realignSegments,
  realignSpeakerBoundaries,
  splitDanglingTail,
  splitLeadingSentence,
} from './realign';
import type { ParsedTranscriptLine } from 'librechat-data-provider';

function line(
  lineIndex: number,
  speaker: string,
  text: string,
  seconds = lineIndex,
  endSeconds = lineIndex + 1,
): ParsedTranscriptLine {
  return { lineIndex, speaker, text, seconds, endSeconds };
}

describe('splitDanglingTail', () => {
  it('separates finished sentences from an unfinished trailing fragment', () => {
    expect(splitDanglingTail('Yes, I confirm that. Thank')).toEqual([
      'Yes, I confirm that.',
      'Thank',
    ]);
  });

  it('treats a line with no finished sentence as all fragment', () => {
    expect(splitDanglingTail('All')).toEqual(['', 'All']);
  });

  it('reports no fragment when the line ends cleanly', () => {
    expect(splitDanglingTail('That is the whole thing.')).toEqual(['That is the whole thing.', '']);
  });

  it('keeps a closing quote or bracket with its sentence', () => {
    expect(splitDanglingTail('He said "stop." Then')).toEqual(['He said "stop."', 'Then']);
  });
});

describe('splitLeadingSentence', () => {
  it('separates the first finished sentence from the rest', () => {
    expect(splitLeadingSentence('you. Thank you.')).toEqual(['you.', 'Thank you.']);
  });

  it('returns the whole line when it holds only one sentence', () => {
    expect(splitLeadingSentence('right.')).toEqual(['right.', '']);
  });
});

describe('realignSpeakerBoundaries', () => {
  /** The headline case: a two-word phrase torn in half by a speaker change.
   *  "All" and "right." are one utterance and cannot belong to two people. */
  it('reunites a phrase split across a speaker change', () => {
    const result = realignSpeakerBoundaries([
      line(0, 'Alex', 'Thank you.'),
      line(1, 'Jordan', 'All'),
      line(2, 'Alex', 'right.'),
      line(3, 'Alex', 'We have been in touch.'),
    ]);

    expect(result.map((entry) => `${entry.speaker}: ${entry.text}`)).toEqual([
      'Alex: Thank you.',
      'Alex: All right.',
      'Alex: We have been in touch.',
    ]);
  });

  /** Only the dangling fragment moves - the finished sentences before it stay
   *  with the speaker who actually said them. */
  it('moves only the unfinished fragment, leaving finished sentences alone', () => {
    const result = realignSpeakerBoundaries([
      line(0, 'Priya', 'Yes, I confirm that. Thank'),
      line(1, 'Alex', 'you. Thank you.'),
    ]);

    expect(result.map((entry) => `${entry.speaker}: ${entry.text}`)).toEqual([
      'Priya: Yes, I confirm that.',
      'Alex: Thank you. Thank you.',
    ]);
  });

  /** Ownership follows the bulk of the sentence: here the question is mostly
   *  the first speaker's, so its tail-end pulls back rather than forward. */
  it('pulls the next line’s opening back when the first speaker owns most of the sentence', () => {
    const result = realignSpeakerBoundaries([
      line(0, 'Alex', 'Is that in general? You do not have one'),
      line(1, 'Priya', 'in general? I left it in the car.'),
    ]);

    expect(result.map((entry) => `${entry.speaker}: ${entry.text}`)).toEqual([
      'Alex: Is that in general? You do not have one in general?',
      'Priya: I left it in the car.',
    ]);
  });

  it('leaves a sentence split between lines of the same speaker alone', () => {
    const lines = [
      line(0, 'Priya', 'I think the fruit is free and that is'),
      line(1, 'Priya', 'dealt with by corporate services.'),
    ];

    expect(realignSpeakerBoundaries(lines)).toEqual(lines);
  });

  it('leaves a clean speaker change untouched', () => {
    const lines = [line(0, 'Alex', 'What is your role?'), line(1, 'Priya', 'Coordinator.')];

    expect(realignSpeakerBoundaries(lines)).toEqual(lines);
  });

  /** A capitalised opening is a new sentence, not a continuation - moving it
   *  would merge two genuinely separate utterances. */
  it('leaves the next line alone when it starts a new sentence', () => {
    const lines = [
      line(0, 'Alex', 'Thank you for coming in'),
      line(1, 'Priya', 'Absolutely, no problem.'),
    ];

    expect(realignSpeakerBoundaries(lines)).toEqual(lines);
  });

  /** A line emptied by the repair must not linger as a blank box, and its
   *  time has to go to whoever absorbed its words so no audio is orphaned. */
  it('drops an emptied line and gives its time to the line that took its words', () => {
    const result = realignSpeakerBoundaries([
      line(0, 'Jordan', 'All', 10, 10.4),
      line(1, 'Alex', 'right.', 10.4, 11),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      speaker: 'Alex',
      text: 'All right.',
      seconds: 10,
      endSeconds: 11,
    });
  });

  it('keeps line order and identity for every surviving line', () => {
    const result = realignSpeakerBoundaries([
      line(0, 'A', 'One.'),
      line(1, 'B', 'Two and'),
      line(2, 'B', 'three.'),
      line(3, 'A', 'Four.'),
    ]);

    expect(result.map((entry) => entry.lineIndex)).toEqual([0, 1, 2, 3]);
  });

  it('handles an empty transcript', () => {
    expect(realignSpeakerBoundaries([])).toEqual([]);
  });

  /** Chained splits: a fragment handed forward can itself meet another
   *  boundary, which is common where several people talk over each other. */
  it('repairs a fragment that spans three consecutive speakers', () => {
    const result = realignSpeakerBoundaries([
      line(0, 'Alex', 'Section 41 of the Act 1990. Thank'),
      line(1, 'Priya', 'you. Thank'),
      line(2, 'Jordan', 'you. All right.'),
    ]);

    const text = result.map((entry) => entry.text).join(' | ');
    expect(text).not.toMatch(/Thank$/);
    expect(result.every((entry) => entry.text.trim().length > 0)).toBe(true);
  });

  it('never invents or loses words', () => {
    const before = [
      line(0, 'Alex', 'Is that in general? You do not have one'),
      line(1, 'Priya', 'in general? I left it in the car.'),
      line(2, 'Jordan', 'All'),
      line(3, 'Alex', 'right.'),
    ];
    const wordsOf = (lines: ParsedTranscriptLine[]) =>
      lines
        .map((entry) => entry.text)
        .join(' ')
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');

    expect(wordsOf(realignSpeakerBoundaries(before))).toBe(wordsOf(before));
  });
});

describe('realignSegments', () => {
  it('repairs the pipeline’s own segment shape and preserves its timings', () => {
    const repaired = realignSegments([
      { start: 0, end: 2, speaker: 'Alex', text: 'Thank you.' },
      { start: 10, end: 10.4, speaker: 'Jordan', text: 'All' },
      { start: 10.4, end: 11, speaker: 'Alex', text: 'right.' },
    ]);

    expect(repaired).toEqual([
      { start: 0, end: 2, speaker: 'Alex', text: 'Thank you.' },
      { start: 10, end: 11, speaker: 'Alex', text: 'All right.' },
    ]);
  });

  /** Without diarization every segment is unattributed, so there is no
   *  speaker boundary to repair and nothing may change. */
  it('leaves an undiarized transcript untouched', () => {
    const segments = [
      { start: 0, end: 1, text: 'One sentence that runs' },
      { start: 1, end: 2, text: 'across two segments.' },
    ];

    expect(realignSegments(segments)).toEqual(segments);
  });
});
