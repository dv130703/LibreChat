import {
  OCRStrategy,
  FileSources,
  EModelEndpoint,
  EImageOutputType,
  AgentCapabilities,
  defaultSocialLogins,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { FunctionTool } from '@librechat/data-schemas';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { AppService } from '@librechat/data-schemas';

/** Default agent capabilities served when no `memory` block is configured —
 *  `AppService` strips `memory` from the defaults since the capability is inert
 *  without a memory config. */
const defaultAgentCapabilitiesWithoutMemory = defaultAgentCapabilities.filter(
  (capability) => capability !== AgentCapabilities.memory,
);

describe('AppService', () => {
  const mockSystemTools: Record<string, FunctionTool> = {
    ExampleTool: {
      type: 'function',
      function: {
        description: 'Example tool function',
        name: 'exampleFunction',
        parameters: {
          type: 'object',
          properties: {
            param1: { type: 'string', description: 'An example parameter' },
          },
          required: ['param1'],
        },
      },
    },
  };

  beforeEach(() => {
    process.env.CDN_PROVIDER = undefined;
    jest.clearAllMocks();
  });

  it('should correctly assign process.env and initialize app config based on custom config', async () => {
    const config: Partial<TCustomConfig> = {
      registration: { socialLogins: ['testLogin'] },
      fileStrategy: FileSources.s3,
      balance: {
        enabled: true,
      },
    };

    const result = await AppService({ config, systemTools: mockSystemTools });

    expect(process.env.CDN_PROVIDER).toEqual('s3');

    expect(result).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          fileStrategy: 's3',
        }),
        registration: expect.objectContaining({
          socialLogins: ['testLogin'],
        }),
        fileStrategy: 's3',
        interfaceConfig: expect.objectContaining({
          modelSelect: true,
          parameters: true,
          presets: true,
        }),
        mcpConfig: null,
        imageOutputType: expect.any(String),
        fileConfig: undefined,
        secureImageLinks: undefined,
        balance: { enabled: true },
        filteredTools: undefined,
        includedTools: undefined,
        webSearch: expect.objectContaining({
          safeSearch: 1,
          jinaApiKey: '${JINA_API_KEY}',
          jinaApiUrl: '${JINA_API_URL}',
          cohereApiKey: '${COHERE_API_KEY}',
          serperApiKey: '${SERPER_API_KEY}',
          searxngApiKey: '${SEARXNG_API_KEY}',
          firecrawlApiKey: '${FIRECRAWL_API_KEY}',
          firecrawlApiUrl: '${FIRECRAWL_API_URL}',
          searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
        }),
        memory: undefined,
        endpoints: expect.objectContaining({
          agents: expect.objectContaining({
            disableBuilder: false,
            capabilities: expect.arrayContaining([...defaultAgentCapabilitiesWithoutMemory]),
            maxCitations: 30,
            maxCitationsPerFile: 7,
            minRelevanceScore: 0.45,
          }),
        }),
      }),
    );
  });

  it('should change the `imageOutputType` based on config value', async () => {
    const config = {
      version: '0.10.0',
      imageOutputType: EImageOutputType.WEBP,
    };

    const result = await AppService({ config });
    expect(result).toEqual(
      expect.objectContaining({
        imageOutputType: EImageOutputType.WEBP,
      }),
    );
  });

  it('should default to `PNG` `imageOutputType` with no provided type', async () => {
    const config = {
      version: '0.10.0',
    };

    const result = await AppService({ config });
    expect(result).toEqual(
      expect.objectContaining({
        imageOutputType: EImageOutputType.PNG,
      }),
    );
  });

  it('should default to `PNG` `imageOutputType` with no provided config', async () => {
    const config = {};

    const result = await AppService({ config });
    expect(result).toEqual(
      expect.objectContaining({
        imageOutputType: EImageOutputType.PNG,
      }),
    );
  });

  it('should enable summarization when it is configured without enabled flag', async () => {
    const config = {
      summarization: {
        prompt: 'Summarize with emphasis on next actions',
      },
    } as Partial<TCustomConfig> & { summarization: Record<string, unknown> };

    const result = await AppService({ config });
    expect(result).toEqual(
      expect.objectContaining({
        summarization: expect.objectContaining({
          enabled: true,
          prompt: 'Summarize with emphasis on next actions',
        }),
      }),
    );
  });

  it('should preserve explicit summarization disable flag', async () => {
    const config = {
      summarization: {
        enabled: false,
        prompt: 'Ignored while disabled',
      },
    } as Partial<TCustomConfig> & { summarization: Record<string, unknown> };

    const result = await AppService({ config });
    expect(result).toEqual(
      expect.objectContaining({
        summarization: expect.objectContaining({
          enabled: false,
          prompt: 'Ignored while disabled',
        }),
      }),
    );
  });

  it('should load and format tools accurately with defined structure', async () => {
    const config = {};

    const result = await AppService({ config, systemTools: mockSystemTools });

    // Verify tools are included in the returned config
    expect(result.availableTools).toBeDefined();
    expect(result.availableTools?.ExampleTool).toEqual({
      type: 'function',
      function: {
        description: 'Example tool function',
        name: 'exampleFunction',
        parameters: {
          type: 'object',
          properties: {
            param1: { type: 'string', description: 'An example parameter' },
          },
          required: ['param1'],
        },
      },
    });
  });

  it('should correctly configure Agents endpoint based on custom config', async () => {
    const config: Partial<TCustomConfig> = {
      endpoints: {
        [EModelEndpoint.agents]: {
          disableBuilder: true,
          recursionLimit: 10,
          maxRecursionLimit: 20,
          allowedProviders: ['openai', 'anthropic'],
          capabilities: [AgentCapabilities.tools, AgentCapabilities.actions],
        },
      },
    };

    const result = await AppService({ config });

    expect(result).toEqual(
      expect.objectContaining({
        endpoints: expect.objectContaining({
          [EModelEndpoint.agents]: expect.objectContaining({
            disableBuilder: true,
            recursionLimit: 10,
            maxRecursionLimit: 20,
            allowedProviders: expect.arrayContaining(['openai', 'anthropic']),
            capabilities: expect.arrayContaining([
              AgentCapabilities.tools,
              AgentCapabilities.actions,
            ]),
          }),
        }),
      }),
    );
  });

  it('should configure Agents endpoint with defaults when no config is provided', async () => {
    const config = {};

    const result = await AppService({ config });

    expect(result).toEqual(
      expect.objectContaining({
        endpoints: expect.objectContaining({
          [EModelEndpoint.agents]: expect.objectContaining({
            disableBuilder: false,
            capabilities: expect.arrayContaining([...defaultAgentCapabilitiesWithoutMemory]),
          }),
        }),
      }),
    );
  });

  it('should not modify FILE_UPLOAD environment variables without rate limits', async () => {
    // Setup initial environment variables
    process.env.FILE_UPLOAD_IP_MAX = '10';
    process.env.FILE_UPLOAD_IP_WINDOW = '15';
    process.env.FILE_UPLOAD_USER_MAX = '5';
    process.env.FILE_UPLOAD_USER_WINDOW = '20';

    const initialEnv = { ...process.env };
    const config = {};

    await AppService({ config });

    // Expect environment variables to remain unchanged
    expect(process.env.FILE_UPLOAD_IP_MAX).toEqual(initialEnv.FILE_UPLOAD_IP_MAX);
    expect(process.env.FILE_UPLOAD_IP_WINDOW).toEqual(initialEnv.FILE_UPLOAD_IP_WINDOW);
    expect(process.env.FILE_UPLOAD_USER_MAX).toEqual(initialEnv.FILE_UPLOAD_USER_MAX);
    expect(process.env.FILE_UPLOAD_USER_WINDOW).toEqual(initialEnv.FILE_UPLOAD_USER_WINDOW);
  });

  it('should fallback to default FILE_UPLOAD environment variables when rate limits are unspecified', async () => {
    // Setup initial environment variables to non-default values
    process.env.FILE_UPLOAD_IP_MAX = 'initialMax';
    process.env.FILE_UPLOAD_IP_WINDOW = 'initialWindow';
    process.env.FILE_UPLOAD_USER_MAX = 'initialUserMax';
    process.env.FILE_UPLOAD_USER_WINDOW = 'initialUserWindow';
    const config = {};

    await AppService({ config });

    // Verify that process.env falls back to the initial values
    expect(process.env.FILE_UPLOAD_IP_MAX).toEqual('initialMax');
    expect(process.env.FILE_UPLOAD_IP_WINDOW).toEqual('initialWindow');
    expect(process.env.FILE_UPLOAD_USER_MAX).toEqual('initialUserMax');
    expect(process.env.FILE_UPLOAD_USER_WINDOW).toEqual('initialUserWindow');
  });

  it('should not modify IMPORT environment variables without rate limits', async () => {
    // Setup initial environment variables
    process.env.IMPORT_IP_MAX = '10';
    process.env.IMPORT_IP_WINDOW = '15';
    process.env.IMPORT_USER_MAX = '5';
    process.env.IMPORT_USER_WINDOW = '20';

    const initialEnv = { ...process.env };
    const config = {};

    await AppService({ config });

    // Expect environment variables to remain unchanged
    expect(process.env.IMPORT_IP_MAX).toEqual(initialEnv.IMPORT_IP_MAX);
    expect(process.env.IMPORT_IP_WINDOW).toEqual(initialEnv.IMPORT_IP_WINDOW);
    expect(process.env.IMPORT_USER_MAX).toEqual(initialEnv.IMPORT_USER_MAX);
    expect(process.env.IMPORT_USER_WINDOW).toEqual(initialEnv.IMPORT_USER_WINDOW);
  });

  it('should fallback to default IMPORT environment variables when rate limits are unspecified', async () => {
    // Setup initial environment variables to non-default values
    process.env.IMPORT_IP_MAX = 'initialMax';
    process.env.IMPORT_IP_WINDOW = 'initialWindow';
    process.env.IMPORT_USER_MAX = 'initialUserMax';
    process.env.IMPORT_USER_WINDOW = 'initialUserWindow';
    const config = {};

    await AppService({ config });

    // Verify that process.env falls back to the initial values
    expect(process.env.IMPORT_IP_MAX).toEqual('initialMax');
    expect(process.env.IMPORT_IP_WINDOW).toEqual('initialWindow');
    expect(process.env.IMPORT_USER_MAX).toEqual('initialUserMax');
    expect(process.env.IMPORT_USER_WINDOW).toEqual('initialUserWindow');
  });

  it('should configure Agent endpoint with title generation settings', async () => {
    const config: Partial<TCustomConfig> = {
      endpoints: {
        [EModelEndpoint.agents]: {
          disableBuilder: false,
          titleConvo: true,
          titleModel: 'gpt-4',
          titleMethod: 'structured',
          titlePrompt: 'Generate a descriptive title for this agent conversation',
          titlePromptTemplate: 'Agent conversation summary: {{content}}',
          recursionLimit: 15,
          capabilities: [AgentCapabilities.tools, AgentCapabilities.actions],
          maxCitations: 30,
          maxCitationsPerFile: 7,
          minRelevanceScore: 0.45,
        },
      },
    };

    const result = await AppService({ config });

    expect(result).toEqual(
      expect.objectContaining({
        endpoints: expect.objectContaining({
          [EModelEndpoint.agents]: expect.objectContaining({
            disableBuilder: false,
            titleConvo: true,
            titleModel: 'gpt-4',
            titleMethod: 'structured',
            titlePrompt: 'Generate a descriptive title for this agent conversation',
            titlePromptTemplate: 'Agent conversation summary: {{content}}',
            recursionLimit: 15,
            capabilities: expect.arrayContaining([
              AgentCapabilities.tools,
              AgentCapabilities.actions,
            ]),
          }),
        }),
      }),
    );
  });

  it('should correctly configure titleEndpoint when specified for Agents', async () => {
    const config: Partial<TCustomConfig> = {
      endpoints: {
        [EModelEndpoint.agents]: {
          disableBuilder: false,
          capabilities: [AgentCapabilities.tools],
          maxCitations: 30,
          maxCitationsPerFile: 7,
          minRelevanceScore: 0.45,
          titleEndpoint: 'custom-provider',
          titleMethod: 'structured',
        },
      },
    };

    const result = await AppService({ config });

    expect(result).toEqual(
      expect.objectContaining({
        endpoints: expect.objectContaining({
          [EModelEndpoint.agents]: expect.objectContaining({
            titleEndpoint: 'custom-provider',
            titleMethod: 'structured',
          }),
        }),
      }),
    );
  });

  it('should correctly configure all endpoint when specified', async () => {
    const config: Partial<TCustomConfig> = {
      endpoints: {
        all: {
          titleConvo: true,
          titleModel: 'gpt-4o-mini',
          titleMethod: 'structured',
          titlePrompt: 'Default title prompt for all endpoints',
          titlePromptTemplate: 'Default template: {{conversation}}',
          titleEndpoint: 'custom-provider',
          streamRate: 50,
        },
      },
    };

    const result = await AppService({ config });

    expect(result).toEqual(
      expect.objectContaining({
        // Check that 'all' endpoint config is loaded
        endpoints: expect.objectContaining({
          all: expect.objectContaining({
            titleConvo: true,
            titleModel: 'gpt-4o-mini',
            titleMethod: 'structured',
            titlePrompt: 'Default title prompt for all endpoints',
            titlePromptTemplate: 'Default template: {{conversation}}',
            titleEndpoint: 'custom-provider',
            streamRate: 50,
          }),
        }),
      }),
    );
  });
});

