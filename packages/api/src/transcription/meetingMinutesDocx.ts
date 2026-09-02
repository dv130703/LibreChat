import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Footer,
  AlignmentType,
  BorderStyle,
  PageNumber,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from 'docx';
import { formatInterviewDate, joinNames } from 'librechat-data-provider';
import { addTextWatermark, AI_GENERATED_WATERMARK_TEXT } from './docxWatermark';
import type { MeetingMinutesForm, NamedSpeaker } from 'librechat-data-provider';
import type { ParsedTranscriptLine } from './corrections';

/**
 * A plain, human-readable record of who said what - the counterpart to
 * `interviewDocx.ts`'s formal legal transcript, not a reskin of it. No
 * witnesses, no case number, no numbered items, no dense tab-stop layout:
 * each turn reads as its own short paragraph, speaker name first in bold,
 * the way a magazine Q&A or a chat export reads, so a reader can scan down
 * the column of names to find who said what without reading every line.
 */

const FONT_HEADING = 'Cambria';
const FONT_BODY = 'Calibri';

const TITLE_SIZE = 56; // 28pt
const SUBTITLE_SIZE = 28; // 14pt
const SECTION_SIZE = 26; // 13pt
const BODY_SIZE = 22; // 11pt
const LABEL_SIZE = 18; // 9pt
const TIMESTAMP_SIZE = 18; // 9pt
const FOOTER_SIZE = 18; // 9pt

// A muted slate blue - present enough to anchor the eye on speaker names and
// headings, not saturated enough to look like a warning or a hyperlink.
const ACCENT_COLOR = '2C4A6E';
const MUTED_COLOR = '6B7280';
const SUBTITLE_COLOR = '404040';
const RULE_COLOR = 'D9D9D9';

function run(
  text: string,
  opts: { bold?: boolean; size?: number; color?: string; font?: string } = {},
): TextRun {
  return new TextRun({
    text,
    bold: opts.bold ?? false,
    size: opts.size ?? BODY_SIZE,
    color: opts.color,
    font: opts.font ?? FONT_BODY,
  });
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

/** `Date` / `Attendees` as a borderless two-column table, purely so both
 *  values line up on the same left edge regardless of label length - the
 *  same alignment trick a plain two-space-separated line can't guarantee
 *  once one label is longer than the other. */
function infoTable(form: MeetingMinutesForm, speakers: NamedSpeaker[]): Table {
  const attendeeLine = joinNames(speakers.map((speaker) => speaker.name));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: NO_BORDER,
      bottom: NO_BORDER,
      left: NO_BORDER,
      right: NO_BORDER,
      insideHorizontal: NO_BORDER,
      insideVertical: NO_BORDER,
    },
    rows: [
      infoRow('Date', formatInterviewDate(form.date)),
      infoRow('Attendees', attendeeLine || '—'),
    ],
  });
}

function infoRow(label: string, value: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 20, type: WidthType.PERCENTAGE },
        margins: { bottom: 80 },
        children: [
          new Paragraph({
            children: [
              run(label.toUpperCase(), { bold: true, size: LABEL_SIZE, color: MUTED_COLOR }),
            ],
          }),
        ],
      }),
      new TableCell({
        width: { size: 80, type: WidthType.PERCENTAGE },
        margins: { bottom: 80 },
        children: [new Paragraph({ children: [run(value, { bold: true })] })],
      }),
    ],
  });
}

/** A thin horizontal rule as an empty bordered paragraph - the same
 *  technique a plain `<hr>` reduces to, since `docx` has no dedicated rule
 *  element. */
function rule(): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_COLOR, space: 1 } },
    children: [],
  });
}

interface MergedTurn {
  speaker?: string;
  text: string;
  seconds?: number;
}

/** Consecutive lines from the same speaker read as one continuous turn in
 *  ordinary conversation - merging them here is what turns a line-per-ASR-
 *  segment transcript into paragraph-per-turn prose, which is the whole
 *  difference between "a transcript" and "minutes someone would actually
 *  read." The turn's timestamp is its first line's, not its last - "when did
 *  they start talking," which is what a reader jumping back to the audio
 *  actually wants. */
function mergeConsecutiveTurns(lines: ParsedTranscriptLine[]): MergedTurn[] {
  const turns: MergedTurn[] = [];
  for (const line of lines) {
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === line.speaker) {
      previous.text = `${previous.text} ${line.text}`.trim();
      continue;
    }
    turns.push({ speaker: line.speaker, text: line.text, seconds: line.seconds });
  }
  return turns;
}

/** `125` -> `2:05`; `4125` -> `1:08:45`. Minutes:seconds once under an hour,
 *  matching how a media player's own scrubber reads - not the `HH:MM:SS`
 *  legal-transcript convention, since these minutes are meant to be
 *  cross-referenced against a player, not a courtroom clock. */
function formatClockTime(seconds: number | undefined): string | null {
  if (seconds == null || Number.isNaN(seconds)) {
    return null;
  }
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedMinutes = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const paddedSecs = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${paddedMinutes}:${paddedSecs}` : `${paddedMinutes}:${paddedSecs}`;
}

/** One turn is two paragraphs, not one: a small bold name+timestamp line,
 *  `keepNext`-anchored so Word never strands it alone at the bottom of a
 *  page with its own text pushed onto the next one, followed by the turn's
 *  merged text at normal size. Reads like a script or a magazine Q&A -
 *  scannable by name, not by number. */
function turnParagraphs(turns: MergedTurn[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  turns.forEach((turn) => {
    const timeLabel = formatClockTime(turn.seconds);
    const headerChildren: TextRun[] = [
      run(turn.speaker ?? 'Unknown speaker', { bold: true, color: ACCENT_COLOR }),
    ];
    if (timeLabel != null) {
      headerChildren.push(run(`   ${timeLabel}`, { color: MUTED_COLOR, size: TIMESTAMP_SIZE }));
    }

    paragraphs.push(
      new Paragraph({
        keepNext: true,
        spacing: { before: 240, after: 40 },
        children: headerChildren,
      }),
    );
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: 40 },
        children: [run(turn.text)],
      }),
    );
  });

  return paragraphs;
}

export interface BuildMeetingMinutesDocxParams {
  form: MeetingMinutesForm;
  speakers: NamedSpeaker[];
  /** `applyTranscriptCorrectionsStructured`'s output - see `mergeConsecutiveTurns`. */
  lines: ParsedTranscriptLine[];
}

export async function buildMeetingMinutesDocx({
  form,
  speakers,
  lines,
}: BuildMeetingMinutesDocxParams): Promise<Buffer> {
  const turns = mergeConsecutiveTurns(lines);

  const doc = new Document({
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  run('Page ', { color: MUTED_COLOR, size: FOOTER_SIZE }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: FONT_BODY,
                    size: FOOTER_SIZE,
                    color: MUTED_COLOR,
                  }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            spacing: { after: 60 },
            children: [
              run('Meeting Minutes', {
                bold: true,
                size: TITLE_SIZE,
                color: ACCENT_COLOR,
                font: FONT_HEADING,
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 320 },
            children: [
              run(form.title, { size: SUBTITLE_SIZE, color: SUBTITLE_COLOR, font: FONT_HEADING }),
            ],
          }),
          infoTable(form, speakers),
          rule(),
          new Paragraph({
            spacing: { after: 200 },
            children: [
              run('Discussion', {
                bold: true,
                size: SECTION_SIZE,
                color: ACCENT_COLOR,
                font: FONT_HEADING,
              }),
            ],
          }),
          ...turnParagraphs(turns),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return addTextWatermark(buffer, AI_GENERATED_WATERMARK_TEXT);
}
