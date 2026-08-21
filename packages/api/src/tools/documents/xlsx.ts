import ExcelJS from 'exceljs';
import { PALETTE, FONT, SIZE, argb } from './theme';
import { analyzeSheet } from './analyze';
import type { ColumnProfile, LayoutRow } from './analyze';
import type { DocumentSpec, SheetSpec } from './types';

/** Excel caps column width at 255; well below that is where readability stops. */
const MAX_COLUMN_WIDTH = 60;
const MIN_COLUMN_WIDTH = 10;
/** Beyond this, banding is noise rather than help. */
const ZEBRA_THRESHOLD = 3;

const thin = { style: 'thin' as const, color: { argb: argb(PALETTE.border) } };
const ALL_BORDERS = { top: thin, left: thin, bottom: thin, right: thin };

function styleHeader(row: ExcelJS.Row): void {
  row.font = {
    name: FONT.heading,
    size: SIZE.body,
    bold: true,
    color: { argb: argb(PALETTE.onPrimary) },
  };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.primary) } };
  row.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  row.height = 22;
  row.eachCell((cell) => {
    cell.border = ALL_BORDERS;
  });
}

function autoFitColumns(sheet: ExcelJS.Worksheet): void {
  sheet.columns.forEach((column) => {
    let widest = MIN_COLUMN_WIDTH;
    column.eachCell?.({ includeEmpty: false }, (cell, rowNumber) => {
      /* Wrapped header text should not drag the column to the header's full
       * length, so measure it at half weight. */
      const raw = String(cell.value ?? '');
      const length = rowNumber === 1 ? raw.length / 2 : raw.length;
      if (length > widest) {
        widest = length;
      }
    });
    column.width = Math.min(Math.ceil(widest) + 3, MAX_COLUMN_WIDTH);
  });
}

/** Title and any subtitle above the table, merged across its full width. */
function writePreamble(sheet: ExcelJS.Worksheet, preamble: string[], width: number): number {
  preamble.forEach((text, index) => {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, Math.max(1, width));
    const isTitle = index === 0;
    row.getCell(1).font = {
      name: FONT.heading,
      size: isTitle ? SIZE.h2 : SIZE.body,
      bold: isTitle,
      color: { argb: argb(isTitle ? PALETTE.primary : PALETTE.muted) },
    };
    row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    row.height = isTitle ? 24 : 18;
  });

  if (preamble.length > 0) {
    sheet.addRow([]);
  }

  return sheet.rowCount;
}

function styleDataRow(row: ExcelJS.Row, columns: ColumnProfile[], banded: boolean): void {
  row.font = { name: FONT.body, size: SIZE.body, color: { argb: argb(PALETTE.text) } };
  row.eachCell((cell, columnNumber) => {
    const profile = columns[columnNumber - 1];
    cell.border = ALL_BORDERS;
    cell.alignment = {
      vertical: 'top',
      horizontal: profile?.align ?? 'left',
      wrapText: profile?.type === 'text',
    };
    if (banded) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(PALETTE.zebra) } };
    }
  });
}

/** A total the model wrote itself: emphasised, ruled off, never banded. */
function styleSubtotalRow(row: ExcelJS.Row, columns: ColumnProfile[]): void {
  row.font = {
    name: FONT.body,
    size: SIZE.body,
    bold: true,
    color: { argb: argb(PALETTE.primary) },
  };
  row.eachCell((cell, columnNumber) => {
    const profile = columns[columnNumber - 1];
    cell.border = {
      ...ALL_BORDERS,
      top: { style: 'double', color: { argb: argb(PALETTE.primary) } },
    };
    cell.alignment = { vertical: 'top', horizontal: profile?.align ?? 'left' };
  });
}

/** A totals row of real SUM formulas, so figures recalculate if the reader edits
 *  a cell. `from`/`to` are the contiguous data rows it covers. */
function appendTotals(
  sheet: ExcelJS.Worksheet,
  from: number,
  to: number,
  columns: ColumnProfile[],
): void {
  if (to - from < 1 || !columns.some((column) => column.totalable)) {
    return;
  }

  const cells = columns.map((column, index) => {
    if (index === 0) {
      return 'Total';
    }
    if (!column.totalable) {
      return null;
    }
    const letter = sheet.getColumn(index + 1).letter;
    return { formula: `SUM(${letter}${from}:${letter}${to})` };
  });

  const row = sheet.addRow(cells);
  styleSubtotalRow(row, columns);
  row.eachCell((cell, columnNumber) => {
    const profile = columns[columnNumber - 1];
    if (profile?.numFmt) {
      cell.numFmt = profile.numFmt;
    }
  });
}

function buildSheet(workbook: ExcelJS.Workbook, spec: SheetSpec): void {
  /** Excel rejects these characters in a sheet name and caps it at 31 chars. */
  const name = (spec.name || 'Sheet').replace(/[*?:/\\[\]]/g, '-').slice(0, 31);
  const sheet = workbook.addWorksheet(name, {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  if (spec.rows.length === 0) {
    return;
  }

  const { preamble, header, rows, columns, width, hasTotalRow } = analyzeSheet(spec.rows);

  writePreamble(sheet, preamble, width);

  const headerRowNumber = sheet.addRow(header).number;
  styleHeader(sheet.getRow(headerRowNumber));

  /* Freeze and filter anchor to the real header, wherever the preamble left it. */
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: width },
  };

  let firstDataRow = 0;
  let lastDataRow = 0;
  /* Banding counts data rows only, so a blank separator does not invert the
   * stripe pattern for everything beneath it. */
  let dataSeen = 0;

  const written: Array<{ row: ExcelJS.Row; kind: LayoutRow['kind'] }> = [];
  for (const layoutRow of rows) {
    const excelRow = sheet.addRow(layoutRow.cells);
    written.push({ row: excelRow, kind: layoutRow.kind });

    if (layoutRow.kind === 'data') {
      dataSeen += 1;
      firstDataRow = firstDataRow || excelRow.number;
      lastDataRow = excelRow.number;
    }
  }

  const dataCount = dataSeen;
  dataSeen = 0;
  for (const { row, kind } of written) {
    if (kind === 'blank') {
      continue;
    }
    if (kind === 'subtotal') {
      styleSubtotalRow(row, columns);
      continue;
    }
    styleDataRow(row, columns, dataCount >= ZEBRA_THRESHOLD && dataSeen % 2 === 1);
    dataSeen += 1;
  }

  columns.forEach((column, index) => {
    if (column.numFmt) {
      sheet.getColumn(index + 1).numFmt = column.numFmt;
    }
  });

  if (!hasTotalRow && firstDataRow > 0) {
    appendTotals(sheet, firstDataRow, lastDataRow, columns);
  }

  autoFitColumns(sheet);
}

export async function buildXlsx(spec: DocumentSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  if (spec.title) {
    workbook.title = spec.title;
  }

  const sheets = spec.sheets?.length ? spec.sheets : [{ name: 'Sheet1', rows: [] }];
  for (const sheetSpec of sheets) {
    buildSheet(workbook, sheetSpec);
  }

  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}
