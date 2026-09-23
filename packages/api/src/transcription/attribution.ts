import type { ParsedTranscriptLine } from 'librechat-data-provider';

/**
 * Corrects whose words are whose, where only the sense of the conversation
 * can tell.
 *
 * `realign.ts` repairs sentences torn across a speaker change, which is a
 * grammatical problem with a grammatical answer. What it cannot touch is a
 * correctly-punctuated line attributed to the wrong person: `Jordan: Yes.`
 * answering a question Alex asked Priya, or an interviewee's
 * "Absolutely." swallowed onto the end of the interviewer's sentence.
 * Deciding those needs to follow the exchange - who was asked, who replied -
 * so it is the model's job, not a rule's.
 *
 * On an investigation transcript a wrong attribution is evidential, so
 * everything here is built to fail closed:
 *
 * - results are written as ordinary corrections, so each one is visible in
 *   the roster UI, undoable, attributed to a user, and layered over a
 *   pipeline transcript that is never itself rewritten;
 * - a fix must quote the line it claims to have read;
 * - attribution may only move between people already in the recording;
 * - a batch that would rewrite an implausible share of the transcript is
 *   discarded whole, because a model that thinks most of an interview is
 *   misattributed has misread it, and applying most of that is worse than
 *   applying none.
 */

export interface AttributionFix {
  /** `reassign` moves a whole line to another speaker; `split` peels a
   *  trailing interjection off onto a line of its own. */
  kind: 'reassign' | 'split';
  lineIndex: number;
  toSpeaker: string;
  /** For `reassign`, text proving the line was read. For `split`, the exact
   *  trailing text to move - it must end the line. */
  quote: string;
  confidence: number;
}

export type AttributionRejection =
  | 'line_not_found'
  | 'unknown_speaker'
  | 'no_change'
  | 'low_confidence'
  | 'quote_not_found'
  | 'not_trailing'
  | 'batch_too_large';

export interface RejectedFix {
  fix: AttributionFix;
  reason: AttributionRejection;
}

export interface AttributionCandidate {
  lineIndex: number;
  reason: 'orphan_turn' | 'self_answered_question' | 'trailing_interjection';
  context: ParsedTranscriptLine[];
}

