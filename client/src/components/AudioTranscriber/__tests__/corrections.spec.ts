import { reduceCorrections } from '../corrections';
import type { TTranscriptCorrection } from 'librechat-data-provider';

function correction(overrides: Partial<TTranscriptCorrection>): TTranscriptCorrection {
  return {
    _id: 'x',
    transcriptFileId: 't',
    conversationId: 'c',
    user: 'u',
    type: 'line_delete',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TTranscriptCorrection;
}

describe('reduceCorrections - deleted lines', () => {
  it('reports a deleted line so the panel can drop it', () => {
    const { deletedLines } = reduceCorrections([correction({ type: 'line_delete', lineIndex: 4 })]);

    expect(deletedLines.has(4)).toBe(true);
  });

  it('reports nothing deleted for a log with no deletions', () => {
    const { deletedLines } = reduceCorrections([
      correction({ type: 'text_edit', lineIndex: 4, toText: 'Edited.' }),
    ]);

    expect(deletedLines.size).toBe(0);
  });

  /** A hand-inserted line must be removable the same way a pipeline line is,
   *  which is the case that prompted the feature - an insert made by mistake. */
  it('drops an inserted line that was later deleted', () => {
    const { insertedLines, deletedLines } = reduceCorrections([
      correction({
        type: 'line_insert',
        lineIndex: 2.5,
        text: 'Added by mistake.',
        seconds: 5,
        endSeconds: 6,
      }),
      correction({ type: 'line_delete', lineIndex: 2.5 }),
    ]);

    expect(deletedLines.has(2.5)).toBe(true);
    expect(insertedLines[2.5]).toBeUndefined();
  });

  it('keeps a fractional index distinct from its neighbours', () => {
    const { deletedLines } = reduceCorrections([
      correction({ type: 'line_delete', lineIndex: 2.5 }),
    ]);

    expect(deletedLines.has(2)).toBe(false);
    expect(deletedLines.has(2.5)).toBe(true);
  });

  /** The neighbour's reabsorbed range arrives as an ordinary time_edit, so
   *  it has to survive replay alongside the deletion itself. */
  it('keeps the neighbouring time edit that reabsorbs the removed range', () => {
    const { deletedLines, timeEdits } = reduceCorrections([
      correction({ type: 'line_delete', lineIndex: 1 }),
      correction({ type: 'time_edit', lineIndex: 2, seconds: 2, endSeconds: 6 }),
    ]);

    expect(deletedLines.has(1)).toBe(true);
    expect(timeEdits[2]).toEqual({ seconds: 2, endSeconds: 6 });
  });
});
