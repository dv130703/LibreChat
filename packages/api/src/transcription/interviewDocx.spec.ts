import JSZip from 'jszip';
import { buildInterviewDocx } from './interviewDocx';
import type { ParsedTranscriptLine } from './corrections';
import type { InterviewTranscriptForm, NamedSpeaker } from 'librechat-data-provider';

const speakers: NamedSpeaker[] = [
  { id: 'speaker-1', name: 'Speaker 1' },
  { id: 'speaker-2', name: 'Speaker 2' },
];

const form: InterviewTranscriptForm = {
  caseName: 'Test Case',
  interviewType: 'Voluntary',
  location: 'Interview Room 1',
  date: '2026-01-01',
  commenced: '0900',
  completed: '1000',
  witnessIds: ['speaker-2'],
  roles: { 'speaker-1': 'Interviewer' },
  lastNames: { 'speaker-1': 'Smith', 'speaker-2': 'Jones' },
};

function line(speaker: string | undefined, text: string, lineIndex: number): ParsedTranscriptLine {
  return { lineIndex, speaker, text };
}

/** Every numbered paragraph in the transcript body: a `<w:p>` whose own
 *  properties carry a `<w:numPr>` (i.e. it actually claims a list number),
 *  independent of how much run/text content is inside it. Scoped to
 *  everything after the first `<w:sectPr>` - the cover sheet's own
 *  "present" list (a different numbered list entirely) lives in the first
 *  section, ahead of it, and must not be counted here. */
function numberedParagraphs(documentXml: string): string[] {
  const sectionBreak = documentXml.indexOf('<w:sectPr');
  const bodySectionXml = sectionBreak === -1 ? documentXml : documentXml.slice(sectionBreak);
  const paragraphs = bodySectionXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs.filter((p) => p.includes('<w:numPr>'));
}

describe('buildInterviewDocx numbering', () => {
  it('assigns one number per speaker turn, not one per transcript segment', async () => {
    const lines: ParsedTranscriptLine[] = [
      line('Speaker 1', 'Can you tell me your name?', 0),
      line('Speaker 2', 'Yes, my name is John.', 1),
      // Same speaker continuing across three more segments - must merge
      // into the same numbered turn as the line above, not claim three
      // numbers of its own.
      line('Speaker 2', 'I live at 123 Main Street.', 2),
      line('Speaker 2', 'I have lived there for five years.', 3),
      line('Speaker 2', 'Before that I lived in the city.', 4),
      line('Speaker 1', 'Thank you. What is your occupation?', 5),
    ];

    const buffer = await buildInterviewDocx({ form, speakers, lines });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toBeDefined();

    const numbered = numberedParagraphs(documentXml as string);
    // 3 speaker turns (Speaker 1, Speaker 2's merged 4-segment turn, Speaker 1
    // again) + the trailing "[End of interview]" item = 4 numbered items.
    expect(numbered).toHaveLength(4);

    // The merged turn carries every one of its segments' text, all inside
    // the single numbered paragraph.
    const mergedTurn = numbered[1];
    expect(mergedTurn).toContain('JONES');
    expect(mergedTurn).toContain('Yes, my name is John.');
    expect(mergedTurn).toContain('I live at 123 Main Street.');
    expect(mergedTurn).toContain('I have lived there for five years.');
    expect(mergedTurn).toContain('Before that I lived in the city.');

    expect(numbered[0]).toContain('SMITH');
    expect(numbered[2]).toContain('SMITH');
    expect(numbered[3]).toContain('[End of interview]');
  });

  it('gives every segment its own turn when speakers alternate every line', async () => {
    const lines: ParsedTranscriptLine[] = [
      line('Speaker 1', 'Question one?', 0),
      line('Speaker 2', 'Answer one.', 1),
      line('Speaker 1', 'Question two?', 2),
      line('Speaker 2', 'Answer two.', 3),
    ];

    const buffer = await buildInterviewDocx({ form, speakers, lines });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    const numbered = numberedParagraphs(documentXml as string);
    // 4 alternating turns + the trailing "[End of interview]" item.
    expect(numbered).toHaveLength(5);
  });

  it('does not start a new turn for an unattributed segment following a real speaker', async () => {
    const lines: ParsedTranscriptLine[] = [
      line('Speaker 1', 'Can you confirm that?', 0),
      line(undefined, 'inaudible mumbling', 1),
      line('Speaker 2', 'Yes, confirmed.', 2),
    ];

    const buffer = await buildInterviewDocx({ form, speakers, lines });
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    const numbered = numberedParagraphs(documentXml as string);
    // Speaker 1's turn (absorbing the unattributed line) + Speaker 2's turn
    // + the trailing "[End of interview]" item.
    expect(numbered).toHaveLength(3);
    expect(numbered[0]).toContain('inaudible mumbling');
  });
});
