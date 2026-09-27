import { postChatCompletion } from './speakerModel';
import type { ParsedTranscriptLine } from 'librechat-data-provider';
import type { SpeakerModelConfig, SpeakerModelMessage } from './speakerModel';

/**
 * Translates a transcript's lines into English for reading, not for the
 * record. Nothing here writes a correction: the result is handed straight
 * back to the caller and the stored transcript is left exactly as the
 * pipeline produced it, because on an investigation transcript a machine
 * translation is a reading aid and the original words are the evidence.
 *
 * Line-by-line rather than one blob of prose, so the translation can be
 * shown against the timestamps and speakers it came from. Lines are sent in
 * batches carrying their real `lineIndex`, and the model is asked to echo
 * that index back - a line the model drops, renumbers or mangles simply
 * keeps its original text instead of silently shifting the whole transcript
 * up by one.
 */

/** Lines per request. Sized for a local model's context rather than a
 *  frontier one, since this runs against the same endpoint speaker
 *  identification uses - which defaults to a local Ollama.
 *  ponytail: fixed batch size, switch to a token estimate if long lines
 *  start overflowing the context. */
const BATCH_SIZE = 40;

const SYSTEM_PROMPT = [
  'You translate interview transcript lines into English.',
  '',
  'Every input line is prefixed with its index in square brackets. Reply with',
  'one line per input line, in the same order, each prefixed with the SAME index',
  'in square brackets. Output nothing else - no commentary, no blank lines, no',
  'summary.',
  '',
  'Translate literally, including hesitations, false starts and repetition.',
  'Preserve the speaker’s register: do not tidy up, shorten, or explain what',
  'was said. A line already in English is repeated back unchanged. A line you',
  'cannot translate is repeated back unchanged rather than guessed at.',
].join('\n');

const LINE_PATTERN = /^\s*\[(-?\d+(?:\.\d+)?)\]\s?(.*)$/;

export function buildTranslationPrompt(lines: ParsedTranscriptLine[]): string {
  return lines.map((line) => `[${line.lineIndex}] ${line.text}`).join('\n');
}

/** The exact pair of messages one batch is sent as - the same shape every
 *  other transcription pass builds, so the prompt disclosure can render what
 *  this stage really says by calling the builder rather than quoting it. */
export function buildTranslationMessages(
  lines: ParsedTranscriptLine[],
): [SpeakerModelMessage, SpeakerModelMessage] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildTranslationPrompt(lines) },
  ];
}

/**
 * Pulls `[index] text` pairs out of a completion, keeping only indices that
 * were actually sent - a hallucinated index would otherwise attach a
 * translation to a line the model never saw.
 */
export function parseTranslatedLines(
  content: string,
  requested: ParsedTranscriptLine[],
): Record<number, string> {
  const allowed = new Set(requested.map((line) => line.lineIndex));
  const translated: Record<number, string> = {};
  for (const raw of content.split('\n')) {
    const match = LINE_PATTERN.exec(raw);
    if (!match) {
      continue;
    }
    const lineIndex = Number(match[1]);
    const text = match[2].trim();
    if (!allowed.has(lineIndex) || text.length === 0) {
      continue;
    }
    translated[lineIndex] = text;
  }
  return translated;
}

export function batchLines<T>(lines: T[], size: number = BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < lines.length; i += size) {
    batches.push(lines.slice(i, i + size));
  }
  return batches;
}

/**
 * The whole transcript, translated, keyed by `lineIndex`. Lines the model
 * left out are absent from the result rather than blank, so the caller can
 * fall back to the original text per line.
 */
export async function translateTranscript(
  config: SpeakerModelConfig,
  lines: ParsedTranscriptLine[],
): Promise<Record<number, string>> {
  const translated: Record<number, string> = {};
  for (const batch of batchLines(lines)) {
    const response = await postChatCompletion(config, {
      messages: buildTranslationMessages(batch),
    });
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      continue;
    }
    Object.assign(translated, parseTranslatedLines(content, batch));
  }
  return translated;
}
