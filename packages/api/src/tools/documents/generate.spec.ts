import { generateDocument, resolveFilename } from './generate';
import type { DocumentSpec } from './types';

/** Real generators, real buffers — the point is that the bytes open as the format
 *  they claim to be, which mocking the libraries would prove nothing about. */

const blocks: DocumentSpec['blocks'] = [
  { type: 'heading', text: 'Interview Plan', level: 1 },
  { type: 'paragraph', text: 'Prepared for the north vault matter.' },
  { type: 'bullets', items: ['Confirm custody chain', 'Review affidavit'] },
  {
    type: 'table',
    rows: [
      ['Question', 'Topic', 'Owner'],
      ['When was it sealed?', 'History', 'A. Reed'],
      ['Ragged row'],
    ],
  },
  { type: 'pagebreak' },
  { type: 'paragraph', text: 'Second page.' },
];

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('generateDocument', () => {
  it('produces a valid docx (OOXML zip container)', async () => {
    const doc = await generateDocument({ format: 'docx', filename: 'plan', title: 'Plan', blocks });

    expect(doc.filename).toBe('plan.docx');
    expect(doc.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(doc.buffer.subarray(0, 4)).toEqual(ZIP_MAGIC);
  });

  it('produces a valid xlsx and tolerates mixed cell types', async () => {
    const doc = await generateDocument({
      format: 'xlsx',
      filename: 'plan',
      sheets: [
        {
          name: 'Questions',
          rows: [
            ['Question', 'Topic'],
            ['When sealed?', 'History'],
          ],
        },
        { name: 'Bad*Name:With/Chars', rows: [['text', 42, true, null]] },
      ],
    });

    expect(doc.filename).toBe('plan.xlsx');
    expect(doc.buffer.subarray(0, 4)).toEqual(ZIP_MAGIC);
  });

  it('produces a valid pdf', async () => {
    const doc = await generateDocument({ format: 'pdf', filename: 'plan', title: 'Plan', blocks });

    expect(doc.filename).toBe('plan.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects an unknown format', async () => {
    await expect(
      generateDocument({ format: 'exe' as DocumentSpec['format'], filename: 'x' }),
    ).rejects.toThrow(/Unsupported document format/);
  });

  it('generates an empty document rather than throwing on no content', async () => {
    const doc = await generateDocument({ format: 'docx', filename: 'empty' });
    expect(doc.buffer.length).toBeGreaterThan(0);
  });
});

describe('resolveFilename', () => {
  it('strips path separators so the name cannot escape its directory', () => {
    const resolved = resolveFilename('../../etc/passwd', 'pdf');
    expect(resolved).not.toContain('/');
    expect(resolved).not.toContain('\\');
    expect(resolved.endsWith('.pdf')).toBe(true);
  });

  it('forces the extension to match the real format', () => {
    expect(resolveFilename('report.pdf', 'xlsx')).toBe('report.xlsx');
    expect(resolveFilename('report.DOCX', 'docx')).toBe('report.docx');
  });

  it('falls back when the name sanitizes to nothing', () => {
    expect(resolveFilename('', 'docx')).toBe('document.docx');
    expect(resolveFilename('???', 'docx')).toBe('document.docx');
  });

  it('caps absurd lengths', () => {
    expect(resolveFilename('a'.repeat(500), 'pdf').length).toBeLessThanOrEqual(124);
  });
});
