import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { Tools } from 'librechat-data-provider';
import { generateDocument } from './generate';
import type { DocumentSpec } from './types';

/** Explicit annotations throughout: `packages/api` builds with --isolatedDeclarations,
 *  so anything reachable from an exported signature needs a written-out type. */
const blockSchema: z.ZodObject<
  {
    type: z.ZodEnum<['heading', 'paragraph', 'bullets', 'table', 'pagebreak']>;
    text: z.ZodOptional<z.ZodString>;
    level: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>>;
    items: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    rows: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodString, 'many'>, 'many'>>;
  },
  'strip'
> = z.object({
  type: z
    .enum(['heading', 'paragraph', 'bullets', 'table', 'pagebreak'])
    .describe('The kind of block to render.'),
  text: z.string().optional().describe('Text for a heading or paragraph block.'),
  level: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe('Heading depth: 1 is largest. Only for heading blocks.'),
  items: z.array(z.string()).optional().describe('Bullet points. Only for bullets blocks.'),
  rows: z
    .array(z.array(z.string()))
    .optional()
    .describe('Table rows; the first row is rendered as the header. Only for table blocks.'),
});

const sheetSchema: z.ZodObject<
  {
    name: z.ZodString;
    rows: z.ZodArray<
      z.ZodArray<z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>, 'many'>,
      'many'
    >;
  },
  'strip'
> = z.object({
  name: z.string().describe('Worksheet tab name.'),
  rows: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .describe('Rows of cells; the first row is bolded and frozen as the header.'),
});

const createDocumentSchema: z.ZodObject<
  {
    format: z.ZodEnum<['docx', 'xlsx', 'pdf']>;
    filename: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    blocks: z.ZodOptional<z.ZodUnion<[z.ZodArray<typeof blockSchema, 'many'>, z.ZodString]>>;
    sheets: z.ZodOptional<z.ZodUnion<[z.ZodArray<typeof sheetSchema, 'many'>, z.ZodString]>>;
  },
  'strip'
> = z.object({
  format: z
    .enum(['docx', 'xlsx', 'pdf'])
    .describe(
      'File format to produce: docx for Word, xlsx for Excel, pdf for a fixed-layout document.',
    ),
  filename: z
    .string()
    .describe(
      'Base file name without an extension, e.g. "Interview Plan". The extension is added automatically.',
    ),
  title: z
    .string()
    .optional()
    .describe('Optional document title rendered at the top. Not used for xlsx.'),
  /* Smaller local models routinely hand nested arguments over as a JSON string.
   * Accepting that here turns a rejected call plus retry loop into a silent parse;
   * the advertised JSON schema still asks for a real array. */
  blocks: z
    .union([z.array(blockSchema), z.string()])
    .optional()
    .describe(
      'Body content for docx and pdf, rendered in order. Omit for xlsx and use sheets instead.',
    ),
  sheets: z
    .union([z.array(sheetSchema), z.string()])
    .optional()
    .describe('Worksheets for xlsx. Omit for docx and pdf.'),
});

const DESCRIPTION = `Creates a downloadable Word (docx), Excel (xlsx), or PDF document and attaches it to the conversation for the user to preview and download.

Use this whenever the user asks for a document, report, spreadsheet, plan, letter, or table they can keep. Write the full content yourself rather than asking the user to fill it in afterwards.

- docx / pdf: build the body from "blocks" (heading, paragraph, bullets, table, pagebreak).
- xlsx: build "sheets", one entry per worksheet; the first row of each is the header.

The file is attached automatically, so do not paste the document's full text into your reply. Briefly say what you created and note anything the user should review.`;

/** Wraps generation in a tool whose artifact the tool-end callback persists as a
 *  real file attachment. The buffer rides as base64 because the artifact is streamed
 *  as JSON before anything touches storage. */
/** Undo the stringified-array habit before the spec reaches the generators. */
function parseMaybeJson<T>(value: T | string | undefined): T | undefined {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

export function createDocumentTool(): DynamicStructuredTool<typeof createDocumentSchema> {
  return tool(
    async (input: z.infer<typeof createDocumentSchema>) => {
      const spec = {
        ...input,
        blocks: parseMaybeJson(input.blocks),
        sheets: parseMaybeJson(input.sheets),
      } as DocumentSpec;
      const document = await generateDocument(spec);
      const kb = (document.buffer.length / 1024).toFixed(1);

      return [
        `Created ${document.filename} (${kb} KB). It is attached to this message for the user to preview or download.`,
        {
          [Tools.create_document]: {
            filename: document.filename,
            mimeType: document.mimeType,
            base64: document.buffer.toString('base64'),
            bytes: document.buffer.length,
          },
        },
      ];
    },
    {
      name: Tools.create_document,
      description: DESCRIPTION,
      responseFormat: 'content_and_artifact',
      schema: createDocumentSchema,
    },
  );
}
