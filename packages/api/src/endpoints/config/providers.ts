import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { BaseInitializeParams, InitializeResultBase } from '~/types';
import { initializeCustom } from '../custom/initialize';
import { getCustomEndpointConfig } from '~/app/config';

/**
 * Type for initialize functions
 */
export type InitializeFn = (params: BaseInitializeParams) => Promise<InitializeResultBase>;

export type TitleTiming = 'immediate' | 'final';

/**
 * Resolves when conversation titles are generated for a given endpoint.
 *
 * `endpoints.all.titleTiming`, when present, is the global override. Otherwise,
 * endpoint candidates are checked in order so the public endpoint (for example
 * `agents`) can override the backing provider, with provider/custom config used
 * as a fallback. Resolving custom providers via `getProviderConfig` picks up its
 * case-insensitive fallback for normalized provider names (e.g. `openrouter` →
 * `OpenRouter`). Defaults to `immediate`.
 */
export function resolveTitleTiming({
  appConfig,
  endpoint,
}: {
  appConfig?: AppConfig;
  endpoint?: string | Array<string | undefined>;
}): TitleTiming {
  const endpoints = appConfig?.endpoints;
  const resolveConfiguredTiming = (config?: Partial<TEndpoint>): TitleTiming | undefined =>
    config?.titleTiming === 'final' || config?.titleTiming === 'immediate'
      ? config.titleTiming
      : undefined;

  const globalTiming = resolveConfiguredTiming(endpoints?.all);
  if (globalTiming) {
    return globalTiming;
  }

  const endpointCandidates = (Array.isArray(endpoint) ? endpoint : [endpoint]).filter(
    (value): value is string => !!value,
  );

  for (const endpointCandidate of endpointCandidates) {
    const endpointConfig = endpoints?.[endpointCandidate as keyof NonNullable<typeof endpoints>] as
      | Partial<TEndpoint>
      | undefined;
    const endpointTiming = resolveConfiguredTiming(endpointConfig);
    if (endpointTiming) {
      return endpointTiming;
    }
  }

  for (const endpointCandidate of endpointCandidates) {
    if (!appConfig) {
      continue;
    }
    try {
      const providerTiming = resolveConfiguredTiming(
        getProviderConfig({ provider: endpointCandidate, appConfig }).customEndpointConfig,
      );
      if (providerTiming) {
        return providerTiming;
      }
    } catch {
      // Unsupported providers fall back to the default timing.
    }
  }

  return 'immediate';
}

/**
 * Result from getProviderConfig
 */
export interface ProviderConfigResult {
  /** The initialization function for this provider */
  getOptions: InitializeFn;
  /** The resolved provider name (may be different from input if normalized) */
  overrideProvider: string;
  /** Custom endpoint configuration (if applicable) */
  customEndpointConfig?: Partial<TEndpoint>;
}

/**
 * Get the provider configuration and override endpoint based on the provider string
 *
 * @param params - Configuration parameters
 * @param params.provider - The provider string
 * @param params.appConfig - The application configuration
 * @returns Provider configuration including getOptions function, override provider, and custom config
 * @throws Error if provider is not supported
 */
export function getProviderConfig({
  provider,
  appConfig,
}: {
  provider: string;
  appConfig?: AppConfig;
}): ProviderConfigResult {
  let customEndpointConfig = getCustomEndpointConfig({ endpoint: provider, appConfig });

  if (!customEndpointConfig && appConfig) {
    /**
     * Case-insensitive fallback.
     *
     * The agent main flow looks up custom endpoints case-sensitively
     * (case-preserving keys are how `loadCustomEndpointsConfig` lets users
     * have e.g. `"Ollama"` and `"ollama-staging"` as distinct entries).
     * After it succeeds, `agent.provider` is normalized to lowercase
     * (e.g. `"ollama"`). Downstream resolvers (summarization, title)
     * re-enter `getProviderConfig` with that lowercase value, and the
     * case-sensitive direct lookup above misses configs whose `name` is
     * capitalized — the shape our own default Ollama entry ships as.
     *
     * Only fall back when the direct lookup already failed, so users with
     * case-sensitive endpoint identity are unaffected — their exact-case
     * match wins first. When multiple case-insensitive matches exist
     * (e.g. both `Ollama` and `OLLAMA`, neither lowercase), refuse to
     * silently pick array-first; the caller's intent is ambiguous and
     * either entry could route requests with a different baseURL/apiKey.
     */
    const customEndpoints = appConfig.endpoints?.[EModelEndpoint.custom] ?? [];
    const target = provider.toLowerCase();
    const matches = customEndpoints.filter(
      (endpointConfig) => (endpointConfig.name ?? '').toLowerCase() === target,
    );
    if (matches.length > 1) {
      const names = matches.map((m) => m.name ?? '').join(', ');
      throw new Error(
        `Provider ${provider} is ambiguous: multiple custom endpoints match case-insensitively (${names}). Rename one or use the exact-case provider value.`,
      );
    }
    customEndpointConfig = matches[0];
  }

  if (!customEndpointConfig) {
    throw new Error(`Provider ${provider} not supported`);
  }

  return {
    getOptions: initializeCustom,
    overrideProvider: Providers.OPENAI,
    customEndpointConfig,
  };
}
