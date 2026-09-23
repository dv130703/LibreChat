import {
  acceptAssignments,
  findUnidentifiedSpeakers,
  identifySpeakersFromContent,
  selectEvidenceLines,
  resolveByElimination,
} from './identifySpeakers';
import { buildNameKeywords } from './speakerNames';
import type { ParsedTranscriptLine } from 'librechat-data-provider';
import type { PresentPerson, SpeakerAssignment } from './identifySpeakers';

function line(lineIndex: number, speaker: string | undefined, text: string): ParsedTranscriptLine {
  return { lineIndex, speaker, text, seconds: lineIndex };
}

const keywords = buildNameKeywords([
  { profileId: 'p1', fullName: 'Rowan Danbury' },
  { profileId: 'p2', fullName: 'Marta Velkin' },
]);

describe('findUnidentifiedSpeakers', () => {
  it('returns the pipeline labels that no one has named yet', () => {
    const lines = [
      line(0, 'Speaker 1', 'Hello.'),
      line(1, 'Rowan Danbury', 'Hello back.'),
      line(2, 'Speaker 2', 'And me.'),
    ];

    expect(findUnidentifiedSpeakers(lines)).toEqual(['Speaker 1', 'Speaker 2']);
  });

  /** The pipeline substitutes a literal "Unknown" for a segment it could not
   *  confidently attribute - just as unidentified as "Speaker 3", and the
   *  case most worth resolving. */
  it('treats the pipeline\'s "Unknown" label as unidentified too', () => {
    expect(findUnidentifiedSpeakers([line(0, 'Unknown', 'Who said this?')])).toEqual(['Unknown']);
  });

  it('ignores lines carrying no speaker at all', () => {
    expect(findUnidentifiedSpeakers([line(0, undefined, 'Untagged narration.')])).toEqual([]);
  });

  it('returns nothing once every speaker has a real name', () => {
    expect(findUnidentifiedSpeakers([line(0, 'Marta Velkin', 'All named.')])).toEqual([]);
  });
});

describe('selectEvidenceLines', () => {
  it('selects the line that names someone', () => {
    const lines = [
      line(0, 'Speaker 1', 'Please continue.'),
      line(1, 'Speaker 1', 'Thank you for coming in, Mr Donbry.'),
      line(2, 'Speaker 2', 'No problem.'),
    ];

    const selected = selectEvidenceLines(lines, keywords, { leading: 0, after: 0 });

    expect(selected.map((entry) => entry.lineIndex)).toContain(1);
  });

  /** The decisive half of an attribution is usually the *reply*: "Rowan, can
   *  you confirm?" only identifies Rowan once the next speaker answers it.
   *  Selecting the naming line alone would hand the model the question
   *  without the answer. */
  it('carries the following turns that answer the line naming someone', () => {
    const lines = [
      line(0, 'Speaker 1', 'Irrelevant opening.'),
      line(1, 'Speaker 1', 'Rowan, can you confirm that?'),
      line(2, 'Speaker 2', 'Yes, I can confirm it.'),
      line(3, 'Speaker 1', 'Thank you.'),
    ];

    const selected = selectEvidenceLines(lines, keywords, { leading: 0, after: 1 });

    expect(selected.map((entry) => entry.lineIndex)).toEqual([1, 2]);
  });

  /** An interview opens by putting names on the record, whether or not those
   *  names survived transcription well enough to match the roster. */
  it('always includes the opening lines', () => {
    const lines = [
      line(0, 'Speaker 1', 'For the record, please state your full name.'),
      line(1, 'Speaker 2', 'Greg Mornder.'),
      line(2, 'Speaker 1', 'Nothing notable here.'),
      line(3, 'Speaker 1', 'Nor here.'),
    ];

    const selected = selectEvidenceLines(lines, keywords, { leading: 2, after: 0 });

    expect(selected.map((entry) => entry.lineIndex)).toEqual([0, 1]);
  });

  it('picks up a self-introduction with no roster name in it', () => {
    const lines = [
      line(0, 'Speaker 1', 'Nothing here.'),
      line(1, 'Speaker 2', 'My name is Gregory Mornder and I run the finance team.'),
    ];

    const selected = selectEvidenceLines(lines, keywords, { leading: 0, after: 0 });

    expect(selected.map((entry) => entry.lineIndex)).toEqual([1]);
  });

  it('returns each line once and in transcript order when windows overlap', () => {
    const lines = [
      line(0, 'Speaker 1', 'Rowan, one question.'),
      line(1, 'Speaker 2', 'Go ahead.'),
      line(2, 'Speaker 1', 'Marta, same question.'),
      line(3, 'Speaker 3', 'Understood.'),
    ];

    const selected = selectEvidenceLines(lines, keywords, { leading: 0, after: 2 });

    expect(selected.map((entry) => entry.lineIndex)).toEqual([0, 1, 2, 3]);
  });
});

