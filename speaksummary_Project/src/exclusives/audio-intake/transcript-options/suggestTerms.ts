/**
 * Suggests terminology worth sending to the transcriber, from whatever the user
 * wrote in the context field.
 *
 * This is a suggestion, not an interpretation. Every term it produces is shown
 * to the user as a chip they can remove, and they can add ones it missed - so
 * what reaches the model is always a list somebody looked at. Nothing infers
 * meaning from punctuation or line layout, and there is no contract with the
 * backend to keep in step: the confirmed list is sent explicitly.
 *
 * Only high-confidence shapes are suggested - acronyms, and runs of adjacent
 * capitalised words. Lowercase multi-word jargon ("forensic accounting") cannot
 * be spotted this way without a dictionary, which is exactly what the manual
 * add is for.
 */

const ACRONYM = /\b[A-Z][A-Z0-9]{1,7}\b/g
const CAPITALISED_RUN = /\b[A-Z][a-z’'-]+(?:\s+[A-Z][a-z’'-]+)+/g
const MAX_TERM_CHARS = 60

/** Openers that begin a sentence far more often than they begin a name. */
const SENTENCE_OPENERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'we', 'they', 'he', 'she',
  'i', 'there', 'here', 'his', 'her', 'their', 'our', 'in', 'on', 'at', 'for', 'with',
  'and', 'but', 'or', 'if', 'when', 'while', 'during', 'after', 'before', 'subject',
  'interview', 'recording', 'meeting', 'conducted', 'regarding', 'about',
])

export function suggestTerms(context: string): string[] {
  if (!context.trim()) return []

  const found = new Map<string, string>()

  for (const match of context.matchAll(ACRONYM)) {
    const term = match[0]
    if (!found.has(term.toLowerCase())) found.set(term.toLowerCase(), term)
  }

  for (const match of context.matchAll(CAPITALISED_RUN)) {
    const term = match[0].replace(/\s+/g, ' ').trim()
    if (term.length > MAX_TERM_CHARS) continue
    if (SENTENCE_OPENERS.has(term.split(' ')[0].toLowerCase())) continue
    if (!found.has(term.toLowerCase())) found.set(term.toLowerCase(), term)
  }

  return [...found.values()]
}

/** Case-insensitive membership, so a chip removed as "POCA" stays removed if
 *  the user later types "poca". */
export function containsTerm(terms: string[], candidate: string): boolean {
  const needle = candidate.trim().toLowerCase()
  return terms.some((term) => term.trim().toLowerCase() === needle)
}
