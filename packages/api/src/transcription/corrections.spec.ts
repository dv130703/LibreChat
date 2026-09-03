import type { TTranscriptCorrection } from 'librechat-data-provider';
import { applyTranscriptCorrections, applyTranscriptCorrectionsStructured } from './corrections';

const BASE_TEXT = [
  '[00:00.0-00:02.0] Speaker 1: Hello, welcome.',
  '[00:02.0-00:04.0] Speaker 2: Thanks for having me.',
  '[00:04.0-00:06.0] Speaker 1: Let\'s begin.',
].join('\n');

function correction(overrides: Partial<TTranscriptCorrection>): TTranscriptCorrection {
  return {
    _id: 'correction-id',
    transcriptFileId: 'file-1',
    conversationId: 'convo-1',
    user: 'user-1',
    type: 'text_edit',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** I2 (transcription/ARCHITECTURE.md §8): the original pipeline output is
 *  never mutated - every correction is additive, replayed on top of the
 *  untouched base text each time. */
describe('corrections are additive only (I2)', () => {
  it('never mutates the baseText argument', () => {
    const original = BASE_TEXT;
    const corrections = [
      correction({ type: 'text_edit', lineIndex: 0, toText: 'A completely different opener.' }),
    ];
    applyTranscriptCorrections(original, corrections);
    expect(original).toBe(BASE_TEXT);
  });

  it('with zero corrections, reproduces the base text exactly (round-trip identity)', () => {
    expect(applyTranscriptCorrections(BASE_TEXT, [])).toBe(BASE_TEXT);
  });

  it('applying the same corrections twice yields byte-identical output (pure, no hidden state)', () => {
    const corrections = [
      correction({ type: 'segment_reassign', lineIndex: 1, toSpeakerId: 'Speaker 3' }),
      correction({ type: 'text_edit', lineIndex: 2, toText: "Let's really begin." }),
    ];
    const first = applyTranscriptCorrections(BASE_TEXT, corrections);
    const second = applyTranscriptCorrections(BASE_TEXT, corrections);
    expect(first).toBe(second);
    // and the base text backing both calls is still untouched
    expect(BASE_TEXT).toContain("Let's begin.");
  });

  it('an empty correction log leaves every line\'s speaker/text/timing unchanged', () => {
    const structured = applyTranscriptCorrectionsStructured(BASE_TEXT, []);
    expect(structured).toHaveLength(3);
    expect(structured[0]).toMatchObject({ speaker: 'Speaker 1', text: 'Hello, welcome.' });
    expect(structured[1]).toMatchObject({ speaker: 'Speaker 2', text: 'Thanks for having me.' });
  });

  it('does not mutate the corrections array or its entries', () => {
    const corrections = [correction({ type: 'text_edit', lineIndex: 0, toText: 'Edited.' })];
    const snapshot = JSON.parse(JSON.stringify(corrections));
    applyTranscriptCorrections(BASE_TEXT, corrections);
    expect(corrections).toEqual(snapshot);
  });
});

/** I6 (transcription/ARCHITECTURE.md §8): replay is deterministic regardless
 *  of arrival order, for corrections that don't target the same key. Two
 *  corrections that genuinely conflict (same lineIndex/speakerId) are
 *  expected to differ by order - chronological "last write wins" is the
 *  documented replay rule, not a violation of this invariant. Both cases are
 *  covered below so the boundary is explicit rather than assumed. */
describe('correction replay is order-independent for non-conflicting keys (I6)', () => {
  it('produces identical output regardless of the arrival order of non-conflicting corrections', () => {
    const corrections: TTranscriptCorrection[] = [
      correction({ type: 'text_edit', lineIndex: 0, toText: 'Rewritten opener.' }),
      correction({ type: 'segment_reassign', lineIndex: 1, toSpeakerId: 'Speaker 4' }),
      correction({ type: 'speaker_rename', speakerId: 'Speaker 1', toName: 'Alex' }),
      correction({
        type: 'time_edit',
        lineIndex: 2,
        seconds: 4.5,
        endSeconds: 6.2,
      }),
      correction({
        type: 'line_insert',
        lineIndex: 1.5,
        speaker: 'Speaker 2',
        text: 'An inserted aside.',
        seconds: 3,
        endSeconds: 3.5,
      }),
    ];

    const forward = applyTranscriptCorrections(BASE_TEXT, corrections);
    const reversed = applyTranscriptCorrections(BASE_TEXT, [...corrections].reverse());

    // A handful of concrete shuffles, not just the one reversal - order
    // truly shouldn't matter here since every correction targets a
    // different key (lineIndex 0, 1, speakerId "Speaker 1", lineIndex 2,
    // and a brand-new inserted lineIndex 1.5).
    const shuffles = [
      [corrections[4], corrections[0], corrections[3], corrections[1], corrections[2]],
      [corrections[2], corrections[3], corrections[4], corrections[1], corrections[0]],
    ];

    for (const shuffled of shuffles) {
      expect(applyTranscriptCorrections(BASE_TEXT, shuffled)).toBe(forward);
    }
    expect(reversed).toBe(forward);
  });

  it('a time_edit layers correctly onto a line_insert from the same log regardless of which appears first', () => {
    const insert = correction({
      type: 'line_insert',
      lineIndex: 1.5,
      speaker: 'Speaker 2',
      text: 'Inserted line.',
      seconds: 3,
      endSeconds: 3.4,
    });
    const timeEdit = correction({
      type: 'time_edit',
      lineIndex: 1.5,
      seconds: 3.1,
      endSeconds: 3.6,
    });

    const insertThenEdit = applyTranscriptCorrectionsStructured(BASE_TEXT, [insert, timeEdit]);
    const editThenInsert = applyTranscriptCorrectionsStructured(BASE_TEXT, [timeEdit, insert]);

    expect(insertThenEdit).toEqual(editThenInsert);
    const insertedLine = insertThenEdit.find((line) => line.lineIndex === 1.5);
    expect(insertedLine).toMatchObject({ seconds: 3.1, endSeconds: 3.6, text: 'Inserted line.' });
  });

  it('documents the expected exception: conflicting corrections on the same key resolve by array (chronological) order, not order-independently', () => {
    const editA = correction({ type: 'text_edit', lineIndex: 0, toText: 'First edit.' });
    const editB = correction({ type: 'text_edit', lineIndex: 0, toText: 'Second edit, should win.' });

    const aThenB = applyTranscriptCorrectionsStructured(BASE_TEXT, [editA, editB]);
    const bThenA = applyTranscriptCorrectionsStructured(BASE_TEXT, [editB, editA]);

    expect(aThenB[0].text).toBe('Second edit, should win.');
    expect(bThenA[0].text).toBe('First edit.');
    expect(aThenB[0].text).not.toBe(bThenA[0].text);
  });
});
