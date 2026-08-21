import ExcelJS from 'exceljs';
import { analyzeSheet } from './analyze';
import { PALETTE, argb } from './theme';
import { generateDocument } from './generate';

/** Models write tables the way a person types them: a title, a generated-on line,
 *  a blank, the header, data, a blank, a grand total. Treating row 0 as the header
 *  styled the title as a header and banded the blank rows. */

const messy = [
  ['Q1 2024 Sales Report', '', '', ''],
  ['Generated: 2024-04-02', '', '', ''],
  ['', '', '', ''],
  ['Region', 'Product', 'Units Sold', 'Total Revenue'],
  ['North', 'Acme Widget', '1,250', '$62,487.50'],
  ['North', 'Beta Gadget', '830', '$66,391.70'],
  ['South', 'Gamma Pro', '2,100', '$314,979.00'],
  ['', '', '', ''],
  ['GRAND TOTAL', 'All Products', '4,180', '$443,858.20'],
];

describe('analyzeSheet', () => {
  it('finds the real header beneath a preamble', () => {
    const { header, preamble } = analyzeSheet(messy);
    expect(header).toEqual(['Region', 'Product', 'Units Sold', 'Total Revenue']);
    expect(preamble).toEqual(['Q1 2024 Sales Report', 'Generated: 2024-04-02']);
  });

  it('classifies blank separators and totals rows', () => {
    const { rows } = analyzeSheet(messy);
    expect(rows.map((row) => row.kind)).toEqual(['data', 'data', 'data', 'blank', 'subtotal']);
    expect(analyzeSheet(messy).hasTotalRow).toBe(true);
  });

  it('types columns from data rows only, ignoring the totals banner', () => {
    const { columns } = analyzeSheet(messy);
    expect(columns.map((column) => column.type)).toEqual(['text', 'text', 'integer', 'currency']);
  });

  it('treats a single wide row with no data beneath it as a preamble, not a header', () => {
    const { preamble, header } = analyzeSheet([
      ['Report Title', '', ''],
      ['', '', ''],
      ['A', 'B', 'C'],
      ['1', '2', '3'],
    ]);
    expect(preamble).toEqual(['Report Title']);
    expect(header).toEqual(['A', 'B', 'C']);
  });

  it('trims trailing columns that are empty throughout', () => {
    const { width } = analyzeSheet([
      ['A', 'B', '', ''],
      ['1', '2', '', ''],
    ]);
    expect(width).toBe(2);
  });

  it('falls back to the first row when there is no preamble', () => {
    const { header, preamble } = analyzeSheet([
      ['A', 'B'],
      ['1', '2'],
    ]);
    expect(preamble).toEqual([]);
    expect(header).toEqual(['A', 'B']);
  });
});

describe('xlsx layout rendering', () => {
  async function render() {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'layout',
      sheets: [{ name: 'Report', rows: messy }],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(doc.buffer as unknown as ArrayBuffer);
    return workbook.getWorksheet('Report')!;
  }

  it('merges the preamble across the table width', async () => {
    const sheet = await render();
    /** On reload ExcelJS exposes merges as an array of range strings. */
    const merges = (sheet.model.merges ?? []) as unknown as string[];
    expect(merges).toContain('A1:D1');
  });

  it('styles the real header row, not the title', async () => {
    const sheet = await render();
    const title = sheet.getRow(1).getCell(1).fill as ExcelJS.FillPattern;
    const header = sheet.getRow(4).getCell(1).fill as ExcelJS.FillPattern;

    expect(title?.fgColor?.argb).toBeUndefined();
    expect(header?.fgColor?.argb).toBe(argb(PALETTE.primary));
  });

  it('anchors freeze and filter to the real header', async () => {
    const sheet = await render();
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
    /** Reading back, the filter is a range string rather than the object set. */
    expect(sheet.autoFilter).toBe('A4:D4');
  });

  it('leaves blank separator rows unstyled', async () => {
    const sheet = await render();
    expect((sheet.getRow(8).getCell(1).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBeUndefined();
    expect(sheet.getRow(8).getCell(1).border?.top).toBeUndefined();
  });

  it('emphasises a totals row the model wrote and adds none of its own', async () => {
    const sheet = await render();
    const total = sheet.getRow(9);

    expect(total.font?.bold).toBe(true);
    expect(total.getCell(1).border?.top?.style).toBe('double');
    /** No appended Total row: the model already supplied one. */
    expect(sheet.rowCount).toBe(9);
  });
});