describe('acceptAssignments', () => {
  const lines = [
    line(0, 'Speaker 1', 'Thank you for coming in, Mr Danbury.'),
    line(1, 'Speaker 2', 'Happy to help.'),
  ];
  const unidentified = ['Speaker 1', 'Speaker 2'];

  function assignment(overrides: Partial<SpeakerAssignment> = {}): SpeakerAssignment {
    return {
      speakerId: 'Speaker 2',
      name: 'Rowan Danbury',
      evidenceLineIndex: 0,
      evidenceQuote: 'Thank you for coming in, Mr Danbury.',
      confidence: 0.9,
      ...overrides,
    };
  }

  it('accepts an assignment whose quoted evidence really is in the transcript', () => {
    const { accepted } = acceptAssignments([assignment()], { lines, unidentified });

    expect(accepted).toHaveLength(1);
    expect(accepted[0].name).toBe('Rowan Danbury');
  });

  /** The cheapest possible hallucination check: a model that invented its
   *  justification cannot quote a line that exists. */
  it('rejects an assignment citing a quote the line does not contain', () => {
    const { accepted, rejected } = acceptAssignments(
      [assignment({ evidenceQuote: 'I am Rowan Danbury, the finance director.' })],
      { lines, unidentified },
    );

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe('evidence_not_found');
  });

  it('rejects an assignment citing a line index that does not exist', () => {
    const { rejected } = acceptAssignments([assignment({ evidenceLineIndex: 99 })], {
      lines,
      unidentified,
    });

    expect(rejected[0].reason).toBe('evidence_not_found');
  });

  it('tolerates whitespace and case drift in the quote', () => {
    const { accepted } = acceptAssignments(
      [assignment({ evidenceQuote: 'thank you   for coming in, mr danbury' })],
      { lines, unidentified },
    );

    expect(accepted).toHaveLength(1);
  });

  it('rejects an assignment below the confidence floor', () => {
    const { rejected } = acceptAssignments([assignment({ confidence: 0.3 })], {
      lines,
      unidentified,
      minConfidence: 0.6,
    });

    expect(rejected[0].reason).toBe('low_confidence');
  });

  /** Renaming an already-identified speaker is out of scope by construction:
   *  this stage only ever fills in blanks. */
  it('rejects an assignment targeting a speaker that was already identified', () => {
    const { rejected } = acceptAssignments([assignment({ speakerId: 'Marta Velkin' })], {
      lines,
      unidentified,
    });

    expect(rejected[0].reason).toBe('speaker_not_unidentified');
  });

  /** One person cannot be two diarized voices in the same recording; a
   *  collision means the model guessed rather than read. */
  it('rejects both assignments when two speakers are given the same name', () => {
    const { accepted, rejected } = acceptAssignments(
      [
        assignment({ speakerId: 'Speaker 1' }),
        assignment({
          speakerId: 'Speaker 2',
          evidenceQuote: 'Happy to help.',
          evidenceLineIndex: 1,
        }),
      ],
      { lines, unidentified },
    );

    expect(accepted).toEqual([]);
    expect(rejected.map((entry) => entry.reason)).toEqual(['duplicate_name', 'duplicate_name']);
  });

  /** Two different names for one voice is a contradiction, and the
   *  correction log's last-write-wins replay would otherwise silently pick
   *  one of them at random. */
  it('rejects every assignment when one speaker is given two different names', () => {
    const { accepted, rejected } = acceptAssignments(
      [
        assignment({ speakerId: 'Speaker 1', name: 'Rowan Danbury' }),
        assignment({ speakerId: 'Speaker 1', name: 'Marta Velkin' }),
      ],
      { lines, unidentified },
    );

    expect(accepted).toEqual([]);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      'conflicting_speaker',
      'conflicting_speaker',
    ]);
  });

  it('rejects a blank or placeholder name', () => {
    const { rejected } = acceptAssignments([assignment({ name: '  ' })], { lines, unidentified });

    expect(rejected[0].reason).toBe('invalid_name');
  });

  /** A model that echoes the label back has identified nobody. */
  it('rejects a name that is just another pipeline label', () => {
    const { rejected } = acceptAssignments([assignment({ name: 'Speaker 3' })], {
      lines,
      unidentified,
    });

    expect(rejected[0].reason).toBe('invalid_name');
  });
});

