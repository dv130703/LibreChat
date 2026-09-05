const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

function arr(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

async function loadDocxParagraphs(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xmlStr = await zip.file('word/document.xml').async('string');
  const doc = parser.parse(xmlStr);
  const body = doc?.['w:document']?.['w:body'];
  const topLevel = arr(body?.['w:p']);
  // Also walk into any w:tbl so table-cell paragraphs aren't silently dropped,
  // but keep them out of the plain "paragraphs" list used for heading checks.
  const paragraphs = topLevel.map(paragraphFromNode);
  const tables = arr(body?.['w:tbl']);
  return { paragraphs, tables, rawBody: body };
}

function paragraphFromNode(p) {
  const pStyle = p?.['w:pPr']?.['w:pStyle']?.['@_w:val'] || null;
  const runs = arr(p?.['w:r']);
  const text = runs
    .map((r) => {
      const t = r?.['w:t'];
      if (t === undefined) return '';
      return typeof t === 'string' ? t : t?.['#text'] ?? '';
    })
    .join('');
  const allBold = runs.length > 0 && runs.every((r) => r?.['w:rPr']?.['w:b'] !== undefined);
  const sizes = runs
    .map((r) => r?.['w:rPr']?.['w:sz']?.['@_w:val'])
    .filter((v) => v !== undefined)
    .map(Number);
  const maxSizeHalfPt = sizes.length ? Math.max(...sizes) : null;
  return { text, pStyle, allBold, maxSizeHalfPt };
}

function checkMarkdownLeak(paragraphs) {
  const violations = [];
  const bulletRe = /^\s*([-*+•]\s|\d+[.)]\s|#{1,6}\s|>\s)/;
  const inlineRe = /\*\*.+?\*\*|__.+?__|`.+?`/;
  for (const p of paragraphs) {
    if (bulletRe.test(p.text) || inlineRe.test(p.text)) {
      violations.push({ text: p.text.slice(0, 80) });
    }
  }
  return { pass: violations.length === 0, violations };
}

function checkPlaceholderResidue(paragraphs) {
  const re = /\bTODO\b|\{\{|\bLorem\b|\bXXX\b|\[insert/i;
  const violations = paragraphs.filter((p) => re.test(p.text)).map((p) => p.text.slice(0, 80));
  return { pass: violations.length === 0, violations };
}

/** Flags a paragraph that visually reads as a heading (short, bold, larger
 * font) but carries no Heading pStyle — i.e. direct formatting standing in
 * for a style. */
function checkHeadingStyle(paragraphs) {
  const violations = [];
  for (const p of paragraphs) {
    if (!p.text.trim()) continue;
    const looksLikeHeading = p.text.length < 60 && p.allBold && (p.maxSizeHalfPt === null || p.maxSizeHalfPt >= 24);
    const hasHeadingStyle = p.pStyle && /^Heading/i.test(p.pStyle);
    if (looksLikeHeading && !hasHeadingStyle) {
      violations.push({ text: p.text, pStyle: p.pStyle });
    }
  }
  return { pass: violations.length === 0, violations };
}

function checkHeadingHierarchy(paragraphs) {
  const levels = paragraphs
    .map((p) => (p.pStyle && /^Heading(\d)/i.exec(p.pStyle)) || null)
    .map((m) => (m ? Number(m[1]) : null))
    .filter((l) => l !== null);
  const violations = [];
  let stackDepth = 0;
  for (const level of levels) {
    if (level > stackDepth + 1) {
      violations.push({ level, expectedMax: stackDepth + 1 });
    }
    stackDepth = level;
  }
  return { pass: violations.length === 0, violations, levelsSeen: levels };
}

function checkTableShape(tables, expectedMinCols = 2, expectedMinRows = 2) {
  if (tables.length === 0) return { pass: false, violations: ['no table found'] };
  const t = tables[0];
  const rows = arr(t['w:tr']);
  const firstRowCells = arr(rows[0]?.['w:tc']);
  const colCount = firstRowCells.length;
  const rowCount = rows.length;
  const headerBold = firstRowCells.every((tc) => {
    const p = paragraphFromNode(arr(tc['w:p'])[0] || {});
    return p.allBold;
  });
  const violations = [];
  if (colCount < expectedMinCols) violations.push(`only ${colCount} columns`);
  if (rowCount < expectedMinRows) violations.push(`only ${rowCount} rows (incl. header)`);
  if (!headerBold) violations.push('header row not visually distinct (not bold)');
  return { pass: violations.length === 0, violations, colCount, rowCount, headerBold };
}

function findSectionText(paragraphs, headingText) {
  const idx = paragraphs.findIndex((p) => p.text.trim() === headingText);
  if (idx === -1) return null;
  const headingStyle = paragraphs[idx].pStyle;
  const bodyParas = [];
  for (let i = idx + 1; i < paragraphs.length; i += 1) {
    if (paragraphs[i].pStyle && /^Heading/i.test(paragraphs[i].pStyle)) break;
    bodyParas.push(paragraphs[i].text);
  }
  return { headingStyle, text: bodyParas.join('\n').trim() };
}

function checkTimelineUnchanged(paragraphs, expectedTimelineText) {
  const section = findSectionText(paragraphs, 'Timeline');
  if (!section) return { pass: false, violations: ['Timeline section not found'] };
  const pass = section.text === expectedTimelineText && /^Heading/i.test(section.headingStyle || '');
  return {
    pass,
    violations: pass ? [] : [`Timeline section changed or restyled: "${section.text}" (style: ${section.headingStyle})`],
  };
}

module.exports = {
  loadDocxParagraphs,
  checkMarkdownLeak,
  checkPlaceholderResidue,
  checkHeadingStyle,
  checkHeadingHierarchy,
  checkTableShape,
  checkTimelineUnchanged,
  findSectionText,
};
