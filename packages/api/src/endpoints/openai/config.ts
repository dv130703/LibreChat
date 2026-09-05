import { Agent } from 'undici';
import { Providers } from '@librechat/agents';
import { KnownEndpoints, ReasoningParameterFormat } from 'librechat-data-provider';
import type { Dispatcher } from 'undici';
import type * as t from '~/types';
import { createSSRFSafeAgents, createSSRFSafeUndiciConnect } from '~/auth';
import { getOpenAILLMConfig, extractDefaultParams } from './llm';
import { getProxyDispatcher } from '~/utils/proxy';
import { createFetch } from '~/utils/generators';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchOptions = RequestInit & { dispatcher?: Dispatcher };
type OpenAIConfiguration = NonNullable<t.OpenAIConfiguration>;

const OPENROUTER_DEFAULT_PARAMS = { promptCache: true };

function includesOpenRouter(value?: string | null): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(KnownEndpoints.openrouter);
}

function getDefaultParams({
  customDefaultParams,
  useOpenRouter,
}: {
  customDefaultParams?: Record<string, unknown>;
  useOpenRouter: boolean;
}): Record<string, unknown> | undefined {
  if (!useOpenRouter) {
    return customDefaultParams;
  }

  return {
    ...OPENROUTER_DEFAULT_PARAMS,
    ...customDefaultParams,
  };
}

function getReasoningFormat({
  customFormat,
  isVercel,
}: {
  customFormat?: ReasoningParameterFormat;
  isVercel: boolean;
}): ReasoningParameterFormat | undefined {
  if (customFormat) {
    return customFormat;
  }
  if (isVercel) {
    return ReasoningParameterFormat.reasoningObject;
  }
  return undefined;
}

function getEffectiveURLPort(baseURL: string): string | null {
  try {
    const parsed = new URL(baseURL);
    if (parsed.port) {
      return parsed.port;
    }
    if (parsed.protocol === 'http:') {
      return '80';
    }
    if (parsed.protocol === 'https:') {
      return '443';
    }
  } catch {
    return null;
  }

  return null;
}

function mergeFetchOptions(configOptions: OpenAIConfiguration, options: FetchOptions): void {
  const currentOptions = (configOptions.fetchOptions ?? {}) as FetchOptions;
  configOptions.fetchOptions = {
    ...currentOptions,
    ...options,
  } as OpenAIConfiguration['fetchOptions'];
}

/**
 * Generates configuration options for creating a language model (LLM) instance.
 * @param apiKey - The API key for authentication.
 * @param options - Additional options for configuring the LLM.
 * @param endpoint - The endpoint name
 * @returns Configuration options for creating an LLM instance.
 */
export function getOpenAIConfig(
  apiKey: string,
  options: t.OpenAIConfigOptions = {},
  endpoint?: string | null,
): t.OpenAIConfigResult {
  const {
    proxy,
    addParams,
    dropParams,
    defaultQuery,
    directEndpoint,
    streaming = true,
    modelOptions = {},
    reverseProxyUrl: baseURL,
  } = options;
  const shouldProtectUserBaseURL = options.baseURLIsUserProvided === true && !!baseURL;
  const ssrfAgents = shouldProtectUserBaseURL
    ? createSSRFSafeAgents(options.allowedAddresses)
    : undefined;

  let llmConfig: t.OAIClientOptions;
  let tools: t.LLMConfigResult['tools'];
  const isOpenRouter = options.customParams?.defaultParamsEndpoint === KnownEndpoints.openrouter;

  const useOpenRouter = isOpenRouter || includesOpenRouter(baseURL) || includesOpenRouter(endpoint);
  const isVercel =
    (baseURL && baseURL.includes('ai-gateway.vercel.sh')) ||
    (endpoint != null && endpoint.toLowerCase().includes(KnownEndpoints.vercel));
  const defaultParams = getDefaultParams({
    customDefaultParams: extractDefaultParams(options.customParams?.paramDefinitions),
    useOpenRouter: Boolean(useOpenRouter),
  });

  const headers = options.headers;
  const openaiResult = getOpenAILLMConfig({
    apiKey,
    baseURL,
    endpoint,
    streaming,
    addParams,
    dropParams,
    defaultParams,
    modelOptions,
    useOpenRouter,
    reasoningFormat: getReasoningFormat({
      customFormat: options.customParams?.reasoningFormat,
      isVercel: Boolean(isVercel),
    }),
  });
  llmConfig = openaiResult.llmConfig;
  tools = openaiResult.tools;

  /**
   * Within-run `reasoning_content` replay applies across the OpenAI-compatible
   * client. `includeReasoningHistory` implies it, since reconstructed history
   * reasoning is only sent when the within-run flag is set.
   */
  if (
    options.customParams?.includeReasoningContent === true ||
    options.customParams?.includeReasoningHistory === true
  ) {
    llmConfig.includeReasoningContent = true;
  }

  const configOptions: t.OpenAIConfiguration = {};
  if (baseURL) {
    configOptions.baseURL = baseURL;
  }
  if (useOpenRouter || isVercel) {
    configOptions.defaultHeaders = Object.assign(
      {
        'HTTP-Referer': 'https://librechat.ai',
        'X-Title': 'LibreChat',
        'X-OpenRouter-Title': 'LibreChat',
        'X-OpenRouter-Categories': 'general-chat,personal-agent',
      },
      headers,
    );
  } else if (headers) {
    configOptions.defaultHeaders = headers;
  }

  if (defaultQuery) {
    configOptions.defaultQuery = defaultQuery;
  }

  if (shouldProtectUserBaseURL) {
    mergeFetchOptions(configOptions, {
      dispatcher: new Agent({
        connect: createSSRFSafeUndiciConnect(
          options.allowedAddresses,
          getEffectiveURLPort(baseURL),
        ),
      }),
      redirect: 'error',
    });
  }

  const proxyDispatcher = getProxyDispatcher(proxy);
  if (proxyDispatcher && !shouldProtectUserBaseURL) {
    mergeFetchOptions(configOptions, { dispatcher: proxyDispatcher });
  }

  if (process.env.OPENAI_ORGANIZATION) {
    configOptions.organization = process.env.OPENAI_ORGANIZATION;
  }

  if (directEndpoint === true && configOptions?.baseURL != null) {
    configOptions.fetch = createFetch({
      directEndpoint: directEndpoint,
      reverseProxyUrl: configOptions?.baseURL,
      ssrfAgents,
      redirect: shouldProtectUserBaseURL ? 'error' : undefined,
    }) as unknown as Fetch;
  }

  const result: t.OpenAIConfigResult = {
    llmConfig,
    configOptions,
    tools,
  };
  if (useOpenRouter) {
    result.provider = Providers.OPENROUTER;
  }
  return result;
}
