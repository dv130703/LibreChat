import { buildDocx } from './docx';
import { buildXlsx } from './xlsx';
import { buildPdf } from './pdf';
import { MIME_TYPES } from './types';
import type { DocumentSpec, GeneratedDocument, DocumentFormat } from './types';

const BUILDERS: Record<DocumentFormat, (spec: DocumentSpec) => Promise<Buffer>> = {
  docx: buildDocx,
  xlsx: buildXlsx,
  pdf: buildPdf,
};

/** Strip path separators and characters the filesystem or Content-Disposition would
 *  choke on, then force the extension to match the real format so the model cannot
 *  hand the client a name that escapes its directory or misstates the file type. */
export function resolveFilename(name: string, format: DocumentFormat): string {
  const base = (name || 'document')
    .replace(/[/\\]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/\.(docx|xlsx|pdf)$/i, '')
    .trim()
    .slice(0, 120);

  return `${base || 'document'}.${format}`;
}

export async function generateDocument(spec: DocumentSpec): Promise<GeneratedDocument> {
  const build = BUILDERS[spec.format];
  if (!build) {
    throw new Error(`Unsupported document format: ${spec.format}`);
  }

  const buffer = await build(spec);
  return {
    buffer,
    filename: resolveFilename(spec.filename, spec.format),
    mimeType: MIME_TYPES[spec.format],
  };
}
