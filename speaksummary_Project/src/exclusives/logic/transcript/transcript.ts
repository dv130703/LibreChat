export interface TranscriptSegment {
  id: string
  start: number
  end: number
  speaker: string
  text: string
}

export function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function countWords(segments: TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.trim().split(/\s+/).filter(Boolean).length, 0)
}

export function countSpeakers(segments: TranscriptSegment[]): number {
  return new Set(segments.map((segment) => segment.speaker)).size
}

export function transcriptToPlainText(segments: TranscriptSegment[], title: string): string {
  const speakerCount = countSpeakers(segments)
  const wordCount = countWords(segments)
  const duration = segments.length > 0 ? formatTimestamp(segments[segments.length - 1].end) : '0:00'

  const header = [
    title,
    `${segments.length} line${segments.length === 1 ? '' : 's'} · ${speakerCount} speaker${speakerCount === 1 ? '' : 's'} · ${wordCount} words · ${duration} duration`,
    '─'.repeat(56),
  ].join('\n')

  const body = segments
    .map(
      (segment) =>
        `[${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)}] ${segment.speaker}\n${segment.text.trim()}`,
    )
    .join('\n\n')

  return `${header}\n\n${body}\n`
}
