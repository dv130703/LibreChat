import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Tab,
  Footer,
  AlignmentType,
  BorderStyle,
  SectionType,
  LevelFormat,
  LevelSuffix,
  TabStopType,
  VerticalAlign,
  FrameAnchorType,
  VerticalPositionAlign,
  HorizontalPositionAlign,
  HeightRule,
  PageNumber,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from 'docx';
import { formatInterviewDate, joinNames } from 'librechat-data-provider';
import { addTextWatermark, AI_GENERATED_WATERMARK_TEXT } from './docxWatermark';
import type { InterviewTranscriptForm, NamedSpeaker } from 'librechat-data-provider';
import type { ParsedTranscriptLine } from './corrections';

/**
 * The formal SFO-style interview cover sheet, as an actual Word document -
 * matched field-for-field, font-for-font against the reference template
 * (Calibri throughout; see the size/weight/alignment table on each element
 * below) rather than approximated in plain text.
 *
 * Two sections: the cover sheet carries no footer at all, and the transcript
 * body's `default` footer names the witness(es) on every page after it -
 * "the footer is a witness(es) for anywhere except cover page."
 *
 * `joinNames` and the form/speaker types come from `librechat-data-provider` -
 * the same module the client's pre-export form uses, so nothing here can
 * describe the witnesses differently than what the user confirmed on screen.
 */

const FONT = 'Calibri';
const TITLE_SIZE = 40; // 20pt
const INVESTIGATION_SIZE = 28; // 14pt
const BODY_SIZE = 22; // 11pt
const NOTICE_SIZE = 18; // 9pt
const FOOTER_SIZE = 18; // 9pt

const PRESENT_LIST_REF = 'present-list';
const BODY_LIST_REF = 'transcript-lines';
// A4 (11906 twips) minus the library's default 1" margins on each side -
// matches the width every other cover-page paragraph already wraps to.
const CONTENT_WIDTH = 11906 - 1440 * 2;

/**
 * Anchors the notice to the bottom of the page's own margin box as ordinary
 * body text - not a Word footer. A footer is a distinct, repeating region
 * outside the normal content flow (double-click to edit, locked to repeat
 * per page); this is a `w:framePr` floating frame, the OOXML mechanism for
 * "real paragraph content, positioned independent of the paragraphs above
 * it." Applied identically to every paragraph in the block so Word reads
 * them as one continuous frame rather than several overlapping ones.
 */
const NOTICE_FRAME = {
  type: 'alignment' as const,
  anchor: { horizontal: FrameAnchorType.MARGIN, vertical: FrameAnchorType.MARGIN },
  alignment: { x: HorizontalPositionAlign.LEFT, y: VerticalPositionAlign.BOTTOM },
  width: CONTENT_WIDTH,
  height: 1600,
  rule: HeightRule.AUTO,
};

function run(text: string, opts: { bold?: boolean; size?: number } = {}): TextRun {
  return new TextRun({ text, bold: opts.bold ?? false, size: opts.size ?? BODY_SIZE, font: FONT });
}

function centered(text: string, opts: { bold?: boolean; size?: number } = {}): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [run(text, opts)],
  });
}

function caseNameBox(caseName: string): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
      left: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
      right: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            margins: { top: 120, bottom: 120, left: 120, right: 120 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  run('INVESTIGATION:  ', { bold: true, size: INVESTIGATION_SIZE }),
                  run(caseName, { bold: true, size: INVESTIGATION_SIZE }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

/**
 * "Present:" and the numbered list of attendees sit on the same row, label
 * at the page's left margin and the list starting further right - a real
 * Word numbered list always opens its own paragraph, so a borderless
 * two-cell table is what actually reproduces that layout: left cell holds
 * the bold "Present:" label, right cell holds the auto-numbered items.
 *
 * Each item is the person's full name in bold, then their descriptor
 * ("(Witness)", ", Role") in normal weight as a second, separate run - and
 * a genuine blank paragraph (not just extra `spacing`) sits between every
 * pair of items, the same way pressing Enter twice in Word leaves an empty
 * line. A bare paragraph carries no `numbering`, so it never consumes a
 * list number - items still count 1, 2, 3, 4 with the gaps between them.
 */
function presentTable(form: InterviewTranscriptForm, speakers: NamedSpeaker[]): Table {
  const present = buildPresentEntries(speakers, form.witnessIds, form.roles);
  const items: Paragraph[] = [];
  present.forEach((entry, index) => {
    items.push(
      new Paragraph({
        numbering: { reference: PRESENT_LIST_REF, level: 0 },
        children: [run(entry.name, { bold: true }), run(entry.descriptor)],
      }),
    );
    if (index < present.length - 1) {
      items.push(new Paragraph({ children: [] }));
    }
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 18, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlign.TOP,
            children: [new Paragraph({ children: [run('Present:', { bold: true })] })],
          }),
          new TableCell({
            width: { size: 82, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlign.TOP,
            children: items,
          }),
        ],
      }),
    ],
  });
}

