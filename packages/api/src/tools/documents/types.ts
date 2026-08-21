/** Shared document description the model fills in, one shape for every format. */

export type DocumentFormat = 'docx' | 'xlsx' | 'pdf';

export interface HeadingBlock {
  type: 'heading';
  text: string;
  /** 1 is the document title, 3 the smallest subheading. */
  level?: 1 | 2 | 3;
}

export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
}

export interface BulletsBlock {
  type: 'bullets';
  items: string[];
}

export interface TableBlock {
  type: 'table';
  /** First row is rendered as the header. */
  rows: string[][];
}

export interface PageBreakBlock {
  type: 'pagebreak';
}

export type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | BulletsBlock
  | TableBlock
  | PageBreakBlock;

export interface SheetSpec {
  name: string;
  /** First row is rendered as the header. */
  rows: (string | number | boolean | null)[][];
}

export interface DocumentSpec {
  format: DocumentFormat;
  filename: string;
  title?: string;
  /** Body for `docx` and `pdf`. Ignored for `xlsx`. */
  blocks?: DocumentBlock[];
  /** Worksheets for `xlsx`. Ignored for `docx` and `pdf`. */
  sheets?: SheetSpec[];
}

export interface GeneratedDocument {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export const MIME_TYPES: Record<DocumentFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};
