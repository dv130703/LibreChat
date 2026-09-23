import { formatTranscriptTimestamp } from 'librechat-data-provider';
import type { ParsedTranscriptLine, TranscriptLineSegment } from 'librechat-data-provider';

/**
 * Repairs sentences torn in half by a speaker change.
 *
 * Diarization assigns each word to whichever speaker turn its timestamp falls
 * inside, and word timestamps are only accurate to a fraction of a second. At
 * a turn boundary that is enough to hand the last word of one person's
 * sentence to the next person, which is how a transcript ends up reading
 * `Jordan: All` / `Alex: right.` - two boxes, one utterance, and a reviewer
 * left wondering who said what. On a real 40-minute interview this affected
 * roughly one line in seven.
 *
 * The signal is grammatical, not acoustic: a line that stops without terminal
 * punctuation followed by a line that opens lowercase is one sentence, and
 * one sentence has one speaker. That pairing is specific enough to leave a
 * genuine hand-off (`Thank you for coming in` / `Absolutely.`) untouched,
 * because a real new utterance starts with a capital.
 *
 * Only the straddling fragment moves; finished sentences stay with whoever
 * said them. Ownership goes to the side contributing more of the sentence,
 * which is what distinguishes a speaker's trailing word being stolen from
 * their opening word being stolen.
 *
 * Note on what is NOT done here: a short line sandwiched between two lines of
 * one other speaker looks like an obvious stray, but measuring it against a
 * real interview showed the overwhelming majority of those are correct - they
 * are the interviewee answering ("Good afternoon.", "Yes, it is."). Absorbing
 * them would destroy sound attribution to fix a handful of cases, so that
 * rule is deliberately absent.
 */

/** Terminal punctuation, allowing a closing quote or bracket after it. */
const ENDS_SENTENCE = /[.!?]["')\]]*$/;
const STARTS_LOWERCASE = /^[a-z]/;

/** Splits a line into its finished sentences and any unfinished trailing
 *  fragment. `['', text]` when nothing in it is finished. */
export function splitDanglingTail(text: string): [string, string] {
  const trimmed = text.trim();
  if (ENDS_SENTENCE.test(trimmed)) {
    return [trimmed, ''];
  }
  const match = trimmed.match(/^(.*[.!?]["')\]]*)\s+(\S.*)$/);
  return match ? [match[1], match[2]] : ['', trimmed];
}

/** Splits a line into its first finished sentence and whatever follows it. */
export function splitLeadingSentence(text: string): [string, string] {
  const trimmed = text.trim();
  const match = trimmed.match(/^(.*?[.!?]["')\]]*)(?:\s+(\S.*))?$/);
  return match ? [match[1], match[2] ?? ''] : [trimmed, ''];
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function join(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Which side of the boundary owns the straddling sentence.
 *
 * Word count decides it: the speaker who contributed most of the sentence
 * said it. On a tie - `All` / `right.`, the commonest shape - neither side
 * has more claim, so the surrounding turn breaks it, since a one-word
 * interjection between two lines of the same voice is almost always that
 * voice carrying on.
 */
function resolveOwner(
  tail: string,
  lead: string,
  previous: ParsedTranscriptLine | undefined,
  following: ParsedTranscriptLine | undefined,
  current: ParsedTranscriptLine,
  next: ParsedTranscriptLine,
): 'current' | 'next' {
  const tailWords = wordCount(tail);
  const leadWords = wordCount(lead);
  if (tailWords !== leadWords) {
    return tailWords > leadWords ? 'current' : 'next';
  }
  if (previous?.speaker != null && previous.speaker === next.speaker) {
    return 'next';
  }
  if (following?.speaker != null && following.speaker === current.speaker) {
    return 'current';
  }
  return 'next';
}

function withTimes(
  line: ParsedTranscriptLine,
  seconds: number | undefined,
  endSeconds: number | undefined,
): ParsedTranscriptLine {
  if (seconds === line.seconds && endSeconds === line.endSeconds) {
    return line;
  }
  return {
    ...line,
    seconds,
    endSeconds,
    timestamp: seconds != null ? formatTranscriptTimestamp(seconds) : line.timestamp,
  };
}

export function realignSpeakerBoundaries(lines: ParsedTranscriptLine[]): ParsedTranscriptLine[] {
  if (lines.length < 2) {
    return lines;
  }

  const working = lines.map((line) => ({ ...line }));
  for (let index = 0; index < working.length - 1; index++) {
    const current = working[index];
    const next = working[index + 1];
    if (
      current.speaker == null ||
      next.speaker == null ||
      current.speaker === next.speaker ||
      current.text.trim().length === 0 ||
      next.text.trim().length === 0 ||
      ENDS_SENTENCE.test(current.text.trim()) ||
      !STARTS_LOWERCASE.test(next.text.trim())
    ) {
      continue;
    }

    const [head, tail] = splitDanglingTail(current.text);
    const [lead, rest] = splitLeadingSentence(next.text);
    if (tail.length === 0) {
      continue;
    }

    const owner = resolveOwner(tail, lead, working[index - 1], working[index + 2], current, next);
    if (owner === 'current') {
      current.text = join(head, tail, lead);
      next.text = rest;
    } else {
      current.text = head;
      next.text = join(tail, lead, rest);
    }
  }

  // A line whose words all moved away must not linger as a blank box, and its
  // time range goes to the line that took them - the same reasoning as a
  // manual delete, so no stretch of audio ends up covered by no box at all.
  const result: ParsedTranscriptLine[] = [];
  for (let index = 0; index < working.length; index++) {
    const line = working[index];
    if (line.text.trim().length > 0) {
      result.push(line);
      continue;
    }
    const previous = result[result.length - 1];
    const next = working[index + 1];
    if (next != null) {
      working[index + 1] = withTimes(next, line.seconds ?? next.seconds, next.endSeconds);
      continue;
    }
    if (previous != null) {
      result[result.length - 1] = withTimes(
        previous,
        previous.seconds,
        line.endSeconds ?? previous.endSeconds,
      );
    }
  }
  return result;
}

/**
 * `realignSpeakerBoundaries` against the pipeline's own segment shape, which
 * is what the transcript text is rendered from.
 *
 * Applied to the rendered text only - the diarization detail file keeps the
 * raw, unrepaired segments, so the pipeline's original attribution stays on
 * record underneath this the same way it does underneath a reviewer's
 * corrections.
 */
export function realignSegments(segments: TranscriptLineSegment[]): TranscriptLineSegment[] {
  const realigned = realignSpeakerBoundaries(
    segments.map((segment, index) => ({
      lineIndex: index,
      seconds: segment.start,
      endSeconds: segment.end,
      speaker: segment.speaker,
      text: segment.text,
    })),
  );
  if (realigned.length === segments.length) {
    let changed = false;
    for (let index = 0; index < segments.length; index++) {
      const line = realigned[index];
      const segment = segments[index];
      if (
        line.text !== segment.text ||
        line.speaker !== segment.speaker ||
        line.seconds !== segment.start ||
        line.endSeconds !== segment.end
      ) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return segments;
    }
  }
  return realigned.map((line) => {
    const segment: TranscriptLineSegment = {
      start: line.seconds ?? 0,
      end: line.endSeconds ?? 0,
      text: line.text,
    };
    if (line.speaker != null) {
      segment.speaker = line.speaker;
    }
    return segment;
  });
}
