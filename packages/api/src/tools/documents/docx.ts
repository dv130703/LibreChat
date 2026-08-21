import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  PageBreak,
  BorderStyle,
  AlignmentType,
  ShadingType,
  Footer,
  PageNumber,
  convertInchesToTwip,
} from 'docx';
import { PALETTE, FONT, SIZE } from './theme';
import { analyzeSheet, formatForDisplay, isNumericType } from './analyze';
import type { DocumentSpec, DocumentBlock } from './types';

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

const HEADING_SIZES = { 1: SIZE.h1, 2: SIZE.h2, 3: SIZE.h3 } as const;

/** Banding below this many rows reads as an accident rather than a pattern. */
const ZEBRA_THRESHOLD = 3;

const edge = { style: BorderStyle.SINGLE, size: 4, color: PALETTE.border };
const CELL_BORDERS = { top: edge, bottom: edge, left: edge, right: edge };
const CELL_MARGINS = { top: 60, bottom: 60, left: 110, right: 110 };

function textColour(isHeader: boolean, emphasise: boolean): string {
  if (isHeader) {
    return PALETTE.onPrimary;
  }
  return emphasise ? PALETTE.primary : PALETTE.text;
}

function cellFill(isHeader: boolean, shade: boolean): string | undefined {
  if (isHeader) {
    return PALETTE.primary;
  }
  return shade ? PALETTE.zebra : undefined;
}

function cell(
  text: string,
  isHeader: boolean,
  shade: boolean,
  alignRight: boolean,
  emphasise = false,
): TableCell {
  const fill = cellFill(isHeader, shade);
  return new TableCell({
    borders: CELL_BORDERS,
    margins: CELL_MARGINS,
    shading: fill == null ? undefined : { type: ShadingType.CLEAR, fill },
    children: [
      new Paragraph({
        spacing: { before: 0, after: 0 },
        alignment: alignRight ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [
          new TextRun({
            text,
            bold: isHeader || emphasise,
            font: FONT.body,
            size: SIZE.body * 2,
            color: textColour(isHeader, emphasise),
          }),
        ],
      }),
    ],
  });
}

function renderBlock(block: DocumentBlock): (Paragraph | Table)[] {
  if (block.type === 'heading') {
    return [
      new Paragraph({
        heading: HEADINGS[block.level ?? 2],
        spacing: { before: 260, after: 120 },
        children: [
          new TextRun({
            text: block.text,
            bold: true,
            font: FONT.heading,
            color: PALETTE.primary,
            size: HEADING_SIZES[block.level ?? 2] * 2,
          }),
        ],
      }),
    ];
  }

  if (block.type === 'paragraph') {
    return [
      new Paragraph({
        spacing: { after: 160, line: 300 },
        children: [
          new TextRun({
            text: block.text,
            font: FONT.body,
            size: SIZE.body * 2,
            color: PALETTE.text,
          }),
        ],
      }),
    ];
  }

  if (block.type === 'bullets') {
    return block.items.map(
      (item) =>
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 80, line: 290 },
          children: [
            new TextRun({ text: item, font: FONT.body, size: SIZE.body * 2, color: PALETTE.text }),
          ],
        }),
    );
  }

  if (block.type === 'pagebreak') {
    return [new Paragraph({ children: [new PageBreak()] })];
  }

  /* Analyse the table so numeric columns are right-aligned and formatted the way
   * a reader expects, blank separator rows are dropped rather than rendered as
   * empty banded rows, and a totals row the model wrote is emphasised. */
  const { header, rows, columns } = analyzeSheet(block.rows);
  const visible = rows.filter((row) => row.kind !== 'blank');
  let dataSeen = 0;

  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          tableHeader: true,
          children: columns.map((column, i) =>
            cell(header[i] ?? '', true, false, isNumericType(column.type)),
          ),
        }),
        ...visible.map((layoutRow) => {
          const isSubtotal = layoutRow.kind === 'subtotal';
          const shade = !isSubtotal && visible.length >= ZEBRA_THRESHOLD && dataSeen % 2 === 1;
          if (!isSubtotal) {
            dataSeen += 1;
          }
          return new TableRow({
            children: columns.map((column, i) =>
              cell(
                formatForDisplay(layoutRow.cells[i] ?? '', column),
                false,
                shade,
                isNumericType(column.type),
                isSubtotal,
              ),
            ),
          });
        }),
      ],
    }),
    /** Tables butt straight into the next block without this. */
    new Paragraph({ spacing: { after: 160 }, children: [] }),
  ];
}

export async function buildDocx(spec: DocumentSpec): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  if (spec.title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        spacing: { after: 80 },
        children: [
          new TextRun({
            text: spec.title,
            bold: true,
            font: FONT.heading,
            size: SIZE.title * 2,
            color: PALETTE.primary,
          }),
        ],
      }),
      /** A rule under the title, drawn as a bottom border on an empty paragraph. */
      new Paragraph({
        spacing: { after: 240 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: PALETTE.border } },
        children: [],
      }),
    );
  }

  for (const block of spec.blocks ?? []) {
    children.push(...renderBlock(block));
  }
  if (children.length === 0) {
    children.push(new Paragraph({ children: [] }));
  }

  const document = new Document({
    creator: 'LibreChat',
    title: spec.title,
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
                    font: FONT.body,
                    size: SIZE.small * 2,
                    color: PALETTE.muted,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return await Packer.toBuffer(document);
}