interface PresentEntry {
  name: string;
  /** " (Witness)", " (Witness 2)", or ", Role" - printed after the bold name
   *  in normal weight, so only the name itself is bold. */
  descriptor: string;
}

/** "Speaker n (Witness)" for the first witness, "Speaker n + 1 (Witness 2)"
 *  for the next, then "Speaker x, Role" for everyone else - the template's
 *  own wording exactly, not just its structure. */
function buildPresentEntries(
  speakers: NamedSpeaker[],
  witnessIds: string[],
  roles: Record<string, string>,
): PresentEntry[] {
  const witnesses: PresentEntry[] = witnessIds.map((id, index) => {
    const name = speakers.find((speaker) => speaker.id === id)?.name ?? id;
    return { name, descriptor: index === 0 ? ' (Witness)' : ` (Witness ${index + 1})` };
  });
  const others: PresentEntry[] = speakers
    .filter((speaker) => !witnessIds.includes(speaker.id))
    .map((speaker) => ({ name: speaker.name, descriptor: `, ${roles[speaker.id] ?? ''}` }));
  return [...witnesses, ...others];
}

const NOTICE_TEXT =
  'This draft transcript of interview has been AI-generated.  It has not been ' +
  'checked or verified against the soundtrack of the tape and may not be an accurate verbatim ' +
  'record.  It has been prepared to outline the areas covered in the interview and to facilitate ' +
  'the location of specific passages and topics on the tape which remains the original and true ' +
  'record.';

/**
 * One numbered list item per speaker turn (a run of consecutive segments
 * from the same speaker), never per raw transcript segment - segments
 * belonging to the same turn are merged into a single flowing paragraph
 * instead of each claiming its own number. The speaker is labelled in
 * plain-weight uppercase (surname only where the caller supplied one - see
 * `lastNameByDisplayName`) once, at the start of their turn. Never a
 * timestamp - the reference has none.
 *
 * Real Word list numbers, not typed digits: stable regardless of how the
 * document is later edited or reflowed, and exactly what "(numbered list,
 * Calibri, 11, normal, justify)" asks for.
 */
// Where the number's own trailing tab lands for a plain continuation line
// (no speaker label) - list-level default, used by every body paragraph
// that doesn't override it below.
//
// Must clear the number's own rendered width, not just look wide enough -
// Calibri's tabular digit width is ~0.556em, so at 11pt (220 twips/em) each
// digit is ~122 twips: a 3-digit turn number ("108") is already ~367 twips
// wide. A stop position narrower than that isn't just tight, it's *already
// behind* the cursor by the time a 3-digit number finishes rendering - Word
// can't tab backward, so it silently skips this stop and jumps straight to
// the next one instead (DIALOGUE_COLUMN), which is what actually produced
// the reported "108CHERYL" glue: not a rounding error, a stop the number had
// already outgrown. Sized here for up to 4 digits (9999 turns) with real
// headroom, not just enough for whatever happened to be tested.
const NUMBER_COLUMN = 720; // 0.5"
// Where dialogue text starts on a line that opens with a bold speaker
// label, and - critically - where WRAPPED lines of that same paragraph
// hang-indent to, so a continuation line lines up with the dialogue itself
// rather than the paragraph's number. Sized to clear a two-word surname in
// bold 11pt Calibri (e.g. "DAVID NGUYEN") before the tab past it fires.
// 2880 (2"), not the previous 2160 - measured directly against a real
// Word-generated reference template (pixel offsets in a rendered PDF): 2160
// left noticeably less gap between the speaker label and their dialogue than
// the reference actually has.
const DIALOGUE_COLUMN = 2880; // 2"

/** A bare paragraph (no `numbering`) between turns - the same technique
 *  `presentTable` uses, and for the same reason: a genuine blank line, not
 *  just extra `spacing`, and one that never consumes a list number since it
 *  carries no `numPr`. */
function blankLine(): Paragraph {
  return new Paragraph({ children: [] });
}

interface SpeakerTurn {
  /** null only for a leading turn whose first segment carries no speaker
   *  attribution - every turn that actually changes speaker gets a label. */
  label: string | null;
  /** This turn's segments, in order - joined into one flowing paragraph
   *  when rendered rather than kept as separate numbered items. */
  texts: string[];
}