describe('AppService updating app config and issuing warnings', () => {
  let initialEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store initial environment variables to restore them after each test
    initialEnv = { ...process.env };

    process.env.CDN_PROVIDER = undefined;
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore initial environment variables
    process.env = { ...initialEnv };
  });

  it('should initialize app config with default values if config is empty', async () => {
    const config = {};

    const result = await AppService({ config });

    expect(result).toEqual(
      expect.objectContaining({
        config: {},
        fileStrategy: FileSources.local,
        registration: expect.objectContaining({
          socialLogins: defaultSocialLogins,
        }),
        balance: expect.objectContaining({
          enabled: false,
          startBalance: undefined,
        }),
      }),
    );
  });

  it('should initialize app config with values from config', async () => {
    // Mock loadCustomConfig to return a specific config object with a complete balance config
    const config: Partial<TCustomConfig> = {
      fileStrategy: FileSources.firebase,
      registration: { socialLogins: ['testLogin'] },
      balance: {
        enabled: false,
        startBalance: 5000,
        autoRefillEnabled: true,
        refillIntervalValue: 15,
        refillIntervalUnit: 'hours',
        refillAmount: 5000,
      },
    };

    const result = await AppService({ config });

    expect(result).toEqual(
      expect.objectContaining({
        config,
        fileStrategy: config.fileStrategy,
        registration: expect.objectContaining({
          socialLogins: config.registration?.socialLogins,
        }),
        balance: config.balance,
      }),
    );
  });

  it('should not parse environment variable references in OCR config', async () => {
    // Mock custom configuration with env variable references in OCR config
    const config: Partial<TCustomConfig> = {
      ocr: {
        apiKey: '${OCR_API_KEY_CUSTOM_VAR_NAME}',
        baseURL: '${OCR_BASEURL_CUSTOM_VAR_NAME}',
        strategy: OCRStrategy.MISTRAL_OCR,
        mistralModel: 'mistral-medium',
      },
    };

    // Set actual environment variables with different values
    process.env.OCR_API_KEY_CUSTOM_VAR_NAME = 'actual-api-key';
    process.env.OCR_BASEURL_CUSTOM_VAR_NAME = 'https://actual-ocr-url.com';

    const result = await AppService({ config });

    // Verify that the raw string references were preserved and not interpolated
    expect(result).toEqual(
      expect.objectContaining({
        ocr: expect.objectContaining({
          apiKey: '${OCR_API_KEY_CUSTOM_VAR_NAME}',
          baseURL: '${OCR_BASEURL_CUSTOM_VAR_NAME}',
          strategy: 'mistral_ocr',
          mistralModel: 'mistral-medium',
        }),
      }),
    );
  });

  it('should correctly configure peoplePicker permissions when specified', async () => {
    const config = {
      interface: {
        peoplePicker: {
          users: true,
          groups: true,
          roles: true,
        },
      },
    };

    const result = await AppService({ config });

    // Check that interface config includes the permissions
    expect(result).toEqual(
      expect.objectContaining({
        interfaceConfig: expect.objectContaining({
          peoplePicker: expect.objectContaining({
            users: true,
            groups: true,
            roles: true,
          }),
        }),
      }),
    );
  });
});
