import { activeWordRange } from '../wordTiming';

const text = 'The president and the king.';
const wordAt = (ratio: number): string | null => {
  const range = activeWordRange(text, ratio);
  return range == null ? null : text.slice(range[0], range[1]);
};

describe('activeWordRange', () => {
  it('starts on the first word and ends on the last', () => {
    expect(wordAt(0)).toBe('The');
    expect(wordAt(1)).toBe('king.');
  });

  it('walks the words in order across the line', () => {
    const spoken = [0, 0.2, 0.4, 0.6, 0.8, 1].map(wordAt);
    expect(spoken).toEqual(['The', 'president', 'president', 'and', 'king.', 'king.']);
  });

  it('gives a long word more of the line than a short one', () => {
    const shareOf = (word: string) =>
      Array.from({ length: 100 }, (_, step) => wordAt(step / 100)).filter(
        (spoken) => spoken === word,
      ).length;

    expect(shareOf('president')).toBeGreaterThan(shareOf('and'));
  });

  it('returns offsets into the original text, not a copy of the word', () => {
    expect(activeWordRange('one two', 0.9)).toEqual([4, 7]);
  });

  it('highlights nothing for an empty line or a nonsense ratio', () => {
    expect(activeWordRange('   ', 0.5)).toBeNull();
    expect(activeWordRange(text, Number.NaN)).toBeNull();
    expect(activeWordRange(text, -1)).toBeNull();
  });
});
