import { Tools } from 'librechat-data-provider';
import { createDocumentTool } from './tool';

/** Real tool, real generation — the point is what survives the schema, which a
 *  mocked generator would not exercise. */

function call(args: Record<string, unknown>) {
  return createDocumentTool().invoke({
    name: 'create_document',
    args,
    id: 'call_test',
    type: 'tool_call',
  });
}

function artifactOf(message: { artifact?: Record<string, { base64: string; filename: string }> }) {
  return message.artifact?.[Tools.create_document];
}

describe('createDocumentTool', () => {
  it('accepts sheets as a proper array', async () => {
    const msg = await call({
      format: 'xlsx',
      filename: 'Mock Data',
      sheets: [
        {
          name: 'Sales',
          rows: [
            ['Region', 'Revenue'],
            ['North', 1000],
          ],
        },
      ],
    });

    const doc = artifactOf(msg);
    expect(doc?.filename).toBe('Mock Data.xlsx');
    expect(Buffer.from(doc!.base64, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
  });

  /** Local models frequently stringify nested arguments; rejecting that cost a
   *  retry loop before the schema accepted both shapes. */
  it('accepts sheets as a JSON-encoded string', async () => {
    const msg = await call({
      format: 'xlsx',
      filename: 'Mock Data',
      sheets: JSON.stringify([
        {
          name: 'Sales',
          rows: [
            ['Region', 'Revenue'],
            ['North', 1000],
          ],
        },
      ]),
    });

    const doc = artifactOf(msg);
    expect(doc?.filename).toBe('Mock Data.xlsx');
    expect(Buffer.from(doc!.base64, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
  });

  it('accepts blocks as a JSON-encoded string', async () => {
    const msg = await call({
      format: 'docx',
      filename: 'Report',
      title: 'Report',
      blocks: JSON.stringify([{ type: 'paragraph', text: 'Hello.' }]),
    });

    expect(artifactOf(msg)?.filename).toBe('Report.docx');
  });

  it('still produces a file when a stringified value is unparseable', async () => {
    const msg = await call({ format: 'pdf', filename: 'Empty', blocks: 'not json at all' });

    const doc = artifactOf(msg);
    expect(doc?.filename).toBe('Empty.pdf');
    expect(Buffer.from(doc!.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  });
});
