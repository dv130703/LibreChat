import PDFDocument from 'pdfkit';
import { PALETTE, SIZE, hash } from './theme';
import { analyzeSheet, formatForDisplay, isNumericType } from './analyze';
import { sanitizeForPdf } from './winansi';
import type { DocumentSpec, DocumentBlock } from './types';

const MARGIN = 56;
const HEADING_SIZES = { 1: SIZE.h1, 2: SIZE.h2, 3: SIZE.h3 } as const;
const ZEBRA_THRESHOLD = 3;
const CELL_PAD = 6;

/** pdfkit streams; collect the chunks so the caller gets one buffer. */
function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - MARGIN * 2;
}

function drawTable(doc: PDFKit.PDFDocument, rawRows: string[][]): void {
  /* Profiling gives numeric columns right alignment and reader-facing formatting;
   * without it a revenue column prints as "62487.5" and left-aligned. */
  const { header, rows, columns } = analyzeSheet(rawRows);
  const width = columns.length;
  if (width === 0) {
    return;
  }

  /* Blank separator rows would print as empty banded strips, so drop them. */
  const visible = rows.filter((row) => row.kind !== 'blank');
  const columnWidth = contentWidth(doc) / width;
  const bodyCount = visible.length;
  const display: Array<{ cells: string[]; emphasise: boolean }> = [
    { cells: header.map((label) => sanitizeForPdf(label)), emphasise: false },
    ...visible.map((row) => ({
      cells: columns.map((column, i) =>
        sanitizeForPdf(formatForDisplay(row.cells[i] ?? '', column)),
      ),
      emphasise: row.kind === 'subtotal',
    })),
  ];

  display.forEach(({ cells, emphasise }, index) => {
    const isHeader = index === 0;

    doc.font(isHeader || emphasise ? 'Helvetica-Bold' : 'Helvetica').fontSize(SIZE.small + 1);

    /* Measure the tallest cell first so a wrapped cell cannot overlap the next row. */
    const textHeight = cells.reduce(
      (tallest, cell) =>
        Math.max(tallest, doc.heightOfString(cell, { width: columnWidth - CELL_PAD * 2 })),
      0,
    );
    const rowHeight = textHeight + CELL_PAD * 2;

    if (doc.y + rowHeight > doc.page.height - MARGIN * 1.5) {
      doc.addPage();
    }

    const top = doc.y;

    if (isHeader) {
      doc.rect(MARGIN, top, contentWidth(doc), rowHeight).fill(hash(PALETTE.primary));
    } else if (!emphasise && bodyCount >= ZEBRA_THRESHOLD && index % 2 === 0) {
      doc.rect(MARGIN, top, contentWidth(doc), rowHeight).fill(hash(PALETTE.zebra));
    }

    doc.fillColor(
      isHeader ? hash(PALETTE.onPrimary) : hash(emphasise ? PALETTE.primary : PALETTE.text),
    );
    cells.forEach((cell, i) => {
      const column = columns[i];
      doc.text(cell, MARGIN + i * columnWidth + CELL_PAD, top + CELL_PAD, {
        width: columnWidth - CELL_PAD * 2,
        align: column && isNumericType(column.type) ? 'right' : 'left',
      });
    });

    /* Column separators and a baseline, drawn after the text so they sit on top
     * of the fill rather than being painted over by it. */
    doc.lineWidth(0.5).strokeColor(hash(PALETTE.border));
    for (let i = 1; i < width; i += 1) {
      doc
        .moveTo(MARGIN + i * columnWidth, top)
        .lineTo(MARGIN + i * columnWidth, top + rowHeight)
        .stroke();
    }
    doc
      .moveTo(MARGIN, top + rowHeight)
      .lineTo(doc.page.width - MARGIN, top + rowHeight)
      .stroke();

    doc.fillColor(hash(PALETTE.text));
    doc.y = top + rowHeight;
  });

  doc.moveDown(1);
}

function renderBlock(doc: PDFKit.PDFDocument, block: DocumentBlock): void {
  if (block.type === 'heading') {
    const level = block.level ?? 2;
    doc
      .font('Helvetica-Bold')
      .fontSize(HEADING_SIZES[level])
      .fillColor(hash(PALETTE.primary))
      .text(sanitizeForPdf(block.text), MARGIN, doc.y, { width: contentWidth(doc) })
      .fillColor(hash(PALETTE.text))
      .moveDown(0.45);
    return;
  }

  if (block.type === 'paragraph') {
    doc
      .font('Helvetica')
      .fontSize(SIZE.body)
      .fillColor(hash(PALETTE.text))
      .text(sanitizeForPdf(block.text), MARGIN, doc.y, {
        width: contentWidth(doc),
        align: 'left',
        lineGap: 2,
      })
      .moveDown(0.7);
    return;
  }

  if (block.type === 'bullets') {
    doc
      .font('Helvetica')
      .fontSize(SIZE.body)
      .fillColor(hash(PALETTE.text))
      .list(block.items.map(sanitizeForPdf), MARGIN, doc.y, {
        width: contentWidth(doc),
        bulletRadius: 1.8,
        textIndent: 12,
        lineGap: 2,
      })
      .moveDown(0.7);
    return;
  }

  if (block.type === 'pagebreak') {
    doc.addPage();
    return;
  }

  drawTable(doc, block.rows);
}

/** Page numbers are stamped at the end, once the total is known. */
function stampFooters(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);

    /* pdfkit suppresses text written below the bottom margin (it treats the
     * overflow as a page break), so drop the margin for the stamp and restore
     * it — without this the footer silently never appears. */
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc
      .font('Helvetica')
      .fontSize(SIZE.small)
      .fillColor(hash(PALETTE.muted))
      .text(`${i + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN + 14, {
        width: contentWidth(doc),
        align: 'center',
        lineBreak: false,
      });

    doc.page.margins.bottom = bottom;
  }
}

export async function buildPdf(spec: DocumentSpec): Promise<Buffer> {
  /* bufferPages so the footer can state a total page count. */
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4', bufferPages: true });
  const done = collect(doc);

  if (spec.title) {
    doc
      .font('Helvetica-Bold')
      .fontSize(SIZE.title)
      .fillColor(hash(PALETTE.primary))
      .text(sanitizeForPdf(spec.title), MARGIN, doc.y, { width: contentWidth(doc) })
      .moveDown(0.3);

    doc
      .lineWidth(1)
      .strokeColor(hash(PALETTE.border))
      .moveTo(MARGIN, doc.y)
      .lineTo(doc.page.width - MARGIN, doc.y)
      .stroke();

    doc.moveDown(0.8).fillColor(hash(PALETTE.text));
  }

  for (const block of spec.blocks ?? []) {
    renderBlock(doc, block);
  }

  stampFooters(doc);
  doc.end();
  return await done;
}
