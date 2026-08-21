/** PDFKit's built-in fonts encode WinAnsi (cp1252) only. A character outside it is
 *  not dropped but silently re-encoded, so a stray arrow or check mark surfaces in
 *  the finished PDF as garbage like `!’` or `Ø=Þ`. Fold the common
 *  offenders to ASCII, then strip anything still unrepresentable. Only PDF needs
 *  this — docx and xlsx are UTF-8 throughout. */

/** Code points cp1252 can represent, beyond printable ASCII. */
const WIN_ANSI_HIGH = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

const TRANSLITERATIONS: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '⇐': '<=',
  '✓': 'v',
  '✔': 'v',
  '✗': 'x',
  '✘': 'x',
  '≠': '!=',
  '≤': '<=',
  '≥': '>=',
  '≈': '~',
  '∞': 'infinity',
  '‑': '-',
  '−': '-',
  '　': ' ',
  '☑': '[x]',
  '☐': '[ ]',
  '★': '*',
  '☆': '*',
  '►': '>',
  '▪': '-',
  '■': '-',
  '●': '-',
  '◦': '-',
};

function isRepresentable(codePoint: number): boolean {
  /** Printable ASCII, then the Latin-1 upper half, then cp1252's own additions. */
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  if (codePoint >= 0xa0 && codePoint <= 0xff) {
    return true;
  }
  return WIN_ANSI_HIGH.has(codePoint);
}

/**
 * Makes text safe for PDFKit's standard fonts.
 *
 * Newlines and tabs are preserved; every other unrepresentable character is
 * transliterated where there is a sensible ASCII equivalent and dropped
 * otherwise, so nothing reaches the page as mojibake.
 */
export function sanitizeForPdf(text: string): string {
  let out = '';

  for (const character of text) {
    if (character === '\n' || character === '\t') {
      out += character;
      continue;
    }

    /* Representability is checked first so characters cp1252 already handles —
     * degree, multiplication sign, curly quotes — pass through untouched rather
     * than being needlessly rewritten. */
    const codePoint = character.codePointAt(0);
    if (codePoint != null && isRepresentable(codePoint)) {
      out += character;
      continue;
    }

    out += TRANSLITERATIONS[character] ?? '';
  }

  return out;
}