describe('identifySpeakersFromContent', () => {
  const lines = [
    line(0, 'Speaker 1', 'For the record, please state your name.'),
    line(1, 'Speaker 2', 'Rowan Donbry, finance director.'),
  ];

  function baseParams() {
    return {
      lines,
      candidates: [{ profileId: 'p1', fullName: 'Rowan Danbury', role: 'Finance Director' }],
      transcriptFileId: 't1',
      conversationId: 'c1',
      userId: 'u1',
    };
  }

  it('renames an identified speaker through a speaker_rename correction', async () => {
    const corrections: Array<Record<string, unknown>> = [];

    await identifySpeakersFromContent({
      ...baseParams(),
      askModel: async () => ({
        assignments: [
          {
            speakerId: 'Speaker 2',
            name: 'Rowan Danbury',
            evidenceLineIndex: 1,
            evidenceQuote: 'Rowan Donbry, finance director.',
            confidence: 0.95,
          },
        ],
      }),
      createCorrection: async (correction) => {
        corrections.push(correction as unknown as Record<string, unknown>);
      },
    });

    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      type: 'speaker_rename',
      speakerId: 'Speaker 2',
      fromName: 'Speaker 2',
      toName: 'Rowan Danbury',
    });
  });

  /** Most unidentified speakers in a real interview are never named at all.
   *  Abstaining has to be free, and has to leave the label untouched. */
  it('writes nothing when the model identifies no one', async () => {
    const corrections: unknown[] = [];

    await identifySpeakersFromContent({
      ...baseParams(),
      askModel: async () => ({ assignments: [] }),
      createCorrection: async (correction) => {
        corrections.push(correction);
      },
    });

    expect(corrections).toEqual([]);
  });

  it('never calls the model when every speaker already has a name', async () => {
    let asked = false;

    await identifySpeakersFromContent({
      ...baseParams(),
      lines: [line(0, 'Marta Velkin', 'Everyone here is named.')],
      askModel: async () => {
        asked = true;
        return { assignments: [] };
      },
      createCorrection: async () => {},
    });

    expect(asked).toBe(false);
  });

  it('reports a model failure without throwing', async () => {
    const errors: unknown[] = [];

    await identifySpeakersFromContent({
      ...baseParams(),
      askModel: async () => {
        throw new Error('model unavailable');
      },
      createCorrection: async () => {},
      onError: (error) => errors.push(error),
    });

    expect(errors).toHaveLength(1);
  });

  it('does not let one rejected assignment block a valid one', async () => {
    const corrections: Array<{ toName?: string }> = [];

    await identifySpeakersFromContent({
      ...baseParams(),
      askModel: async () => ({
        assignments: [
          {
            speakerId: 'Speaker 1',
            name: 'Invented Person',
            evidenceLineIndex: 0,
            evidenceQuote: 'a sentence that was never spoken',
            confidence: 0.99,
          },
          {
            speakerId: 'Speaker 2',
            name: 'Rowan Danbury',
            evidenceLineIndex: 1,
            evidenceQuote: 'Rowan Donbry, finance director.',
            confidence: 0.95,
          },
        ],
      }),
      createCorrection: async (correction) => {
        corrections.push(correction);
      },
    });

    expect(corrections.map((correction) => correction.toName)).toEqual(['Rowan Danbury']);
  });
});

