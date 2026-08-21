import { NUMBER_FORMATS } from './theme';
import type { SheetSpec } from './types';

/** Models emit tabular data as whatever the JSON happened to hold: "1,250" as a
 *  string, "45%" as text, an ISO date as a string. Written through verbatim that
 *  produces a spreadsheet nothing can sort, filter or total. Profiling each column
 *  recovers the real type once, so every generator can format and align from it. */

export type ColumnType =
  | 'integer'
  | 'decimal'
  | 'currency'
  | 'percent'
  | 'date'
  | 'boolean'
  | 'text';

export type CellValue = string | number | boolean | Date | null;

export interface ColumnProfile {
  header: string;
  type: ColumnType;
  /** Excel number format, when the type has one. */
  numFmt?: string;
  align: 'left' | 'right' | 'center';
  /** Numeric and summable — a totals row can carry SUM over it. */
  totalable: boolean;
}

const CURRENCY_HEADER =
  /(revenue|cost|price|amount|total|salary|budget|spend|fee|value|balance|usd|eur|gbp|nzd|aud)/i;
const PERCENT_HEADER = /(percent|percentage|rate|margin|share|growth|%)/i;
/** Counts and identifiers must never be summed even though they are numbers. */
const NON_TOTALABLE_HEADER = /(year|id\b|code|number|no\.|rank|age|score|rating|zip|postcode)/i;

