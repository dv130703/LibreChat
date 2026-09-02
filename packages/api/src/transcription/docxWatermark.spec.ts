import JSZip from 'jszip';
import { Document, Footer, Packer, Paragraph, SectionType, TextRun } from 'docx';
import { addTextWatermark, AI_GENERATED_WATERMARK_TEXT } from './docxWatermark';

/** A real, minimal two-section .docx built with the actual `docx` package -
 *  not a fixture - so the watermark is spliced into exactly the kind of
 *  archive `interviewDocx.ts`/`meetingMinutesDocx.ts` actually produce,
 *  section count included (the interview export's own cover-sheet/body
 *  split is the reason this needs to handle more than one `w:sectPr`). */
async function buildSampleDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        properties: { type: SectionType.NEXT_PAGE },
        children: [new Paragraph({ children: [new TextRun('Cover sheet')] })],
      },
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [new Paragraph({ children: [new TextRun('Page footer')] })],
          }),
        },
        children: [new Paragraph({ children: [new TextRun('Body')] })],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

describe('addTextWatermark', () => {
  it('adds a diagonal, Times New Roman watermark to every section of a real .docx', async () => {
    const original = await buildSampleDocx();
    const watermarked = await addTextWatermark(original, AI_GENERATED_WATERMARK_TEXT);

    const zip = await JSZip.loadAsync(watermarked);

    const headerXml = await zip.file('word/header1.xml')?.async('string');
    expect(headerXml).toBeDefined();
    expect(headerXml).toContain(AI_GENERATED_WATERMARK_TEXT);
    expect(headerXml).toContain('rotation:315');
    expect(headerXml).toContain('Times New Roman');
    // Regression check: the shape's own textpath must repeat on/fitshape -
    // the shapetype's copy alone leaves the placeholder 1pt text unscaled,
    // so Word positions the shape but never renders visible text in it.
    expect(headerXml).toMatch(/<v:textpath on="t" fitshape="t"/);
    expect(headerXml).toContain('<w10:wrap anchorx="margin" anchory="margin"/>');
    // Regression check against a byte-for-byte real Word sample: an earlier
    // version had coordsize="1600,21600" and one extra bogus formula
    // ("prod @0 1 2") that shifted every subsequent @N reference, silently
    // corrupting the geometry fitshape depends on. Word's own VML engine
    // rendered that as a collapsed, illegible diagonal line - it positioned
    // the shape correctly but never drew visible text - while more tolerant
    // renderers papered over the same corruption, which is what made it look
    // fixed everywhere except real Word.
    expect(headerXml).toContain('coordsize="21600,21600"');
    expect(headerXml).not.toContain('coordsize="1600,21600"');
    expect(headerXml).not.toContain('prod @0 1 2');
    expect(headerXml).toMatch(/<v:formulas>(?:<v:f eqn="[^"]*"\/>){14}<\/v:formulas>/);
    // Word requires w14:anchorId on the w:pict itself (not the shapetype or
    // shape) to treat the floating object as fully valid.
    expect(headerXml).toMatch(/<w:pict w14:anchorId="[0-9A-F]{8}">/);
    // Word's own watermark objects always carry a numeric id suffix - used
    // by Word's "Remove Watermark" recognition logic.
    expect(headerXml).toMatch(/id="PowerPlusWaterMarkObject\d{9}"/);
    expect(headerXml).toMatch(/^<\?xml/);
    expect(headerXml?.trim().endsWith('</w:hdr>')).toBe(true);

    const contentTypesXml = await zip.file('[Content_Types].xml')?.async('string');
    expect(contentTypesXml).toContain('/word/header1.xml');
    expect(contentTypesXml).toContain('wordprocessingml.header+xml');

    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
    const relMatch = relsXml?.match(
      /<Relationship Id="(rId\d+)" Type="[^"]*relationships\/header" Target="header1\.xml"\/>/,
    );
    expect(relMatch).not.toBeNull();
    const headerRelId = relMatch?.[1] as string;

    const documentXml = await zip.file('word/document.xml')?.async('string');
    const sectPrs = documentXml?.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>/g) ?? [];
    // The sample document has two sections - both must carry the watermark,
    // not just the first, per "apply it to the whole document."
    expect(sectPrs).toHaveLength(2);
    for (const sectPr of sectPrs) {
      expect(sectPr).toContain(`<w:headerReference w:type="default" r:id="${headerRelId}"/>`);
    }
    // A section with an existing footerReference (the second one here) must
    // keep headerReference before it - the OOXML schema order for w:sectPr
    // children, not just "somewhere in the element."
    const secondSectPr = sectPrs[1];
    expect(secondSectPr.indexOf('<w:headerReference')).toBeLessThan(
      secondSectPr.indexOf('<w:footerReference'),
    );
  });

  it('produces a well-formed, unmodified-elsewhere archive', async () => {
    const original = await buildSampleDocx();
    const watermarked = await addTextWatermark(original, AI_GENERATED_WATERMARK_TEXT);

    const originalZip = await JSZip.loadAsync(original);
    const watermarkedZip = await JSZip.loadAsync(watermarked);

    // Every part the un-watermarked document had is still present and
    // byte-identical, except the three parts the watermark actually touches.
    const touchedParts = new Set([
      'word/document.xml',
      'word/_rels/document.xml.rels',
      '[Content_Types].xml',
    ]);
    for (const name of Object.keys(originalZip.files)) {
      if (originalZip.files[name].dir || touchedParts.has(name)) {
        continue;
      }
      const originalContent = await originalZip.file(name)?.async('string');
      const watermarkedContent = await watermarkedZip.file(name)?.async('string');
      expect(watermarkedContent).toBe(originalContent);
    }

    // And the one new part.
    expect(watermarkedZip.file('word/header1.xml')).not.toBeNull();
  });

  it('escapes XML-sensitive characters in the watermark text', async () => {
    const original = await buildSampleDocx();
    const watermarked = await addTextWatermark(original, 'Tom & Jerry <secret>');

    const zip = await JSZip.loadAsync(watermarked);
    const headerXml = await zip.file('word/header1.xml')?.async('string');
    expect(headerXml).toContain('Tom &amp; Jerry &lt;secret&gt;');
    expect(headerXml).not.toContain('<secret>');
  });

  it('honors a custom font family', async () => {
    const original = await buildSampleDocx();
    const watermarked = await addTextWatermark(original, 'DRAFT', { fontFamily: 'Arial' });

    const zip = await JSZip.loadAsync(watermarked);
    const headerXml = await zip.file('word/header1.xml')?.async('string');
    expect(headerXml).toContain('font-family:&quot;Arial&quot;');
    expect(headerXml).not.toContain('Times New Roman');
  });

  it('throws a clear error on something that is not a .docx archive', async () => {
    await expect(addTextWatermark(Buffer.from('not a zip'), 'DRAFT')).rejects.toThrow();
  });
});
