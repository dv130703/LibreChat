import { parseToolCalls, postChatCompletion } from './speakerModel';
import type { SpeakerModelConfig, SpeakerModelMessage, SpeakerModelResponse } from './speakerModel';
import type { AttributionCandidate, AttributionFix } from './attribution';

/**
 * Asks a model who actually said a handful of suspect lines.
 *
 * Only the candidate lines from `selectAttributionCandidates` are put to it,
 * each wrapped in its surrounding turns, because the question is always about
 * the exchange: an answer belongs to whoever was asked, not to whoever asked.
 *
 * The prompt's job is mostly restraint. Most flagged lines are correctly
 * attributed already - a short "Yes." between two of the interviewer's
 * questions is usually just the interviewee answering - so the model is told
 * plainly that changing nothing is the expected outcome, and that it may only
 * move words between people already speaking in the recording.
 */

export interface AttributionTool {
  type: 'function';
  function: {
    name: 'fix_attribution';
    description: string;
    parameters: {
      type: 'object';
      properties: {
        lineIndex: { type: 'integer'; description: string };
        kind: { type: 'string'; enum: string[]; description: string };
        toSpeaker: { type: 'string'; enum: string[]; description: string };
        quote: { type: 'string'; description: string };
        confidence: { type: 'number'; minimum: number; maximum: number; description: string };
      };
      required: string[];
      additionalProperties: false;
    };
  };
}

const TOOL_NAME = 'fix_attribution';

export function buildAttributionTool(speakers: string[]): AttributionTool {
  return {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description:
        'Correct the speaker of a line the transcript attributes to the wrong person. ' +
        'Call it only for a line you are confident about; most flagged lines are already correct.',
      parameters: {
        type: 'object',
        properties: {
          lineIndex: {
            type: 'integer',
            description: 'Index of the line being corrected, exactly as shown.',
          },
          kind: {
            type: 'string',
            enum: ['reassign', 'split'],
            description:
              'reassign: the whole line belongs to someone else. ' +
              'split: only the short phrase at the END of the line belongs to someone else.',
          },
          toSpeaker: {
            type: 'string',
            enum: speakers,
            description: 'The person who actually spoke those words.',
          },
          quote: {
            type: 'string',
            description:
              'For reassign, text copied verbatim from that line. For split, the exact ' +
              'trailing phrase to move, which must be the end of the line.',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'How certain the surrounding exchange makes this.',
          },
        },
        required: ['lineIndex', 'kind', 'toSpeaker', 'quote', 'confidence'],
        additionalProperties: false,
      },
    },
  };
}

const SYSTEM_PROMPT = [
  'You check who is speaking in an interview transcript produced by speech recognition.',
  '',
  'Speaker labels come from automatic diarization, which sometimes gives a line to',
  'the wrong person. Two specific mistakes are worth correcting:',
  '',
  '1. A whole line attributed to the wrong person. The commonest case is an answer',
  '   credited to an interviewer: if one person asks "Is that your full name?" then',
  '   the "Yes." that follows belongs to the person being questioned, never to the',
  '   questioner and never to their colleague.',
  "2. A short reply absorbed onto the END of someone else's sentence, such as an",
  '   interviewer\'s long question ending in "Absolutely." - that last word is the',
  '   other person answering. Use split, and quote only the trailing phrase.',
  '',
  'Most lines you are shown are already correct. A short "Yes.", "Okay." or "Mm-hmm."',
  "between two of the interviewer's turns is normally just the interviewee replying,",
  'and needs no change. Leaving everything alone is a good and expected answer.',
  '',
  'Never move words to somebody who is not already speaking in this recording. Do not',
  'change a line because of who you think should have said it, or how formal it sounds',
  '- only when the exchange itself shows the label is wrong. Do not correct wording,',
  'punctuation or grammar; speaker attribution is the only thing you may change.',
  'Some text is garbled by the transcriber: leave it exactly as it is.',
].join('\n');

export function buildAttributionMessages(
  candidates: AttributionCandidate[],
  speakers: string[],
): [SpeakerModelMessage, SpeakerModelMessage] {
  const blocks = candidates.map((candidate) => {
    const lines = candidate.context
      .map((line) => {
        const marker = line.lineIndex === candidate.lineIndex ? ' <== check this line' : '';
        return `  [${line.lineIndex}] ${line.speaker ?? '(unattributed)'}: ${line.text}${marker}`;
      })
      .join('\n');
    return `Line ${candidate.lineIndex} (flagged: ${candidate.reason})\n${lines}`;
  });

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `People speaking in this recording: ${speakers.join(', ')}.`,
        '',
        'Each block below is one flagged line with the turns around it for context.',
        'Correct only the flagged lines, and only where the exchange shows they are wrong.',
        '',
        blocks.join('\n\n'),
      ].join('\n'),
    },
  ];
}

interface RawFix {
  lineIndex?: number | string;
  kind?: string;
  toSpeaker?: string;
  quote?: string;
  confidence?: number | string;
}

export function parseAttributionFixes(response: SpeakerModelResponse): AttributionFix[] {
  const fixes: AttributionFix[] = [];
  for (const raw of parseToolCalls<RawFix>(response, TOOL_NAME)) {
    const lineIndex = Number(raw.lineIndex);
    const confidence = Number(raw.confidence);
    if (
      !Number.isFinite(lineIndex) ||
      typeof raw.toSpeaker !== 'string' ||
      typeof raw.quote !== 'string' ||
      (raw.kind !== 'reassign' && raw.kind !== 'split')
    ) {
      continue;
    }
    fixes.push({
      kind: raw.kind,
      lineIndex,
      toSpeaker: raw.toSpeaker,
      quote: raw.quote,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    });
  }
  return fixes;
}

/** Asks the model about one batch of candidates. */
export function createAttributionModel(
  config: SpeakerModelConfig,
): (candidates: AttributionCandidate[], speakers: string[]) => Promise<AttributionFix[]> {
  return async (candidates, speakers) => {
    if (candidates.length === 0) {
      return [];
    }
    const body = await postChatCompletion(config, {
      messages: buildAttributionMessages(candidates, speakers),
      tools: [buildAttributionTool(speakers)],
    });
    return parseAttributionFixes(body);
  };
}