/** Groups consecutive same-speaker segments into turns. A new turn starts
 *  only when a segment's speaker is known and differs from the previous
 *  segment's - an unattributed segment (no speaker) always continues
 *  whatever turn is already open, never starting one of its own. */
function groupIntoTurns(
  lines: ParsedTranscriptLine[],
  lastNameByDisplayName: Map<string, string>,
): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];

  lines.forEach((line, index) => {
    const previousSpeaker = index > 0 ? lines[index - 1].speaker : undefined;
    // Grouping stays keyed on the full display name, never the surname
    // substituted into the label below - two different speakers can share a
    // surname, and comparing by it would wrongly merge their turns.
    const isNewSpeaker = line.speaker != null && line.speaker !== previousSpeaker;

    if (isNewSpeaker || turns.length === 0) {
      const label = isNewSpeaker
        ? (lastNameByDisplayName.get(line.speaker!)?.trim() || line.speaker!).toUpperCase()
        : null;
      turns.push({ label, texts: [line.text] });
      return;
    }

    turns[turns.length - 1].texts.push(line.text);
  });

  return turns;
}

function bodyItems(
  lines: ParsedTranscriptLine[],
  lastNameByDisplayName: Map<string, string>,
): Paragraph[] {
  const items: Paragraph[] = [];
  const turns = groupIntoTurns(lines, lastNameByDisplayName);

  turns.forEach((turn, index) => {
    const text = turn.texts.join(' ');

    if (turn.label == null) {
      // Leading turn with no speaker attribution - no blank line before it,
      // no label to skip past either: dialogue starts right after "N.	" at
      // NUMBER_COLUMN (the list level's own default), and wraps hang there
      // too.
      items.push(
        new Paragraph({
          numbering: { reference: BODY_LIST_REF, level: 0 },
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 120 },
          children: [run(text)],
        }),
      );
      return;
    }

    // A new turn starting - a blank line ahead of it (except the very first
    // turn in the transcript, which has nothing above it to separate from).
    if (index > 0) {
      items.push(blankLine());
    }

    // Two tab stops on this paragraph: the number's own suffix-tab lands at
    // the nearer one (NUMBER_COLUMN, where the bold label starts), and the
    // manual `Tab()` right after the label jumps to the farther one
    // (DIALOGUE_COLUMN) - a real tab-width gap, not typed spaces. The
    // paragraph's own `indent` is set to DIALOGUE_COLUMN so wrapped lines of
    // this same paragraph hang to exactly where the dialogue text starts,
    // not where the label did.
    items.push(
      new Paragraph({
        numbering: { reference: BODY_LIST_REF, level: 0 },
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: 120 },
        indent: { left: DIALOGUE_COLUMN, hanging: DIALOGUE_COLUMN },
        tabStops: [
          { type: TabStopType.LEFT, position: NUMBER_COLUMN },
          { type: TabStopType.LEFT, position: DIALOGUE_COLUMN },
        ],
        // `Tab` must be wrapped inside a `TextRun`'s own `children`, not
        // placed bare as a `Paragraph` child - an unwrapped `<w:tab/>` isn't
        // valid run content, and while some lenient readers (mammoth) still
        // interpret it, real Word does not: it rendered with no gap at all.
        children: [
          run(turn.label),
          new TextRun({ children: [new Tab()], font: FONT, size: BODY_SIZE }),
          run(text),
        ],
      }),
    );
  });

  items.push(
    blankLine(),
    new Paragraph({
      numbering: { reference: BODY_LIST_REF, level: 0 },
      alignment: AlignmentType.JUSTIFIED,
      children: [run('[End of interview]')],
    }),
  );
  return items;
}

/**
 * `left` is where the TEXT (and wrapped lines) sit; the number itself starts
 * at `left - hanging`, so passing the same value for both - as this used to
 * always do - forces the number to start at 0, flush against the page
 * margin, no matter how far the text is indented. Called with two different
 * values here so the number moves off the margin too, not just the text
 * after it.
 */
function orderedListLevel(left: number, hanging: number = left, text: string = '%1.') {
  return {
    level: 0,
    format: LevelFormat.DECIMAL,
    text,
    suffix: LevelSuffix.TAB,
    alignment: AlignmentType.LEFT,
    style: {
      // Word's own generated number glyph (the "1." itself) is NOT one of
      // this file's own TextRuns and so never picks up Calibri from `run()` -
      // its font comes only from here, the level's own run style. Left
      // unset, it renders in the document's default font instead.
      run: { font: FONT, size: BODY_SIZE },
      paragraph: {
        indent: { left, hanging },
      },
    },
  };
}

