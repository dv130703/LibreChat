import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';

/**
 * Adds a diagonal text watermark to a generated .docx buffer - the same
 * "PowerPlusWaterMarkObject" VML shape Word's own Design -> Watermark ->
 * Custom Watermark -> Text watermark dialog produces, applied to every
 * section's header so it repeats on every page of the whole document.
 *
 * `docx` (the npm package this app builds .docx files with) has no
 * watermark feature of its own, and nothing in its public object model
 * accepts arbitrary XML into a paragraph or header - `ImportedXmlComponent`
 * exists but is wired up only for imported styles, not header/body content.
 * So this works one level down: it splices the watermark directly into the
 * already-built .docx archive (a zip of OOXML parts) after `Packer.toBuffer`
 * has run, which is the only way to reach a feature the library itself
 * doesn't expose.
 */

/** Applied to every generated .docx export - see `interviewDocx.ts` and
 *  `meetingMinutesDocx.ts`. A single shared constant so the wording can't
 *  drift between the two export formats. */
export const AI_GENERATED_WATERMARK_TEXT = 'AI-GENERATED';

const HEADER_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const HEADER_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';

function escapeXmlAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The watermark header part's full XML. Namespace preamble matches what
 * `docx` itself already emits on every header/footer part it generates (VML
 * and Office namespaces included), so this fits the same document without
 * introducing anything the rest of the file doesn't already declare
 * elsewhere.
 *
 * Every structural value here - `coordsize`, `path`, the 14-entry `formulas`
 * list, and `w14:anchorId` on `w:pict` - is copied verbatim from a real
 * watermark Microsoft Word itself generated (Design -> Watermark -> Custom
 * Watermark), not reconstructed from memory. An earlier version of this
 * function had a plausible-looking but wrong `coordsize` (1600,21600 instead
 * of the real 21600,21600) and one extra bogus formula, which shifted every
 * subsequent `@N` formula reference by one and silently corrupted the whole
 * geometry chain `fitshape="t"` depends on. Word's own VML engine rendered
 * that corrupted geometry as a collapsed, barely-visible diagonal line with
 * no legible text; LibreOffice's more tolerant renderer produced legible
 * text from the same broken input, which is exactly what made this so hard
 * to catch without a byte-for-byte reference - both "renders in LibreOffice"
 * and "positions correctly in Word" were misleading signals that the
 * geometry was still wrong. Do not hand-edit the formulas/path/coordsize
 * without a fresh real sample to diff against.
 *
 * Shape parameters mirror Word's own defaults for a custom text watermark
 * left on "Auto" (no explicit size/color/transparency chosen): `rotation:315`
 * is Word's "Diagonal" layout, `fillcolor="silver"` with `v:fill opacity=".5"`
 * is Word's default semi-transparent grey, and `font-size:1pt` on the
 * `v:textpath` looks wrong in isolation but is exactly what Word itself
 * writes for an auto-sized watermark - the rendered size comes from the
 * shape's explicit `width`/`height` plus `fitshape="t"`, not that number.
 * `on="t" fitshape="t"` is repeated on the shape's own `v:textpath` (not just
 * the shapetype's) since the shape declares its own anyway to carry
 * `string`/`style`, matching the real sample.
 */
function buildWatermarkHeaderXml(
  text: string,
  fontFamily: string,
  uniqueSuffix: string,
  anchorId: string,
): string {
  const escapedText = escapeXmlAttribute(text);
  const escapedFont = escapeXmlAttribute(fontFamily);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:hdr xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
    'xmlns:v="urn:schemas-microsoft-com:vml" ' +
    'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:w10="urn:schemas-microsoft-com:office:word" ' +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
    'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
    'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" ' +
    'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" ' +
    'xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" ' +
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    `<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:noProof/></w:rPr><w:pict w14:anchorId="${anchorId}">` +
    '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" ' +
    'path="m@7,l@8,m@5,21600l@6,21600e">' +
    '<v:formulas>' +
    '<v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/>' +
    '<v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/>' +
    '<v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/>' +
    '<v:f eqn="if @0 @4 21600"/>' +
    '<v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/>' +
    '<v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/>' +
    '</v:formulas>' +
    '<v:path textpathok="t" o:connecttype="custom" ' +
    'o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>' +
    '<v:textpath on="t" fitshape="t"/>' +
    '<v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>' +
    '<o:lock v:ext="edit" text="t" shapetype="t"/>' +
    '</v:shapetype>' +
    `<v:shape id="PowerPlusWaterMarkObject${uniqueSuffix}" o:spid="_x0000_s2049" type="#_x0000_t136" ` +
    'style="position:absolute;margin-left:0;margin-top:0;width:532.8pt;height:106.55pt;' +
    'rotation:315;z-index:-251657216;mso-position-horizontal:center;' +
    'mso-position-horizontal-relative:margin;mso-position-vertical:center;' +
    'mso-position-vertical-relative:margin" o:allowincell="f" fillcolor="silver" stroked="f">' +
    '<v:fill opacity=".5"/>' +
    `<v:textpath on="t" fitshape="t" style="font-family:&quot;${escapedFont}&quot;;font-size:1pt" string="${escapedText}"/>` +
    '<w10:wrap anchorx="margin" anchory="margin"/>' +
    '</v:shape>' +
    '</w:pict></w:r></w:p></w:hdr>'
  );
}

