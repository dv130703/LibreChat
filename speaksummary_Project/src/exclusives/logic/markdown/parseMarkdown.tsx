import type { ReactNode } from 'react'

// Minimal markdown subset for summaries: headings, bold/italic, bullet/numbered
// lists, and paragraphs. Builds React elements directly (no dangerouslySetInnerHTML).

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*.+?\*\*|\*.+?\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let index = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-${index++}`}>{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={`${keyPrefix}-${index++}`}>{token.slice(1, -1)}</em>)
    }
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

export function parseMarkdown(markdown: string): ReactNode[] {
  if (!markdown) return []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []

  let listItems: string[] = []
  let listOrdered = false
  let blockIndex = 0

  function flushList() {
    if (listItems.length === 0) return
    const ListTag = listOrdered ? 'ol' : 'ul'
    blocks.push(
      <ListTag key={`block-${blockIndex++}`}>
        {listItems.map((item, i) => (
          <li key={i}>{parseInline(item, `li-${blockIndex}-${i}`)}</li>
        ))}
      </ListTag>,
    )
    listItems = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line)
    const bulletMatch = /^[-*]\s+(.*)$/.exec(line)
    const numberedMatch = /^\d+\.\s+(.*)$/.exec(line)

    if (headingMatch) {
      flushList()
      // The page's own h1 is the workspace header title above this content, so a
      // markdown `#` becomes h2 - the next level down, not a skip past it.
      const level = headingMatch[1].length
      const HeadingTag = (`h${Math.min(level + 1, 6)}`) as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(<HeadingTag key={`block-${blockIndex++}`}>{parseInline(headingMatch[2], `h-${blockIndex}`)}</HeadingTag>)
      continue
    }

    if (bulletMatch) {
      if (listItems.length > 0 && listOrdered) flushList()
      listOrdered = false
      listItems.push(bulletMatch[1])
      continue
    }

    if (numberedMatch) {
      if (listItems.length > 0 && !listOrdered) flushList()
      listOrdered = true
      listItems.push(numberedMatch[1])
      continue
    }

    flushList()

    if (line.length > 0) {
      blocks.push(<p key={`block-${blockIndex++}`}>{parseInline(line, `p-${blockIndex}`)}</p>)
    }
  }

  flushList()

  return blocks
}
