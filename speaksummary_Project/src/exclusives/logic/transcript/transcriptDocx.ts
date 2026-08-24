import type { TranscriptSegment } from './transcript'
import { countSpeakers, countWords, formatTimestamp } from './transcript'

// Same hues as the app's speaker-1..4 badge colors, so the exported doc matches.
const SPEAKER_COLORS = ['1A4FB4', 'B4451A', '1A8A3F', '7A1AB4']

export async function downloadTranscriptDocx(
  segments: TranscriptSegment[],
  title: string,
  fileName: string,
): Promise<void> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, BorderStyle } = await import('docx')

  const uniqueSpeakers = Array.from(new Set(segments.map((segment) => segment.speaker)))
  function speakerColor(speaker: string): string {
    const index = uniqueSpeakers.indexOf(speaker)
    return SPEAKER_COLORS[(index < 0 ? 0 : index) % SPEAKER_COLORS.length]
  }

  const speakerCount = countSpeakers(segments)
  const wordCount = countWords(segments)
  const duration = segments.length > 0 ? formatTimestamp(segments[segments.length - 1].end) : '0:00'

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: title, font: 'Calibri' })],
          }),
          new Paragraph({
            spacing: { after: 320 },
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 8 },
            },
            children: [
              new TextRun({
                text: `${segments.length} line${segments.length === 1 ? '' : 's'} · ${speakerCount} speaker${speakerCount === 1 ? '' : 's'} · ${wordCount} words · ${duration} duration`,
                italics: true,
                color: '888888',
                size: 20,
                font: 'Calibri',
              }),
            ],
          }),
          ...segments.flatMap((segment) => [
            new Paragraph({
              spacing: { before: 220, after: 40 },
              children: [
                new TextRun({
                  text: `${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)}   `,
                  color: '999999',
                  size: 18,
                  font: 'Calibri',
                }),
                new TextRun({
                  text: segment.speaker,
                  bold: true,
                  color: speakerColor(segment.speaker),
                  size: 20,
                  font: 'Calibri',
                }),
              ],
            }),
            new Paragraph({
              spacing: { after: 160 },
              children: [new TextRun({ text: segment.text.trim(), size: 22, font: 'Calibri' })],
            }),
          ]),
        ],
      },
    ],
  })

  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
