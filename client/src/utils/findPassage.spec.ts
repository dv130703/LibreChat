import { findPassage } from './findPassage';

describe('findPassage', () => {
  it('finds an exact substring match', () => {
    const haystack = 'The quick brown fox jumps over the lazy dog.';
    const needle = 'brown fox jumps';
    const match = findPassage(haystack, needle);
    expect(match).toEqual({ start: 10, end: 25 });
    expect(haystack.slice(match!.start, match!.end)).toBe(needle);
  });

  it('tolerates whitespace/line-wrap differences between chunk and rendered file', () => {
    const haystack = 'Section 1.\n\nThe   quick\nbrown   fox\njumps over the lazy dog.\n\nSection 2.';
    const needle = 'The quick brown fox jumps over the lazy dog.';
    const match = findPassage(haystack, needle);
    expect(match).not.toBeNull();
    expect(haystack.slice(match!.start, match!.end)).toContain('quick');
  });

  it('is case-insensitive', () => {
    const haystack = 'AN IMPORTANT CLAUSE ABOUT LIABILITY FOLLOWS HERE.';
    const needle = 'important clause about liability';
    const match = findPassage(haystack, needle);
    expect(match).not.toBeNull();
  });

  it('falls back to a shorter prefix when the tail of a long chunk does not match', () => {
    // Repeated well past the 120-char shortest fallback anchor, so that
    // candidate lands entirely within the shared prefix rather than bleeding
    // into the diverging tail below.
    const sharedPrefix = 'This is the real retrieved passage that should anchor the highlight. '.repeat(3);
    const haystack = `${sharedPrefix}${'y'.repeat(400)}`;
    // Simulates a chunk whose tail diverged from the rendered file (e.g. a
    // PDF extraction artifact) but whose start is still verbatim.
    const needle = `${sharedPrefix}${'z'.repeat(400)}`;
    const match = findPassage(haystack, needle);
    expect(match).not.toBeNull();
    expect(haystack.slice(match!.start, match!.end)).toContain('This is the real retrieved');
  });

  it('returns null instead of guessing when nothing matches', () => {
    const haystack = 'Completely unrelated document content here.';
    const needle = 'This text does not appear anywhere in the document at all.';
    expect(findPassage(haystack, needle)).toBeNull();
  });

  it('returns null for empty inputs', () => {
    expect(findPassage('', 'needle')).toBeNull();
    expect(findPassage('haystack', '')).toBeNull();
    expect(findPassage('haystack', '   ')).toBeNull();
  });

  it('does not throw on regex-special characters in the needle', () => {
    const haystack = 'The formula (a+b)^2 = a^2 + 2ab + b^2 is well known.';
    const needle = '(a+b)^2 = a^2 + 2ab + b^2';
    expect(() => findPassage(haystack, needle)).not.toThrow();
    expect(findPassage(haystack, needle)).not.toBeNull();
  });

  it('matches a short needle directly without being filtered out by length heuristics', () => {
    const haystack = 'Prefix text. Exact short target. Suffix text.';
    const needle = 'Exact short target.';
    const match = findPassage(haystack, needle);
    expect(match).not.toBeNull();
    expect(haystack.slice(match!.start, match!.end)).toBe(needle);
  });
});