describe('resolveByElimination', () => {
  const lines = [
    line(0, 'Speaker 1', 'My name is Alex Norling. Also present is my colleague, Jordan Pell.'),
    line(1, 'Speaker 2', 'Priya Selwyn.'),
    line(2, 'Speaker 3', 'Great, Priya, tell us about your role.'),
  ];

  function present(name: string, overrides: Partial<PresentPerson> = {}): PresentPerson {
    return {
      name,
      evidenceLineIndex: 0,
      evidenceQuote: 'Also present is my colleague, Jordan Pell.',
      ...overrides,
    };
  }

  function assigned(speakerId: string, name: string): SpeakerAssignment {
    return {
      speakerId,
      name,
      evidenceLineIndex: 0,
      evidenceQuote: 'My name is Alex Norling.',
      confidence: 0.9,
    };
  }

  /** The case that prompted this: an interview states who is in the room,
   *  and once every other attendee is placed, one speaker and one named
   *  person remain. That is arithmetic over a stated roster, not a guess. */
  it('names the last speaker when exactly one attendee is left unplaced', () => {
    const resolved = resolveByElimination({
      lines,
      unidentified: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
      accepted: [assigned('Speaker 1', 'Alex Norling'), assigned('Speaker 2', 'Priya Selwyn')],
      present: [present('Alex Norling'), present('Priya Selwyn'), present('Jordan Pell')],
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ speakerId: 'Speaker 3', name: 'Jordan Pell' });
  });

  /** Two unplaced speakers and two unplaced names has two possible
   *  pairings, and nothing in the transcript chooses between them. */
  it('assigns nobody when more than one speaker is still unplaced', () => {
    const resolved = resolveByElimination({
      lines,
      unidentified: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
      accepted: [assigned('Speaker 1', 'Alex Norling')],
      present: [present('Alex Norling'), present('Priya Selwyn'), present('Jordan Pell')],
    });

    expect(resolved).toEqual([]);
  });

  /** A named attendee who never speaks makes the remainder ambiguous. */
  it('assigns nobody when more than one attendee is left unplaced', () => {
    const resolved = resolveByElimination({
      lines,
      unidentified: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
      accepted: [assigned('Speaker 1', 'Alex Norling'), assigned('Speaker 2', 'Priya Selwyn')],
      present: [
        present('Alex Norling'),
        present('Priya Selwyn'),
        present('Jordan Pell'),
        present('A Silent Observer'),
      ],
    });

    expect(resolved).toEqual([]);
  });

  it('assigns nobody when every speaker is already named', () => {
    const resolved = resolveByElimination({
      lines,
      unidentified: ['Speaker 1', 'Speaker 2'],
      accepted: [assigned('Speaker 1', 'Alex Norling'), assigned('Speaker 2', 'Priya Selwyn')],
      present: [present('Alex Norling'), present('Priya Selwyn'), present('Jordan Pell')],
    });

    expect(resolved).toEqual([]);
  });

  /** Same hallucination guard as a direct assignment - a roster entry the
   *  transcript does not actually state cannot be eliminated onto anyone. */
  it('ignores an attendee whose stated presence is not in the transcript', () => {
    const resolved = resolveByElimination({
      lines,
      unidentified: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
      accepted: [assigned('Speaker 1', 'Alex Norling'), assigned('Speaker 2', 'Priya Selwyn')],
      present: [
        present('Alex Norling'),
        present('Priya Selwyn'),
        present('Jordan Pell', { evidenceQuote: 'Also present is Someone Never Mentioned.' }),
      ],
    });

    expect(resolved).toEqual([]);
  });

  it('matches an already-placed attendee regardless of case and spacing', () => {
    const resolved = resolveByElimination({
      lines,
      unidentified: ['Speaker 1', 'Speaker 2', 'Speaker 3'],
      accepted: [assigned('Speaker 1', 'alex  norling'), assigned('Speaker 2', 'PRIYA SELWYN')],
      present: [present('Alex Norling'), present('Priya Selwyn'), present('Jordan Pell')],
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe('Jordan Pell');
  });
});