const TRUE_WORDS = new Set(['true', 'yes', 'y']);
const FALSE_WORDS = new Set(['false', 'no', 'n']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?Z?$/;

/** "$1,234.50" / "1 234,50" / "(500)" as accounting negative / "45%". */
function parseNumeric(raw: string): { value: number; percent: boolean; currency: boolean } | null {
  const text = raw.trim();
  if (text === '') {
    return null;
  }

  const percent = text.endsWith('%');
  const currency = /[$£€¥]/.test(text);

  /* Strip symbols and spacing before testing for accounting parentheses, so both
   * "(1,200.50)" and "$(1,200.50)" read as negative. */
  const bare = text.replace(/[$£€¥\s]/g, '').replace(/%$/, '');
  const negative = /^\(.*\)$/.test(bare);
  const cleaned = bare.replace(/^\((.*)\)$/, '$1').replace(/,/g, '');

  if (!/^[+-]?\d*\.?\d+$/.test(cleaned)) {
    return null;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return { value: negative ? -parsed : parsed, percent, currency };
}

function parseCell(raw: CellValue): CellValue {
  if (typeof raw !== 'string') {
    return raw;
  }

  const text = raw.trim();
  if (text === '') {
    return '';
  }

  const lower = text.toLowerCase();
  if (TRUE_WORDS.has(lower)) {
    return true;
  }
  if (FALSE_WORDS.has(lower)) {
    return false;
  }

  if (ISO_DATE.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const numeric = parseNumeric(text);
  if (numeric) {
    /* Percent strings are stored as the fraction Excel expects, so a 0.0% format
     * renders "45%" rather than "4500%". */
    return numeric.percent ? numeric.value / 100 : numeric.value;
  }

  return text;
}

/** Every cell of one column, coerced to its real type. */
export function coerceColumn(values: CellValue[]): CellValue[] {
  return values.map(parseCell);
}

function classify(header: string, values: CellValue[]): ColumnType {
  const present = values.filter((value) => value !== null && value !== '');
  if (present.length === 0) {
    return 'text';
  }

  if (present.every((value) => value instanceof Date)) {
    return 'date';
  }
  if (present.every((value) => typeof value === 'boolean')) {
    return 'boolean';
  }

  const numbers = present.filter((value): value is number => typeof value === 'number');
  /* A column is numeric only if every present value is; one stray label means the
   * column is really text and formatting it as a number would mislead. */
  if (numbers.length !== present.length) {
    return 'text';
  }

  if (PERCENT_HEADER.test(header)) {
    return 'percent';
  }
  if (CURRENCY_HEADER.test(header)) {
    return 'currency';
  }
  return numbers.every((value) => Number.isInteger(value)) ? 'integer' : 'decimal';
}

const FORMATS: Record<ColumnType, string | undefined> = {
  integer: NUMBER_FORMATS.integer,
  decimal: NUMBER_FORMATS.decimal,
  currency: NUMBER_FORMATS.currency,
  percent: NUMBER_FORMATS.percent,
  date: 'yyyy-mm-dd',
  boolean: undefined,
  text: undefined,
};

const ALIGNMENTS: Record<ColumnType, ColumnProfile['align']> = {
  integer: 'right',
  decimal: 'right',
  currency: 'right',
  percent: 'right',
  date: 'center',
  boolean: 'center',
  text: 'left',
};

const NUMERIC: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'integer',
  'decimal',
  'currency',
  'percent',
]);

export function isNumericType(type: ColumnType): boolean {
  return NUMERIC.has(type);
}

export interface TableProfile {
  header: string[];
  /** Body rows with every cell coerced to its real type. */
  rows: CellValue[][];
  columns: ColumnProfile[];
  /** True when the model already supplied its own totals/summary row. */
  hasTotalRow: boolean;
}

const TOTAL_LABEL = /^(total|totals|grand total|sum|subtotal|overall)\b/i;

export function profileTable(rows: SheetSpec['rows']): TableProfile {
  const [rawHeader = [], ...rawBody] = rows;
  const header = rawHeader.map((value) => String(value ?? ''));
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

  const body: CellValue[][] = rawBody.map((row) =>
    Array.from({ length: width }, (_, i) => parseCell((row[i] ?? '') as CellValue)),
  );

  const columns: ColumnProfile[] = Array.from({ length: width }, (_, index) => {
    const label = header[index] ?? '';
    const values = body.map((row) => row[index] ?? null);
    const type = classify(label, values);
    return {
      header: label,
      type,
      numFmt: FORMATS[type],
      align: ALIGNMENTS[type],
      totalable: isNumericType(type) && type !== 'percent' && !NON_TOTALABLE_HEADER.test(label),
    };
  });

  const firstCell = body.length > 0 ? String(body[body.length - 1]?.[0] ?? '') : '';

  return { header, rows: body, columns, hasTotalRow: TOTAL_LABEL.test(firstCell) };
}

/** Render a coerced value the way a reader expects to see it, for the formats
 *  that have no cell types of their own (docx, pdf). */
export function formatForDisplay(value: CellValue, profile: ColumnProfile): string {
  if (value === null || value === '') {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value !== 'number') {
    return String(value);
  }

  if (profile.type === 'percent') {
    return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  }
  if (profile.type === 'currency') {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (profile.type === 'integer') {
    return value.toLocaleString('en-US');
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------------ layout --

A model rarely emits a clean rectangle. It writes a title, a generated-on line, a
blank, the real header, data, another blank, a TOTALS banner and a grand total —
the shape a person would type. Treating row 0 as the header and everything under
it as uniform data styles the title as a header and bands the blank rows, so the
layout has to be recognised before anything is painted. */

export type RowKind = 'data' | 'blank' | 'subtotal';

export interface LayoutRow {
  kind: RowKind;
  cells: CellValue[];
}

export interface SheetLayout {
  /** Rows above the header — title, subtitle, generated-on line. */
  preamble: string[];
  header: string[];
  rows: LayoutRow[];
  columns: ColumnProfile[];
  width: number;
  /** A totals row is already present, so one must not be appended. */
  hasTotalRow: boolean;
}

const SUBTOTAL_LABEL = /^(total|totals|grand total|subtotal|sub-total|sum|overall|average|mean)\b/i;

function isBlank(row: CellValue[]): boolean {
  return row.every((cell) => cell === null || String(cell ?? '').trim() === '');
}

function filled(row: CellValue[]): number {
  return row.filter((cell) => cell !== null && String(cell ?? '').trim() !== '').length;
}

/**
 * The header is the first row wide enough to be one, with a comparably wide row
 * beneath it. A title line fails the second test — it is followed by a blank or
 * another one-cell line — which is what separates a heading from a header.
 */
function findHeaderRow(rows: CellValue[][]): number {
  for (let i = 0; i < rows.length; i += 1) {
    const width = filled(rows[i]);
    if (width < 2) {
      continue;
    }
    const next = rows.slice(i + 1).find((row) => !isBlank(row));
    if (next && filled(next) >= Math.min(2, width)) {
      return i;
    }
  }
  return 0;
}

/** Columns that are empty from the header down carry no information. */
function usedWidth(header: CellValue[], body: CellValue[][]): number {
  let width = 0;
  const rows = [header, ...body];
  for (const row of rows) {
    for (let i = row.length - 1; i >= width; i -= 1) {
      const cell = row[i];
      if (cell !== null && String(cell ?? '').trim() !== '') {
        width = Math.max(width, i + 1);
        break;
      }
    }
  }
  return width;
}

function classifyRow(cells: CellValue[]): RowKind {
  if (isBlank(cells)) {
    return 'blank';
  }
  const label = String(cells.find((cell) => typeof cell === 'string' && cell.trim() !== '') ?? '');
  return SUBTOTAL_LABEL.test(label.trim()) ? 'subtotal' : 'data';
}

export function analyzeSheet(rawRows: SheetSpec['rows']): SheetLayout {
  const parsed: CellValue[][] = rawRows.map((row) =>
    row.map((cell) => parseCell(cell as CellValue)),
  );

  const headerIndex = findHeaderRow(parsed);
  const preamble = parsed
    .slice(0, headerIndex)
    .filter((row) => !isBlank(row))
    .map((row) => row.map((cell) => String(cell ?? '')).find((text) => text.trim() !== '') ?? '');

  const headerRow = parsed[headerIndex] ?? [];
  const bodyRows = parsed.slice(headerIndex + 1);
  const width = Math.max(1, usedWidth(headerRow, bodyRows));

  const pad = (row: CellValue[]): CellValue[] =>
    Array.from({ length: width }, (_, i) => row[i] ?? '');

  const header = pad(headerRow).map((cell) => String(cell ?? ''));
  const rows: LayoutRow[] = bodyRows.map((row) => {
    const cells = pad(row);
    return { kind: classifyRow(cells), cells };
  });

  /* Only true data rows may inform a column's type: a subtotal row's blanks and
   * banner text would otherwise drag a numeric column back to text. */
  const dataRows = rows.filter((row) => row.kind === 'data').map((row) => row.cells);

  const columns: ColumnProfile[] = Array.from({ length: width }, (_, index) => {
    const label = header[index] ?? '';
    const values = dataRows.map((row) => row[index] ?? null);
    const type = classify(label, values);
    return {
      header: label,
      type,
      numFmt: FORMATS[type],
      align: ALIGNMENTS[type],
      totalable: isNumericType(type) && type !== 'percent' && !NON_TOTALABLE_HEADER.test(label),
    };
  });

  return {
    preamble,
    header,
    rows,
    columns,
    width,
    hasTotalRow: rows.some((row) => row.kind === 'subtotal'),
  };
}
