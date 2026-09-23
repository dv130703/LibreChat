import {
  buildAssignSpeakerTool,
  buildIdentificationMessages,
  createSpeakerModel,
  parseAssignments,
} from './speakerModel';
import type { SpeakerIdentificationRequest } from './identifySpeakers';
import type { SpeakerModelToolCall } from './speakerModel';

const request: SpeakerIdentificationRequest = {
  evidence: [
    { lineIndex: 0, speaker: 'Speaker 1', text: 'For the record, state your name.' },
    { lineIndex: 1, speaker: 'Speaker 2', text: 'Rowan Donbry, finance director.' },
  ],
  unidentified: ['Speaker 1', 'Speaker 2'],
  candidates: [{ profileId: 'p1', fullName: 'Rowan Danbury', role: 'Finance Director' }],
};

describe('buildAssignSpeakerTool', () => {
  /** The structural guarantee that this stage cannot rename a speaker who
   *  already has a name: the label simply is not in the schema. */
  it('restricts the speaker parameter to the unidentified labels', () => {
    const tool = buildAssignSpeakerTool(['Speaker 2']);

    expect(tool.function.parameters.properties.speakerId.enum).toEqual(['Speaker 2']);
  });

  it('requires evidence and a confidence alongside the name', () => {
    const tool = buildAssignSpeakerTool(['Speaker 2']);

    expect(tool.function.parameters.required).toEqual(
      expect.arrayContaining([
        'speakerId',
        'name',
        'evidenceLineIndex',
        'evidenceQuote',
        'confidence',
      ]),
    );
  });
});

describe('buildIdentificationMessages', () => {
  it('gives the model the roster with roles, as a spelling authority', () => {
    const [, user] = buildIdentificationMessages(request);

    expect(user.content).toContain('Rowan Danbury');
    expect(user.content).toContain('Finance Director');
  });

  /** The model cites a line index back, so it must see the indices - and
   *  they must be the transcript's own, not positions in the excerpt. */
  it('labels every evidence line with its transcript line index', () => {
    const [, user] = buildIdentificationMessages(request);

    expect(user.content).toContain('[1] Speaker 2: Rowan Donbry, finance director.');
  });

  it('names the speakers still needing identification', () => {
    const [, user] = buildIdentificationMessages(request);

    expect(user.content).toContain('Speaker 1');
    expect(user.content).toContain('Speaker 2');
  });

  /** Abstention has to be stated as acceptable, or the model will invent a
   *  name to satisfy the request. */
  it('tells the model not to guess', () => {
    const [system] = buildIdentificationMessages(request);

    expect(system.content.toLowerCase()).toContain('do not guess');
  });

  it('warns that transcribed names are misspelled', () => {
    const [system] = buildIdentificationMessages(request);

    expect(system.content.toLowerCase()).toContain('misspell');
  });
});

describe('parseAssignments', () => {
  function response(toolCalls: SpeakerModelToolCall[]) {
    return { choices: [{ message: { tool_calls: toolCalls } }] };
  }

  it('reads every assignment the model made', () => {
    const assignments = parseAssignments(
      response([
        {
          function: {
            name: 'assign_speaker',
            arguments: JSON.stringify({
              speakerId: 'Speaker 2',
              name: 'Rowan Danbury',
              evidenceLineIndex: 1,
              evidenceQuote: 'Rowan Donbry, finance director.',
              confidence: 0.9,
            }),
          },
        },
      ]),
    );

    expect(assignments).toEqual([
      {
        speakerId: 'Speaker 2',
        name: 'Rowan Danbury',
        evidenceLineIndex: 1,
        evidenceQuote: 'Rowan Donbry, finance director.',
        confidence: 0.9,
      },
    ]);
  });

  /** Identifying nobody is a normal outcome, and arrives as a plain text
   *  reply with no tool calls at all. */
  it('returns nothing when the model made no tool call', () => {
    expect(parseAssignments({ choices: [{ message: { content: 'I cannot tell.' } }] })).toEqual([]);
  });

  it('returns nothing for an empty or malformed response', () => {
    expect(parseAssignments({})).toEqual([]);
    expect(parseAssignments({ choices: [] })).toEqual([]);
  });

  it('skips a tool call whose arguments are not valid JSON', () => {
    const assignments = parseAssignments(
      response([{ function: { name: 'assign_speaker', arguments: '{not json' } }]),
    );

    expect(assignments).toEqual([]);
  });

  it('ignores a tool call for some other tool', () => {
    const assignments = parseAssignments(
      response([{ function: { name: 'something_else', arguments: '{}' } }]),
    );

    expect(assignments).toEqual([]);
  });

  /** A local model will happily return a string where a number belongs. */
  it('coerces a numeric field the model returned as a string', () => {
    const assignments = parseAssignments(
      response([
        {
          function: {
            name: 'assign_speaker',
            arguments: JSON.stringify({
              speakerId: 'Speaker 2',
              name: 'Rowan Danbury',
              evidenceLineIndex: '1',
              evidenceQuote: 'Rowan Donbry, finance director.',
              confidence: '0.9',
            }),
          },
        },
      ]),
    );

    expect(assignments[0].evidenceLineIndex).toBe(1);
    expect(assignments[0].confidence).toBe(0.9);
  });
});

describe('createSpeakerModel', () => {
  function okResponse() {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'assign_speaker',
                    arguments: JSON.stringify({
                      speakerId: 'Speaker 2',
                      name: 'Rowan Danbury',
                      evidenceLineIndex: 1,
                      evidenceQuote: 'Rowan Donbry, finance director.',
                      confidence: 0.9,
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    };
  }

  it('posts a chat completion to the configured endpoint and parses the result', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const askModel = createSpeakerModel({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen3.8:27b',
      fetchImpl: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return okResponse();
      }) as unknown as typeof fetch,
    });

    const result = await askModel(request);

    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0].body.model).toBe('qwen3.8:27b');
    expect(result.assignments[0].name).toBe('Rowan Danbury');
  });

  it('tolerates a trailing slash on the configured base URL', async () => {
    const calls: string[] = [];
    const askModel = createSpeakerModel({
      baseURL: 'http://localhost:11434/v1/',
      apiKey: 'ollama',
      model: 'qwen3.8:27b',
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return okResponse();
      }) as unknown as typeof fetch,
    });

    await askModel(request);

    expect(calls[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('offers both tools, with assignment scoped to the unidentified speakers', async () => {
    let body:
      | {
          tools: Array<{
            function: {
              name: string;
              parameters: { properties: { speakerId: { enum: string[] } } };
            };
          }>;
        }
      | undefined;
    const askModel = createSpeakerModel({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen3.8:27b',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return okResponse();
      }) as unknown as typeof fetch,
    });

    await askModel({ ...request, unidentified: ['Speaker 2'] });

    expect(body?.tools.map((tool) => tool.function.name)).toEqual([
      'assign_speaker',
      'note_present_person',
    ]);
    expect(body?.tools[0].function.parameters.properties.speakerId.enum).toEqual(['Speaker 2']);
  });

  it('throws with the status when the endpoint rejects the request', async () => {
    const askModel = createSpeakerModel({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen3.8:27b',
      fetchImpl: (async () => ({
        ok: false,
        status: 503,
        text: async () => 'model not loaded',
      })) as unknown as typeof fetch,
    });

    await expect(askModel(request)).rejects.toThrow('503');
  });
});
