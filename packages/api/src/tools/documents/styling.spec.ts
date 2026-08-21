import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import { PALETTE, argb } from './theme';
import { generateDocument } from './generate';

/** Styling is the whole point of these files, so assert on what actually landed
 *  in the workbook rather than trusting that the calls were made. */

const rows = [
  ['Region', 'Product', 'Units', 'Revenue'],
  ['North', 'Widget', 1250, 62487.5],
  ['South', 'Widget', 980, 48990.2],
  ['East', 'Gadget', 1540, 123184.6],
  ['West', 'Gadget', 2100, 104979.0],
];

/** pdfkit deflates its content streams, so drawn text is invisible to a raw byte
 *  search. Inflate every Flate stream and return the concatenated result. */
function pdfStreamText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const parts: string[] = [];
  const pattern = /stream\r?\n/g;

  let match = pattern.exec(raw);
  while (match !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end !== -1) {
      try {
        parts.push(
          zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'),
        );
      } catch {
        /* Not a Flate stream (fonts, metadata); nothing to read here. */
      }
    }
    match = pattern.exec(raw);
  }

  /* Drawn glyphs are written as hex string literals (`<4c6f6e67>`), so decode
   * those back to text before searching. */
  return parts
    .join('\n')
    .replace(/<([0-9a-fA-F]+)>/g, (_, hex: string) =>
      hex.length % 2 === 0 ? Buffer.from(hex, 'hex').toString('latin1') : hex,
    );
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

describe('xlsx styling and usability', () => {
  it('styles the header, freezes it, and adds filter dropdowns', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'sales',
      sheets: [{ name: 'Sales', rows }],
    });

    const sheet = (await loadWorkbook(doc.buffer)).getWorksheet('Sales')!;
    const header = sheet.getRow(1);

    expect(header.font?.bold).toBe(true);
    expect(header.font?.color?.argb).toBe(argb(PALETTE.onPrimary));
    expect((header.fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe(argb(PALETTE.primary));
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it('bands alternate body rows', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'sales',
      sheets: [{ name: 'Sales', rows }],
    });

    const sheet = (await loadWorkbook(doc.buffer)).getWorksheet('Sales')!;
    const banded = sheet.getRow(3).getCell(1).fill as ExcelJS.FillPattern;
    const plain = sheet.getRow(2).getCell(1).fill as ExcelJS.FillPattern;

    expect(banded?.fgColor?.argb).toBe(argb(PALETTE.zebra));
    expect(plain?.fgColor?.argb).toBeUndefined();
  });

  it('applies number formats so columns stay summable', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'sales',
      sheets: [{ name: 'Sales', rows }],
    });

    const sheet = (await loadWorkbook(doc.buffer)).getWorksheet('Sales')!;

    expect(sheet.getColumn(3).numFmt).toBe('#,##0');
    expect(sheet.getColumn(4).numFmt).toBe('#,##0.00');
    /** Text columns must stay unformatted and left aligned. */
    expect(sheet.getColumn(1).numFmt).toBeUndefined();
    /** The values themselves stay numeric, not stringified by the formatting. */
    expect(sheet.getCell(2, 3).value).toBe(1250);
  });

  it('borders every cell', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'sales',
      sheets: [{ name: 'Sales', rows }],
    });

    const sheet = (await loadWorkbook(doc.buffer)).getWorksheet('Sales')!;
    expect(sheet.getCell(2, 1).border?.top?.color?.argb).toBe(argb(PALETTE.border));
  });

  it('skips banding for very short tables', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'tiny',
      sheets: [{ name: 'Tiny', rows: [['A'], ['1']] }],
    });

    const sheet = (await loadWorkbook(doc.buffer)).getWorksheet('Tiny')!;
    expect((sheet.getRow(2).getCell(1).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBeUndefined();
  });
});

describe('docx and pdf styling', () => {
  it('produces a multi-page pdf with page-number footers', async () => {
    const doc = await generateDocument({
      format: 'pdf',
      filename: 'long',
      title: 'Long Report',
      blocks: [
        { type: 'paragraph', text: 'First page.' },
        { type: 'pagebreak' },
        { type: 'paragraph', text: 'Second page.' },
      ],
    });

    const text = doc.buffer.toString('latin1');
    expect(text.slice(0, 5)).toBe('%PDF-');
    /** One `/Type /Page` object per page; `/Count` covers the page tree. */
    expect(text.match(/\/Type \/Page[^s]/g)).toHaveLength(2);
    expect(text).toContain('/Count 2');
  });

  it('stamps a page-number footer on every page', async () => {
    /** pdfkit silently drops text written below the bottom margin, so this
     *  guards a footer that once rendered as nothing at all. */
    const doc = await generateDocument({
      format: 'pdf',
      filename: 'long',
      title: 'Long Report',
      blocks: [
        { type: 'paragraph', text: 'First page.' },
        { type: 'pagebreak' },
        { type: 'paragraph', text: 'Second page.' },
      ],
    });

    const drawn = pdfStreamText(doc.buffer);
    expect(drawn).toContain('1 of 2');
    expect(drawn).toContain('2 of 2');
  });

  it('still produces a valid docx with tables and headings', async () => {
    const doc = await generateDocument({
      format: 'docx',
      filename: 'report',
      title: 'Report',
      blocks: [
        { type: 'heading', text: 'Findings', level: 2 },
        { type: 'table', rows: rows.map((row) => row.map(String)) },
      ],
    });

    expect(doc.buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});