export interface AttributionCorrection {
  type: 'segment_reassign' | 'text_edit' | 'line_insert';
  lineIndex: number;
  fromSpeakerId?: string;
  toSpeakerId?: string;
  fromText?: string;
  toText?: string;
  speaker?: string;
  text?: string;
  seconds?: number;
  endSeconds?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.7;
/** Above this share of lines, a batch is treated as a misreading rather than
 *  a set of fixes. Real misattribution runs a few percent of an interview. */
const DEFAULT_MAX_CHANGE_RATIO = 0.25;
/** A proportion only means something once there are a few fixes to measure.
 *  Below this, one sound correction on a short extract would otherwise trip
 *  the runaway guard purely because the denominator is small. */
const MIN_FIXES_FOR_RATIO_GUARD = 3;
const SHORT_TURN_WORDS = 6;
const INTERJECTION_WORDS = 3;
const MIN_HOST_WORDS = 8;
const DEFAULT_CONTEXT = 4;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sentencesOf(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+["')\]]*/g) ?? [];
}

/**
 * The lines worth asking about. Sending a whole interview to a model invites
 * it to find problems everywhere; these three shapes are where real
 * misattribution actually lands, and each comes with its surrounding turns
 * because the exchange is what settles it.
 */
export function selectAttributionCandidates(
  lines: ParsedTranscriptLine[],
  { context = DEFAULT_CONTEXT }: { context?: number } = {},
): AttributionCandidate[] {
  const candidates: AttributionCandidate[] = [];

  for (let index = 0; index < lines.length; index++) {
    const previous = lines[index - 1];
    const current = lines[index];
    const next = lines[index + 1];
    let reason: AttributionCandidate['reason'] | null = null;

    if (
      previous?.speaker != null &&
      next?.speaker != null &&
      previous.speaker === next.speaker &&
      current.speaker !== next.speaker &&
      wordCount(current.text) <= SHORT_TURN_WORDS
    ) {
      reason = 'orphan_turn';
    } else if (
      previous != null &&
      previous.speaker === current.speaker &&
      /\?["')\]]*$/.test(previous.text.trim()) &&
      wordCount(current.text) <= SHORT_TURN_WORDS
    ) {
      reason = 'self_answered_question';
    } else {
      const sentences = sentencesOf(current.text);
      const last = sentences[sentences.length - 1]?.trim() ?? '';
      if (
        sentences.length >= 2 &&
        wordCount(last) <= INTERJECTION_WORDS &&
        wordCount(current.text) - wordCount(last) >= MIN_HOST_WORDS
      ) {
        reason = 'trailing_interjection';
      }
    }

    if (reason == null) {
      continue;
    }
    candidates.push({
      lineIndex: current.lineIndex,
      reason,
      context: lines.slice(
        Math.max(0, index - context),
        Math.min(lines.length, index + context + 1),
      ),
    });
  }
  return candidates;
}

function rejectionFor(
  fix: AttributionFix,
  byIndex: Map<number, ParsedTranscriptLine>,
  speakers: Set<string>,
  minConfidence: number,
): AttributionRejection | null {
  const line = byIndex.get(fix.lineIndex);
  if (line == null) {
    return 'line_not_found';
  }
  if (typeof fix.toSpeaker !== 'string' || !speakers.has(fix.toSpeaker)) {
    return 'unknown_speaker';
  }
  if (fix.kind === 'reassign' && fix.toSpeaker === line.speaker) {
    return 'no_change';
  }
  if (!(fix.confidence >= minConfidence)) {
    return 'low_confidence';
  }

  const quote = normalize(fix.quote ?? '');
  const text = normalize(line.text);
  if (quote.length === 0 || !text.includes(quote)) {
    return 'quote_not_found';
  }
  if (fix.kind === 'split' && (!text.endsWith(quote) || quote === text)) {
    return 'not_trailing';
  }
  return null;
}

export function acceptAttributionFixes(
  fixes: AttributionFix[],
  {
    lines,
    speakers,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    maxChangeRatio = DEFAULT_MAX_CHANGE_RATIO,
  }: {
    lines: ParsedTranscriptLine[];
    speakers: string[];
    minConfidence?: number;
    maxChangeRatio?: number;
  },
): { accepted: AttributionFix[]; rejected: RejectedFix[] } {
  const byIndex = new Map(lines.map((line) => [line.lineIndex, line]));
  const speakerSet = new Set(speakers);

  const rejected: RejectedFix[] = [];
  const accepted: AttributionFix[] = [];
  for (const fix of fixes) {
    const reason = rejectionFor(fix, byIndex, speakerSet, minConfidence);
    if (reason == null) {
      accepted.push(fix);
      continue;
    }
    rejected.push({ fix, reason });
  }

  if (
    lines.length > 0 &&
    accepted.length >= MIN_FIXES_FOR_RATIO_GUARD &&
    accepted.length / lines.length > maxChangeRatio
  ) {
    return {
      accepted: [],
      rejected: [
        ...rejected,
        ...accepted.map((fix) => ({ fix, reason: 'batch_too_large' as const })),
      ],
    };
  }
  return { accepted, rejected };
}

/**
 * Renders accepted fixes as correction events.
 *
 * A split becomes two: the host line loses its tail via `text_edit`, and the
 * tail becomes its own line via `line_insert` at a fractional index just
 * after it, timed inside the host's own range so playback still lands on the
 * right audio.
 */
export function planAttributionCorrections(
  fixes: AttributionFix[],
  lines: ParsedTranscriptLine[],
): AttributionCorrection[] {
  const byIndex = new Map(lines.map((line) => [line.lineIndex, line]));
  const corrections: AttributionCorrection[] = [];

  for (const fix of fixes) {
    const line = byIndex.get(fix.lineIndex);
    if (line == null) {
      continue;
    }
    if (fix.kind === 'reassign') {
      corrections.push({
        type: 'segment_reassign',
        lineIndex: fix.lineIndex,
        fromSpeakerId: line.speaker,
        toSpeakerId: fix.toSpeaker,
      });
      continue;
    }

    const trailingLength = fix.quote.trim().length;
    const kept = line.text
      .trim()
      .slice(0, line.text.trim().length - trailingLength)
      .trim();
    if (kept.length === 0) {
      continue;
    }
    corrections.push({
      type: 'text_edit',
      lineIndex: fix.lineIndex,
      fromText: line.text,
      toText: kept,
    });

    // The tail gets the last slice of the host's time range, in proportion to
    // how much of the text it is - it was spoken at the end of that span.
    const start = line.seconds;
    const end = line.endSeconds;
    const ratio = trailingLength / Math.max(1, line.text.trim().length);
    const boundary =
      start != null && end != null && end > start ? end - (end - start) * ratio : start;
    corrections.push({
      type: 'line_insert',
      lineIndex: fix.lineIndex + 0.5,
      speaker: fix.toSpeaker,
      text: fix.quote.trim(),
      seconds: boundary,
      endSeconds: end,
    });
  }
  return corrections;
}

export interface AttributionReview {
  corrections: AttributionCorrection[];
  accepted: AttributionFix[];
  rejected: RejectedFix[];
  candidates: number;
}

const DEFAULT_BATCH_SIZE = 25;

/**
 * The whole pass: find suspect lines, ask the model about them in batches,
 * verify what comes back, and render the survivors as corrections.
 *
 * Batches are independent on purpose. A local model will occasionally return
 * a malformed tool call and fail an entire request - observed once in six
 * batches against a real interview - and losing those candidates is a far
 * better outcome than losing every sound fix in the other batches with them.
 * Verification runs across all batches together, so the runaway guard still
 * sees the whole picture rather than each batch in isolation.
 */
export async function reviewAttribution({
  lines,
  askModel,
  speakers,
  batchSize = DEFAULT_BATCH_SIZE,
  minConfidence,
  maxChangeRatio,
  context,
  onError,
}: {
  lines: ParsedTranscriptLine[];
  askModel: (candidates: AttributionCandidate[], speakers: string[]) => Promise<AttributionFix[]>;
  speakers?: string[];
  batchSize?: number;
  minConfidence?: number;
  maxChangeRatio?: number;
  context?: number;
  onError?: (error: unknown) => void;
}): Promise<AttributionReview> {
  const candidates = selectAttributionCandidates(lines, context != null ? { context } : {});
  const roster =
    speakers ??
    Array.from(
      new Set(
        lines
          .map((line) => line.speaker)
          .filter((speaker): speaker is string => speaker != null && speaker.length > 0),
      ),
    );
  if (candidates.length === 0 || roster.length === 0) {
    return { corrections: [], accepted: [], rejected: [], candidates: candidates.length };
  }

  const proposals: AttributionFix[] = [];
  for (let start = 0; start < candidates.length; start += batchSize) {
    try {
      proposals.push(...(await askModel(candidates.slice(start, start + batchSize), roster)));
    } catch (error) {
      onError?.(error);
    }
  }

  const { accepted, rejected } = acceptAttributionFixes(proposals, {
    lines,
    speakers: roster,
    minConfidence,
    maxChangeRatio,
  });
  return {
    corrections: planAttributionCorrections(accepted, lines),
    accepted,
    rejected,
    candidates: candidates.length,
  };
}
