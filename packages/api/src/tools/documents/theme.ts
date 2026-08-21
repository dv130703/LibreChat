/** One palette and type scale shared by all three generators, so a docx, xlsx and
 *  pdf produced from the same content look like siblings rather than three
 *  unrelated files. Colours are stated twice because the libraries disagree on
 *  format: docx and pdf take `RRGGBB`/`#RRGGBB`, ExcelJS takes `AARRGGBB`. */

export const PALETTE = {
  /** Headings, table header fill. */
  primary: '1F3864',
  /** Body text. */
  text: '1A1A1A',
  /** Secondary text, rules, footers. */
  muted: '6B7280',
  /** Table borders. */
  border: 'C9CFD8',
  /** Every second table row. */
  zebra: 'F4F6F9',
  /** Text on the primary fill. */
  onPrimary: 'FFFFFF',
} as const;

export const argb = (hex: string): string => `FF${hex}`;
export const hash = (hex: string): string => `#${hex}`;

export const FONT = {
  /** Body face. Available to Word and Excel; PDF uses its Helvetica equivalent. */
  body: 'Calibri',
  heading: 'Calibri',
} as const;

/** Point sizes, shared so headings stay proportional across formats. */
export const SIZE = {
  title: 26,
  h1: 18,
  h2: 14,
  h3: 12,
  body: 11,
  small: 9,
} as const;

/** Excel number formats applied by column when the data warrants it. */
export const NUMBER_FORMATS = {
  integer: '#,##0',
  decimal: '#,##0.00',
  currency: '#,##0.00',
  percent: '0.0%',
} as const;
