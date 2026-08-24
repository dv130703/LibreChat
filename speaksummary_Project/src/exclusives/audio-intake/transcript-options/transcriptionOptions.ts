import { containsTerm, suggestTerms } from './suggestTerms'

/**
 * How the transcript should be produced. Set on the audio step, alongside the
 * output format - the two are the same kind of decision, made about the file
 * before anything has been generated from it - and read back on the transcript
 * step, which runs the job and shows the result.
 */
export interface TranscriptionOptions {
  includeTimestamps: boolean
  diarize: boolean
  /** Blank means "auto"; kept as strings so an empty field stays empty. */
  minSpeakers: string
  maxSpeakers: string
  /**
   * One free-text note: what the recording is about, plus any names,
   * organisations or terminology that may be hard to transcribe. Goes to the
   * summariser whole - it follows instructions, so prose is useful there.
   */
  context: string
  /**
   * Terms the user added by hand, for terminology the suggester can't spot -
   * lowercase jargon like "forensic accounting" needs a dictionary to find.
   */
  addedTerms: string[]
  /**
   * Suggested terms the user removed. Kept so a dismissal sticks while they
   * carry on typing, instead of the chip reappearing on the next keystroke.
   */
  dismissedTerms: string[]
}

export const DEFAULT_TRANSCRIPTION_OPTIONS: TranscriptionOptions = {
  includeTimestamps: true,
  diarize: true,
  minSpeakers: '',
  maxSpeakers: '',
  context: '',
  addedTerms: [],
  dismissedTerms: [],
}

/**
 * The terms actually sent to the transcriber: what was suggested and not
 * dismissed, plus what the user typed in. This is the single authoritative
 * list - it's what the chips show, and it's what goes over the wire, so the
 * server never has to re-derive intent from the prose.
 */
/**
 * A speaker bound as a number the API can accept, or undefined for "auto".
 *
 * The field is a text input, so it can hold anything a keyboard produces.
 * `Number('abc')` is NaN, which would serialise as the string "NaN" and come
 * back as a 422 - so anything that isn't a whole number is treated as unset.
 * The backend clamps and orders whatever does arrive.
 */
export function speakerBound(raw: string): number | undefined {
  const value = Number(raw.trim())
  if (!raw.trim() || !Number.isInteger(value) || value < 1) return undefined
  return value
}

/** True when both bounds are set and the wrong way round. The backend swaps
 *  them rather than failing, but saying so up front is less surprising. */
export function speakerBoundsInverted(options: TranscriptionOptions): boolean {
  const min = speakerBound(options.minSpeakers)
  const max = speakerBound(options.maxSpeakers)
  return min !== undefined && max !== undefined && min > max
}

export function effectiveTerms(options: TranscriptionOptions): string[] {
  const kept = suggestTerms(options.context).filter((term) => !containsTerm(options.dismissedTerms, term))
  const merged = [...kept]
  for (const term of options.addedTerms) {
    if (!containsTerm(merged, term)) merged.push(term)
  }
  return merged
}

/**
 * The one-line echo of the settings - "Speakers on · 2–4 · timestamps on".
 * Shown on the disclosure when it's shut, and in the transcript rail, which
 * no longer holds the controls themselves and needs to say what they're set to.
 */
/**
 * The same summary as `describeTranscriptionOptions`, but as separate facts so
 * the header can set each one as its own pill instead of joining them with
 * punctuation and hoping the separators read as boundaries.
 */
export function summariseTranscriptionOptions(options: TranscriptionOptions): string[] {
  const terms = effectiveTerms(options).length
  const range =
    options.minSpeakers || options.maxSpeakers
      ? `${options.minSpeakers || '?'}–${options.maxSpeakers || '?'} speakers`
      : null
  return [
    options.diarize ? 'Speakers on' : 'Speakers off',
    options.diarize ? range : null,
    options.includeTimestamps ? 'Timestamps on' : 'Timestamps off',
    terms > 0 ? `${terms} term${terms === 1 ? '' : 's'}` : null,
  ].filter((entry): entry is string => entry !== null)
}

export function describeTranscriptionOptions(options: TranscriptionOptions): string {
  const range =
    options.minSpeakers || options.maxSpeakers
      ? ` · ${options.minSpeakers || '?'}–${options.maxSpeakers || '?'}`
      : ''
  const terms = effectiveTerms(options).length
  return [
    options.diarize ? `Speakers on${range}` : 'Speakers off',
    options.includeTimestamps ? 'timestamps on' : 'timestamps off',
    terms > 0 ? `${terms} term${terms === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
