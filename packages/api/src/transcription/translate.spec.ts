import {
  batchLines,
  translateTranscript,
  parseTranslatedLines,
  buildTranslationPrompt,
} from './translate';
import type { ParsedTranscriptLine } from 'librechat-data-provider';
import type { SpeakerModelConfig } from './speakerModel';

function line(lineIndex: number, text: string): ParsedTranscriptLine {
  return { lineIndex, text, speaker: 'Speaker 1', timestamp: '00:00:00' };
}

describe('buildTranslationPrompt', () => {
  it('prefixes each line with its own lineIndex, fractional ones included', () => {
    expect(buildTranslationPrompt([line(0, 'hola'), line(0.5, 'adios')])).toBe(
      '[0] hola\n[0.5] adios',
    );
  });
});

describe('parseTranslatedLines', () => {
  const requested = [line(0, 'hola'), line(1, 'adios')];

  it('maps echoed indices back to their translations', () => {
    expect(parseTranslatedLines('[0] hello\n[1] goodbye', requested)).toEqual({
      0: 'hello',
      1: 'goodbye',
    });
  });

  it('keeps fractional indices, which inserted lines use', () => {
    expect(parseTranslatedLines('[0.5] hello', [line(0.5, 'hola')])).toEqual({ 0.5: 'hello' });
  });

  it('drops indices that were never sent rather than attaching them to a line', () => {
    expect(parseTranslatedLines('[0] hello\n[99] invented', requested)).toEqual({ 0: 'hello' });
  });

  it('ignores commentary and blank output between the lines', () => {
    expect(parseTranslatedLines('Sure!\n\n[1] goodbye\n', requested)).toEqual({ 1: 'goodbye' });
  });

  it('leaves a line out when the model returned it empty', () => {
    expect(parseTranslatedLines('[0]   \n[1] goodbye', requested)).toEqual({ 1: 'goodbye' });
  });
});

describe('batchLines', () => {
  it('splits into chunks of the given size with the remainder last', () => {
    expect(batchLines([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty transcript', () => {
    expect(batchLines([], 2)).toEqual([]);
  });
});

describe('translateTranscript', () => {
  const config = (fetchImpl: typeof fetch): SpeakerModelConfig => ({
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    model: 'test-model',
    fetchImpl,
  });

  function respond(content: string): Response {
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as Response;
  }

  it('merges every batch into one lineIndex-keyed result', async () => {
    const lines = Array.from({ length: 45 }, (_, i) => line(i, `linea ${i}`));
    const bodies: string[] = [];
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1].content;
      bodies.push(prompt);
      const indices = prompt.split('\n').map((entry) => entry.slice(1, entry.indexOf(']')));
      return respond(indices.map((index) => `[${index}] english ${index}`).join('\n'));
    }) as unknown as typeof fetch;

    const translated = await translateTranscript(config(fetchImpl), lines);

    expect(bodies).toHaveLength(2);
    expect(Object.keys(translated)).toHaveLength(45);
    expect(translated[0]).toBe('english 0');
    expect(translated[44]).toBe('english 44');
  });

  it('omits lines the model did not return, so the caller keeps the original', async () => {
    const fetchImpl = jest.fn(async () => respond('[1] goodbye')) as unknown as typeof fetch;
    const translated = await translateTranscript(config(fetchImpl), [
      line(0, 'hola'),
      line(1, 'adios'),
    ]);
    expect(translated).toEqual({ 1: 'goodbye' });
  });

  it('sends no tools, so a plain completions endpoint is enough', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) => respond('[0] hello'));
    await translateTranscript(config(fetchImpl as unknown as typeof fetch), [line(0, 'hola')]);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