export interface BuildInterviewDocxParams {
  form: InterviewTranscriptForm;
  speakers: NamedSpeaker[];
  /** `applyTranscriptCorrectionsStructured`'s output - see `bodyItems`. */
  lines: ParsedTranscriptLine[];
}

export async function buildInterviewDocx({
  form,
  speakers,
  lines,
}: BuildInterviewDocxParams): Promise<Buffer> {
  const witnessNames = form.witnessIds
    .map((id) => speakers.find((speaker) => speaker.id === id)?.name)
    .filter((name): name is string => name != null);
  const witnessLine = joinNames(witnessNames);
  // Keyed by display name, not speaker id: every line the corrected
  // transcript carries already identifies its speaker by that name (see
  // `applySpeakerNames`), never by id.
  const lastNameByDisplayName = new Map(
    speakers
      .map((speaker): [string, string] => [speaker.name, form.lastNames[speaker.id] ?? ''])
      .filter(([, lastName]) => lastName.trim() !== ''),
  );

  const doc = new Document({
    numbering: {
      config: [
        // Reverted from 2700/2340 (two prior 780-twip rightward shifts) back
        // to 1140/780 - measured directly against a real Word-generated
        // reference template (pixel-for-pixel via a rendered PDF), the
        // shifted value put the list at roughly double the reference's
        // actual indent. Keeps the same 360-twip gap between number and text.
        { reference: PRESENT_LIST_REF, levels: [orderedListLevel(1140, 360)] },
        // DIALOGUE_COLUMN, not NUMBER_COLUMN: every dialogue paragraph -
        // labeled or the rare leading turn with no speaker attribution - must
        // start its text at the same x-position. An unlabeled paragraph has
        // no custom tabStops of its own, so its number's auto-tab lands
        // straight on this level default (the only stop available); a
        // labeled paragraph overrides its own `indent` but still ends at
        // this same value - see `bodyItems`.
        {
          reference: BODY_LIST_REF,
          levels: [orderedListLevel(DIALOGUE_COLUMN, DIALOGUE_COLUMN, '%1')],
        },
      ],
    },
    sections: [
      {
        properties: {},
        children: [
          centered('TRANSCRIPT OF INTERVIEW *', { bold: true, size: TITLE_SIZE }),
          centered(witnessLine.toUpperCase(), { bold: true }),
          centered(form.interviewType),
          new Paragraph({ children: [] }),
          new Paragraph({ children: [] }),
          caseNameBox(form.caseName),
          new Paragraph({ spacing: { before: 200, after: 200 }, children: [] }),
          centered(`${formatInterviewDate(form.date)} at ${form.location}`, { bold: true }),
          centered(`Time Commenced:   ${form.commenced} Hours`),
          centered(`Time Completed:     ${form.completed} Hours`),
          new Paragraph({ spacing: { after: 300 }, children: [] }),
          presentTable(form, speakers),
          // Real body paragraphs, anchored to the bottom of the page's margin
          // box via `frame` - not a Word footer (see `NOTICE_FRAME`). Both
          // paragraphs carry the identical frame config so Word treats them
          // as one continuous frame rather than two overlapping ones.
          new Paragraph({
            frame: NOTICE_FRAME,
            alignment: AlignmentType.CENTER,
            children: [run('*  UNVERIFIED TRANSCRIPT OF RECORDED INTERVIEW', { bold: true })],
          }),
          new Paragraph({
            frame: NOTICE_FRAME,
            alignment: AlignmentType.JUSTIFIED,
            children: [run(NOTICE_TEXT, { size: NOTICE_SIZE })],
          }),
        ],
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          // Page numbering restarts here: this is the first page OF THE
          // TRANSCRIPT, and the cover page ahead of it shouldn't count toward it.
          page: { pageNumbers: { start: 1 } },
        },
        footers: {
          // "[WITNESS NAME(S) N]" - one bracket scope around the name and the
          // bare page number, no "Page" label. The name is bold and
          // uppercased, matching how a speaker is labelled in the transcript
          // body itself. The number is a live Word field (PageNumber.CURRENT)
          // restarting at 1 for this section (see `page.pageNumbers.start`
          // above) - not a number this code precomputed and could get wrong
          // the moment someone edits the document afterward.
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  run(`[${witnessLine.toUpperCase()}`, { bold: true, size: FOOTER_SIZE }),
                  run('  ', { size: FOOTER_SIZE }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: FONT,
                    size: FOOTER_SIZE,
                  }),
                  run(']', { size: FOOTER_SIZE }),
                ],
              }),
            ],
          }),
        },
        children: bodyItems(lines, lastNameByDisplayName),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return addTextWatermark(buffer, AI_GENERATED_WATERMARK_TEXT);
}
