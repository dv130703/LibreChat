export type SummaryStyle = 'concise' | 'bullets' | 'detailed'
export type SummaryLength = 'short' | 'long'

export interface SummaryResult {
  style: SummaryStyle
  length: SummaryLength
  markdown: string
}

export function summaryToPlainText(summary: SummaryResult): string {
  return summary.markdown.trim()
}

export function buildSummaryMarkdown(
  style: SummaryStyle,
  overview: string,
  keyPoints: string[],
  actionItems: string[],
): string {
  const sections: string[] = []

  if (style !== 'bullets' && overview) {
    sections.push(overview)
  }

  if (keyPoints.length > 0) {
    sections.push(['## Key points', ...keyPoints.map((point) => `- ${point}`)].join('\n'))
  }

  if (style === 'detailed' && actionItems.length > 0) {
    sections.push(['## Action items', ...actionItems.map((item) => `- ${item}`)].join('\n'))
  }

  return sections.join('\n\n')
}
