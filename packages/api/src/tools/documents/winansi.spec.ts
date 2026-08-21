import { sanitizeForPdf } from './winansi';

/** Characters outside cp1252 do not fail loudly in PDFKit — they surface as
 *  mojibake in the finished file, which is how `→` reached a user's PDF as `!’`. */
describe('sanitizeForPdf', () => {
  it('keeps characters cp1252 can represent', () => {
    const safe = 'Curly “quotes” and ‘singles’ – en dash — em dash… café € 50 ° ok';
    expect(sanitizeForPdf(safe)).toBe(safe);
  });

  it('transliterates symbols that would otherwise render as garbage', () => {
    expect(sanitizeForPdf('a → b')).toBe('a -> b');
    expect(sanitizeForPdf('✓ done, ✗ failed')).toBe('v done, x failed');
    expect(sanitizeForPdf('x ≠ y, a ≤ b')).toBe('x != y, a <= b');
    expect(sanitizeForPdf('☑ checked ☐ unchecked')).toBe('[x] checked [ ] unchecked');
  });

  it('drops characters with no sensible ASCII equivalent', () => {
    expect(sanitizeForPdf('emoji 😀 here')).toBe('emoji  here');
    expect(sanitizeForPdf('日本語')).toBe('');
  });

  it('preserves newlines and tabs', () => {
    expect(sanitizeForPdf('a\nb\tc')).toBe('a\nb\tc');
  });

  it('leaves plain ASCII untouched', () => {
    const plain = 'The north vault was sealed in 1893. Cost: $1,207,486.70 (100%).';
    expect(sanitizeForPdf(plain)).toBe(plain);
  });
});
