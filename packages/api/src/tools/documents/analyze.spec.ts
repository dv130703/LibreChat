import { profileTable, formatForDisplay, coerceColumn } from './analyze';

/** Models emit tabular data as loose JSON — "1,250" as a string, "45%" as text,
 *  dates as ISO strings. These assertions pin what the profiler recovers. */

describe('profileTable', () => {
  const rows = [
    ['Region', 'Launch Date', 'Units', 'Unit Price', 'Margin', 'Active', 'Year'],
    ['North', '2024-01-15', '1,250', '$49.99', '45%', 'yes', 2024],
    ['South', '2024-02-20', '980', '$149.99', '38.5%', 'no', 2024],
    ['East', '2024-03-05', '1540', '79.99', '41%', 'true', 2024],
  ];

  it('recovers the real type of each column', () => {
    const { columns } = profileTable(rows);
    expect(columns.map((c) => c.type)).toEqual([
      'text',
      'date',
      'integer',
      'currency',
      'percent',
      'boolean',
      'integer',
    ]);
  });

  it('coerces stringified numbers, currency and percentages', () => {
    const { rows: body } = profileTable(rows);
    expect(body[0][2]).toBe(1250);
    expect(body[0][3]).toBe(49.99);
    /** Percent is stored as the fraction Excel expects. */
    expect(body[0][4]).toBeCloseTo(0.45);
    expect(body[0][5]).toBe(true);
    expect(body[0][1]).toBeInstanceOf(Date);
  });

  it('aligns by type', () => {
    const { columns } = profileTable(rows);
    expect(columns[0].align).toBe('left');
    expect(columns[1].align).toBe('center');
    expect(columns[2].align).toBe('right');
  });

  it('excludes identifiers and percentages from totals', () => {
    const { columns } = profileTable(rows);
    const totalable = Object.fromEntries(columns.map((c) => [c.header, c.totalable]));
    expect(totalable['Units']).toBe(true);
    expect(totalable['Unit Price']).toBe(true);
    /** A year is a number but summing it is meaningless. */
    expect(totalable['Year']).toBe(false);
    expect(totalable['Margin']).toBe(false);
    expect(totalable['Region']).toBe(false);
  });

  it('treats a column with any stray label as text', () => {
    const { columns } = profileTable([['Units'], ['100'], ['not recorded']]);
    expect(columns[0].type).toBe('text');
  });

  it('detects a totals row the model already supplied', () => {
    const withTotal = [...rows, ['Grand Total', '', '3770', '', '', '', '']];
    expect(profileTable(withTotal).hasTotalRow).toBe(true);
    expect(profileTable(rows).hasTotalRow).toBe(false);
  });

  it('pads ragged rows instead of dropping cells', () => {
    const { rows: body } = profileTable([['A', 'B', 'C'], ['1']]);
    expect(body[0]).toHaveLength(3);
  });

  it('handles accounting negatives', () => {
    expect(coerceColumn(['(500)', '$(1,200.50)'])).toEqual([-500, -1200.5]);
  });
});

describe('formatForDisplay', () => {
  const { columns, rows } = profileTable([
    ['Revenue', 'Margin', 'Units', 'Date', 'Active'],
    ['62487.5', '0.45', '1250', '2024-01-15', 'yes'],
  ]);

  it('formats each type the way a reader expects', () => {
    expect(formatForDisplay(rows[0][0], columns[0])).toBe('62,487.50');
    expect(formatForDisplay(rows[0][2], columns[2])).toBe('1,250');
    expect(formatForDisplay(rows[0][3], columns[3])).toBe('2024-01-15');
    expect(formatForDisplay(rows[0][4], columns[4])).toBe('Yes');
  });

  it('renders empty cells as empty, not "null"', () => {
    expect(formatForDisplay(null, columns[0])).toBe('');
    expect(formatForDisplay('', columns[0])).toBe('');
  });
});
