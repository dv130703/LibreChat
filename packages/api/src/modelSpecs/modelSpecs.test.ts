import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import {
  applyModelSpecPreset,
  findModelSpecByName,
  isModelSpecEndpointMatch,
  resolveModelSpecPromptPrefixVariables,
  sanitizeModelSpecs,
} from './index';

describe('modelSpecs helpers', () => {
  it('should strip private prompt fields from model spec presets', () => {
    const modelSpecs = {
      enforce: false,
      prioritize: true,
      list: [
        {
          name: 'guarded-spec',
          label: 'Guarded Spec',
          skills: ['private-skill'],
          subagents: { enabled: true, allowSelf: true, agent_ids: ['agent_private'] },
          preset: {
            endpoint: EModelEndpoint.custom,
            model: 'gpt-4o',
            promptPrefix: 'private prompt prefix',
            instructions: 'private assistant instructions',
            additional_instructions: 'private additional instructions',
            system: 'private bedrock system',
            context: 'private context',
            examples: [{ input: { content: 'a' }, output: { content: 'b' } }],
            greeting: 'Hello',
          },
        },
      ],
    };

    const sanitizedModelSpecs = sanitizeModelSpecs(modelSpecs);
    expect(sanitizedModelSpecs.list[0].subagents).toEqual({
      enabled: true,
      allowSelf: true,
    });
    expect(sanitizedModelSpecs.list[0].preset).toEqual({
      endpoint: EModelEndpoint.custom,
      model: 'gpt-4o',
      greeting: 'Hello',
    });
    expect(sanitizedModelSpecs.list[0]).not.toHaveProperty('skills');
  });

  it('should preserve conversation starters on model specs', () => {
    const modelSpecs = {
      enforce: false,
      prioritize: true,
      list: [
        {
          name: 'starter-spec',
          label: 'Starter Spec',
          conversation_starters: ['Summarize an article', 'Plan my week'],
          preset: {
            endpoint: EModelEndpoint.custom,
            model: 'gpt-4o',
            promptPrefix: 'private prompt prefix',
          },
        },
      ],
    };

    const sanitizedModelSpecs = sanitizeModelSpecs(modelSpecs);
    expect(sanitizedModelSpecs.list[0].conversation_starters).toEqual([
      'Summarize an article',
      'Plan my week',
    ]);
    expect(sanitizedModelSpecs.list[0].preset).not.toHaveProperty('promptPrefix');
  });

  it('should restore only private fields for non-enforced model specs', () => {
    const modelSpec: TModelSpec = {
      name: 'guarded-openai',
      label: 'Guarded OpenAI',
      iconURL: EModelEndpoint.custom,
      preset: {
        endpoint: EModelEndpoint.custom,
        model: 'gpt-4o',
        promptPrefix: 'private prompt prefix',
        instructions: 'private instructions',
        additional_instructions: 'private additional instructions',
        temperature: 0.2,
        maxContextTokens: 10000,
      },
    };

    const { parsedBody, appliedPrivateFields } = applyModelSpecPreset({
      modelSpec,
      parsedBody: {
        endpoint: EModelEndpoint.custom,
        spec: 'guarded-openai',
        model: 'gpt-4o',
        temperature: 0.8,
      },
      endpoint: EModelEndpoint.custom,
    });

    expect(parsedBody.promptPrefix).toBe('private prompt prefix');
    expect(parsedBody.instructions).toBeUndefined();
    expect(parsedBody.additional_instructions).toBeUndefined();
    expect(parsedBody.temperature).toBe(0.8);
    expect(parsedBody.maxContextTokens).toBeUndefined();
    expect(parsedBody.iconURL).toBe(EModelEndpoint.custom);
    expect(appliedPrivateFields.has('promptPrefix')).toBe(true);
  });

  it('should restore preset defaults when model specs are enforced', () => {
    const modelSpec: TModelSpec = {
      name: 'enforced-openai',
      label: 'Enforced OpenAI',
      preset: {
        endpoint: EModelEndpoint.custom,
        model: 'gpt-4o',
        promptPrefix: 'private prompt prefix',
        temperature: 0.2,
      },
    };

    const { parsedBody } = applyModelSpecPreset({
      modelSpec,
      parsedBody: {
        endpoint: EModelEndpoint.custom,
        spec: 'enforced-openai',
        model: 'client-model',
        temperature: 0.8,
        topP: 0.9,
        chatProjectId: 'project-1',
      },
      endpoint: EModelEndpoint.custom,
      includePresetDefaults: true,
    });

    expect(parsedBody.spec).toBe('enforced-openai');
    expect(parsedBody.model).toBe('gpt-4o');
    expect(parsedBody.promptPrefix).toBe('private prompt prefix');
    expect(parsedBody.temperature).toBe(0.2);
    expect(parsedBody.topP).toBeUndefined();
    expect(parsedBody.chatProjectId).toBe('project-1');
  });

  it('should restore a private preset field when the parser supplies an empty default', () => {
    const modelSpec: TModelSpec = {
      name: 'guarded-custom',
      label: 'Guarded Custom',
      preset: {
        endpoint: EModelEndpoint.custom,
        model: 'llama3',
        promptPrefix: 'private prompt prefix',
      },
    };

    const { parsedBody } = applyModelSpecPreset({
      modelSpec,
      parsedBody: {
        endpoint: EModelEndpoint.custom,
        spec: 'guarded-custom',
        model: 'llama3',
      },
      endpoint: EModelEndpoint.custom,
    });

    expect(parsedBody.promptPrefix).toBe('private prompt prefix');
  });

  it('should find specs and validate endpoint matches', () => {
    const modelSpec: TModelSpec = {
      name: 'guarded-openai',
      label: 'Guarded OpenAI',
      preset: {
        endpoint: EModelEndpoint.custom,
        model: 'gpt-4o',
      },
    };

    expect(findModelSpecByName({ list: [modelSpec] }, 'guarded-openai')).toBe(modelSpec);
    expect(isModelSpecEndpointMatch(modelSpec, EModelEndpoint.custom)).toBe(true);
    expect(isModelSpecEndpointMatch(modelSpec, 'google')).toBe(false);
  });

  it('should resolve special variables in model spec prompt prefixes', () => {
    expect(
      resolveModelSpecPromptPrefixVariables({ promptPrefix: 'Help {{current_user}}.' }, {
        name: 'Ada',
      } as never).promptPrefix,
    ).toBe('Help Ada.');
  });
});
