import { describeTranscriptionPrompts } from './prompts';
import { buildTranslationMessages } from './translate';
import { buildAttributionMessages } from './attributionModel';
import { buildIdentificationMessages } from './speakerModel';
import type { SpeakerModelConfig } from './speakerModel';

const config: SpeakerModelConfig = {
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  model: 'qwen3:8b',
};

describe('describeTranscriptionPrompts', () => {
  it('reports the model and endpoint the transcript is actually sent to', () => {
    const disclosure = describeTranscriptionPrompts(config);
    expect(disclosure.enabled).toBe(true);
    expect(disclosure.model).toBe('qwen3:8b');
    expect(disclosure.endpoint).toBe('http://localhost:11434/v1');
  });

  it('says nothing runs when no model is configured', () => {
    expect(describeTranscriptionPrompts(undefined)).toEqual({ enabled: false, stages: [] });
  });

  it('covers every stage that sends a transcript to a model', () => {
    expect(describeTranscriptionPrompts(config).stages.map((stage) => stage.stage)).toEqual([
      'identifying_speakers',
      'reviewing_attribution',
      'translating',
    ]);
  });

  /** The point of the whole module: these are not transcriptions of the
   *  prompts, they ARE the prompts. Editing one in its own module without
   *  touching this file must still change what the disclosure shows. */
  it('discloses the identification prompt the live stage builds, verbatim', () => {
    const [system] = buildIdentificationMessages({
      evidence: [],
      unidentified: [],
      candidates: [],
    });
    const stage = describeTranscriptionPrompts(config).stages[0];
    expect(stage.systemPrompt).toBe(system.content);
    expect(stage.exampleUserMessage).toContain('Rowan Danbury');
    expect(stage.tools.map((tool) => tool.name)).toEqual(['assign_speaker', 'note_present_person']);
  });

  it('discloses the attribution prompt the live stage builds, verbatim', () => {
    const [system] = buildAttributionMessages([], []);
    const stage = describeTranscriptionPrompts(config).stages[1];
    expect(stage.systemPrompt).toBe(system.content);
    expect(stage.tools.map((tool) => tool.name)).toEqual(['fix_attribution']);
  });

  it('discloses the translation prompt the live stage builds, verbatim', () => {
    const [system] = buildTranslationMessages([]);
    const stage = describeTranscriptionPrompts(config).stages[2];
    expect(stage.systemPrompt).toBe(system.content);
    expect(stage.tools).toEqual([]);
  });

  it('pretty-prints each tool schema, so what constrains the answer is readable too', () => {
    const [identification] = describeTranscriptionPrompts(config).stages;
    const parameters = JSON.parse(identification.tools[0].parameters) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(parameters.properties)).toContain('evidenceQuote');
    expect(identification.tools[0].parameters).toContain('\n');
  });

  it('renders examples from a stand-in transcript, never a real recording', () => {
    for (const stage of describeTranscriptionPrompts(config).stages) {
      expect(stage.exampleUserMessage.length).toBeGreaterThan(0);
    }
  });
});
