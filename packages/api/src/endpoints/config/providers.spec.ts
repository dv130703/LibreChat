import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getProviderConfig, resolveTitleTiming } from './providers';

const buildAppConfig = (
  customEndpoints: Array<{ name: string; baseURL?: string; apiKey?: string; provider?: string }>,
): AppConfig =>
  ({
    endpoints: {
      [EModelEndpoint.custom]: customEndpoints,
    },
  }) as unknown as AppConfig;

describe('getProviderConfig', () => {
  it('falls back case-insensitively when only a CamelCase match exists', () => {
    // Agent runtime resolved provider to lowercase `"ollama"`, but the
    // user's `librechat.yaml` declared `name: "Ollama"`.
    const appConfig = buildAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' },
    ]);

    const result = getProviderConfig({ provider: 'ollama', appConfig });

    expect(result.overrideProvider).toBe(Providers.OPENAI);
    expect(result.customEndpointConfig?.name).toBe('Ollama');
  });

  it('prefers the exact-case match when both casings exist (preserves case-sensitive identity)', () => {
    // Two distinct custom endpoints differing only in case is supported by
    // `loadCustomEndpointsConfig` (the keys are case-preserving). Direct
    // exact-case lookup should win — case-insensitive fallback must not
    // shadow the user's intent.
    const appConfig = buildAppConfig([
      { name: 'Ollama', baseURL: 'https://prod.example/v1', apiKey: 'prod' },
      { name: 'ollama', baseURL: 'https://staging.example/v1', apiKey: 'staging' },
    ]);

    const result = getProviderConfig({ provider: 'ollama', appConfig });

    expect(result.customEndpointConfig?.baseURL).toBe('https://staging.example/v1');
  });

  it('resolves an exact-case lowercase entry', () => {
    const appConfig = buildAppConfig([
      { name: 'ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' },
    ]);

    const result = getProviderConfig({ provider: 'ollama', appConfig });

    expect(result.customEndpointConfig?.name).toBe('ollama');
  });

  it('throws on ambiguous case-insensitive matches when no exact-case entry exists (codex review)', () => {
    // User has two distinct entries differing only in case, both
    // non-lowercase. The agent runtime resolves provider to lowercase
    // "ollama" — neither matches case-sensitively, and silently picking
    // array-first could route requests to the wrong baseURL/apiKey.
    const appConfig = buildAppConfig([
      { name: 'Ollama', baseURL: 'https://prod.example/v1', apiKey: 'prod' },
      { name: 'OLLAMA', baseURL: 'https://canary.example/v1', apiKey: 'canary' },
    ]);

    expect(() => getProviderConfig({ provider: 'ollama', appConfig })).toThrow(
      /ambiguous.*Ollama.*OLLAMA/i,
    );
  });

  it('throws when a provider has no matching custom endpoint at all', () => {
    expect(() =>
      getProviderConfig({ provider: 'ollama', appConfig: buildAppConfig([]) }),
    ).toThrow('Provider ollama not supported');
  });

  it('resolves a custom endpoint to the OpenAI-compatible client', () => {
    const appConfig = buildAppConfig([
      { name: 'My-LLM', baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' },
    ]);

    const result = getProviderConfig({ provider: 'My-LLM', appConfig });

    expect(result.overrideProvider).toBe(Providers.OPENAI);
    expect(result.customEndpointConfig?.name).toBe('My-LLM');
  });
});

describe('resolveTitleTiming', () => {
  const withEndpoints = (endpoints: Record<string, unknown>): AppConfig =>
    ({ endpoints }) as unknown as AppConfig;

  it("defaults to 'immediate' when no config is provided", () => {
    expect(resolveTitleTiming({})).toBe('immediate');
  });

  it("defaults to 'immediate' when endpoints is missing", () => {
    expect(resolveTitleTiming({ appConfig: {} as AppConfig })).toBe('immediate');
  });

  it("defaults to 'immediate' when no titleTiming is set", () => {
    const appConfig = withEndpoints({ [EModelEndpoint.agents]: { titleConvo: true } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('immediate');
  });

  it("returns 'final' from the global `all` config", () => {
    const appConfig = withEndpoints({ all: { titleTiming: 'final' } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('final');
  });

  it("returns 'final' from the per-endpoint config when `all` is unset", () => {
    const appConfig = withEndpoints({ [EModelEndpoint.agents]: { titleTiming: 'final' } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('final');
  });

  it('lets `all` take precedence over the per-endpoint value', () => {
    const appConfig = withEndpoints({
      all: { titleTiming: 'immediate' },
      [EModelEndpoint.agents]: { titleTiming: 'final' },
    });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('immediate');
  });

  it('does not let unrelated `all` config block a per-endpoint value', () => {
    const appConfig = withEndpoints({
      all: { titleConvo: true },
      [EModelEndpoint.agents]: { titleTiming: 'final' },
    });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('final');
  });

  it('checks endpoint candidates in order before provider fallback', () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.agents]: { titleTiming: 'final' },
      [EModelEndpoint.custom]: { titleTiming: 'immediate' },
    });
    expect(
      resolveTitleTiming({
        appConfig,
        endpoint: [EModelEndpoint.agents, EModelEndpoint.custom],
      }),
    ).toBe('final');
  });

  it('falls back to backing provider timing when agents has no titleTiming', () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.agents]: { titleConvo: true },
      [EModelEndpoint.custom]: { titleTiming: 'final' },
    });
    expect(
      resolveTitleTiming({
        appConfig,
        endpoint: [EModelEndpoint.agents, EModelEndpoint.custom],
      }),
    ).toBe('final');
  });

  it("returns 'immediate' for an endpoint with no override and no `all`", () => {
    const appConfig = withEndpoints({ [EModelEndpoint.custom]: { titleTiming: 'final' } });
    expect(resolveTitleTiming({ appConfig, endpoint: EModelEndpoint.agents })).toBe('immediate');
  });

  it("resolves 'final' from a custom endpoint config (endpoints.custom[])", () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.custom]: [{ name: 'MyProvider', titleTiming: 'final' }],
    });
    expect(resolveTitleTiming({ appConfig, endpoint: 'MyProvider' })).toBe('final');
  });

  it('resolves a normalized custom provider name (ollama -> Ollama)', () => {
    const appConfig = withEndpoints({
      [EModelEndpoint.custom]: [
        { name: 'Ollama', baseURL: 'http://localhost:11434/v1', titleTiming: 'final' },
      ],
    });
    expect(resolveTitleTiming({ appConfig, endpoint: 'ollama' })).toBe('final');
  });
});