export interface AddTextWatermarkOptions {
  /** Defaults to Times New Roman, matching Word's own default watermark font. */
  fontFamily?: string;
}

/**
 * Adds `text` as a diagonal watermark to every section of an already-built
 * .docx buffer. Applied unconditionally to the whole document - a document
 * with more than one section (e.g. `buildInterviewDocx`'s separate cover
 * sheet) gets the watermark on every one of them, not just the first.
 */
export async function addTextWatermark(
  docxBuffer: Buffer,
  text: string,
  options: AddTextWatermarkOptions = {},
): Promise<Buffer> {
  const fontFamily = options.fontFamily ?? 'Times New Roman';
  const zip = await JSZip.loadAsync(docxBuffer);

  const documentXmlFile = zip.file('word/document.xml');
  const relsFile = zip.file('word/_rels/document.xml.rels');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!documentXmlFile || !relsFile || !contentTypesFile) {
    throw new Error('Not a valid .docx archive - missing a required OOXML part');
  }

  const [documentXml, relsXml, contentTypesXml] = await Promise.all([
    documentXmlFile.async('string'),
    relsFile.async('string'),
    contentTypesFile.async('string'),
  ]);

  // Next free relationship id - this app only ever writes ids in the
  // "rIdN" shape `docx` itself generates, so the highest N + 1 is always
  // free, without needing to parse the whole relationships tree.
  const existingIds = Array.from(relsXml.matchAll(/Id="rId(\d+)"/g)).map((match) =>
    Number(match[1]),
  );
  const headerRelId = `rId${(existingIds.length > 0 ? Math.max(...existingIds) : 0) + 1}`;

  const updatedRelsXml = relsXml.replace(
    '</Relationships>',
    `<Relationship Id="${headerRelId}" Type="${HEADER_RELATIONSHIP_TYPE}" Target="header1.xml"/></Relationships>`,
  );

  const updatedContentTypesXml = contentTypesXml.replace(
    '</Types>',
    `<Override PartName="/word/header1.xml" ContentType="${HEADER_CONTENT_TYPE}"/></Types>`,
  );

  // Every section - a document can have more than one, e.g. the interview
  // export's separate cover-sheet section - gets the same watermark, per
  // "apply it to the whole document." w:headerReference must precede any
  // w:footerReference within a w:sectPr per the OOXML schema, so it's
  // inserted immediately after the opening tag rather than appended at the
  // end of it.
  const updatedDocumentXml = documentXml.replace(
    /<w:sectPr(\s[^>]*)?>/g,
    (match) => `${match}<w:headerReference w:type="default" r:id="${headerRelId}"/>`,
  );
  if (updatedDocumentXml === documentXml) {
    throw new Error('No <w:sectPr> found in word/document.xml - cannot attach a watermark header');
  }

  zip.file('word/document.xml', updatedDocumentXml);
  zip.file('word/_rels/document.xml.rels', updatedRelsXml);
  zip.file('[Content_Types].xml', updatedContentTypesXml);
  // Word's own watermark objects carry a 9-digit numeric id suffix and a
  // per-picture w14:anchorId (an 8-hex-digit revision-tracking id) - both
  // copied from a real Word-generated sample. Generated fresh per export
  // rather than hardcoded so multiple watermarked documents never collide if
  // their parts are ever merged.
  const uniqueSuffix = String(randomBytes(4).readUInt32BE(0)).padStart(9, '0').slice(-9);
  const anchorId = randomBytes(4).toString('hex').toUpperCase();

  zip.file('word/header1.xml', buildWatermarkHeaderXml(text, fontFamily, uniqueSuffix, anchorId));

  return zip.generateAsync({ type: 'nodebuffer' });
}
