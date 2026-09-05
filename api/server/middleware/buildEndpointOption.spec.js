/**
 * Wrap parseCompactConvo: the REAL function runs, but jest can observe
 * calls and return values. Must be declared before require('./buildEndpointOption')
 * so the destructured reference in the middleware captures the wrapper.
 */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    parseCompactConvo: jest.fn((...args) => actual.parseCompactConvo(...args)),
  };
});

const { EModelEndpoint, parseCompactConvo } = require('librechat-data-provider');

const mockAgentBuildOptions = jest.fn((_req, endpoint, parsedBody) => ({
  ...parsedBody,
  endpoint,
}));

jest.mock('~/server/services/Endpoints/agents', () => ({
  buildOptions: mockAgentBuildOptions,
}));

const mockGetEndpointsConfig = jest.fn();
jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: (...args) => mockGetEndpointsConfig(...args),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  handleError: jest.fn(),
}));

const buildEndpointOption = require('./buildEndpointOption');

const createReq = (body, config = {}) => ({
  body,
  config,
  baseUrl: '/api/chat',
});

const createRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('buildEndpointOption - defaultParamsEndpoint parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should strip maxOutputTokens when no defaultParamsEndpoint is configured', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      MyOpenRouter: {
        type: EModelEndpoint.custom,
      },
    });

    const req = createReq(
      {
        endpoint: 'MyOpenRouter',
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        maxOutputTokens: 8192,
        max_tokens: 4096,
      },
      { modelSpecs: null },
    );

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(parseCompactConvo).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultParamsEndpoint: undefined,
      }),
    );

    const parsedResult = parseCompactConvo.mock.results[0].value;
    expect(parsedResult.maxOutputTokens).toBeUndefined();
    expect(parsedResult.max_tokens).toBe(4096);
    expect(parsedResult.temperature).toBe(0.7);
  });

  it('should strip bedrock region from custom endpoint without defaultParamsEndpoint', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      MyEndpoint: {
        type: EModelEndpoint.custom,
      },
    });

    const req = createReq(
      {
        endpoint: 'MyEndpoint',
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        region: 'us-east-1',
      },
      { modelSpecs: null },
    );

    await buildEndpointOption(req, createRes(), jest.fn());

    const parsedResult = parseCompactConvo.mock.results[0].value;
    expect(parsedResult.region).toBeUndefined();
    expect(parsedResult.temperature).toBe(0.7);
  });

  it('should rebuild enforced custom specs from the backend preset when compact parsing drops raw fields', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const modelSpec = {
      name: 'approved-custom',
      preset: {
        endpoint: 'Mock Provider A',
        endpointType: EModelEndpoint.custom,
        model: 'mock-model-a',
        promptPrefix: 'Use the approved custom model spec.',
      },
    };

    const req = createReq(
      {
        endpoint: 'Mock Provider A',
        endpointType: EModelEndpoint.custom,
        spec: 'approved-custom',
        model: { stale: 'cached-client-value' },
        agent_id: 'agent_from_cached_client_state',
        chatProjectId: 'project-1',
      },
      {
        modelSpecs: {
          enforce: true,
          list: [modelSpec],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(parseCompactConvo.mock.results[0].value).toEqual({});
    expect(req.body.endpointOption.spec).toBe('approved-custom');
    expect(req.body.endpointOption.model).toBe('mock-model-a');
    expect(req.body.endpointOption.promptPrefix).toBe('Use the approved custom model spec.');
    expect(req.body.endpointOption.chatProjectId).toBe('project-1');
  });

  it('should restore private model spec preset fields in non-enforced mode', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const modelSpec = {
      name: 'guarded-custom',
      iconURL: 'custom-icon',
      preset: {
        endpoint: EModelEndpoint.custom,
        model: 'llama3',
        promptPrefix: 'private prompt prefix',
        instructions: 'private instructions',
        additional_instructions: 'private additional instructions',
        temperature: 0.2,
        maxContextTokens: 10000,
      },
    };

    const req = createReq(
      {
        endpoint: EModelEndpoint.custom,
        spec: 'guarded-custom',
        model: 'llama3',
        temperature: 0.8,
      },
      {
        modelSpecs: {
          enforce: false,
          list: [modelSpec],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(req.body.endpointOption.promptPrefix).toBe('private prompt prefix');
    expect(req.body.endpointOption.instructions).toBeUndefined();
    expect(req.body.endpointOption.additional_instructions).toBeUndefined();
    expect(req.body.endpointOption.temperature).toBe(0.8);
    expect(req.body.endpointOption.maxContextTokens).toBeUndefined();
    expect(req.body.endpointOption.iconURL).toBe('custom-icon');
  });

  it('should reject non-enforced model specs for a different endpoint', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.custom,
        spec: 'guarded-agents',
        model: 'llama3',
      },
      {
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-agents',
              preset: {
                endpoint: EModelEndpoint.agents,
                model: 'agent-model',
                promptPrefix: 'private agents prompt',
              },
            },
          ],
        },
      },
    );
    const res = createRes();
    const next = jest.fn();
    const { handleError } = require('@librechat/api');

    await buildEndpointOption(req, res, next);

    expect(handleError).toHaveBeenCalledWith(res, { text: 'Model spec mismatch' });
    expect(mockAgentBuildOptions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should restore a private preset field when the parser supplies an empty default', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.custom,
        spec: 'guarded-custom',
        model: 'llama3',
      },
      {
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-custom',
              preset: {
                endpoint: EModelEndpoint.custom,
                model: 'llama3',
                promptPrefix: 'private prompt prefix',
              },
            },
          ],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(req.body.endpointOption.promptPrefix).toBe('private prompt prefix');
  });

  it('should leave restored agent promptPrefix variables for agent initialization', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.custom,
        spec: 'guarded-custom',
        model: 'llama3',
      },
      {
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-custom',
              preset: {
                endpoint: EModelEndpoint.custom,
                model: 'llama3',
                promptPrefix: 'Help {{current_user}}.',
              },
            },
          ],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';
    req.user = { name: 'Ada' };

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(req.body.endpointOption.promptPrefix).toBe('Help {{current_user}}.');
  });

  it('should fall back to OpenAI schema when getEndpointsConfig fails', async () => {
    mockGetEndpointsConfig.mockRejectedValue(new Error('Config unavailable'));

    const req = createReq(
      {
        endpoint: 'AnthropicClaude',
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.7,
        maxOutputTokens: 8192,
        max_tokens: 4096,
      },
      { modelSpecs: null },
    );

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(parseCompactConvo).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultParamsEndpoint: undefined,
      }),
    );

    const parsedResult = parseCompactConvo.mock.results[0].value;
    expect(parsedResult.maxOutputTokens).toBeUndefined();
    expect(parsedResult.max_tokens).toBe(4096);
  });

  it('should not enter the enforce branch when modelSpecs.list is empty', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: 'openAI',
        model: 'gpt-4',
      },
      {
        modelSpecs: {
          enforce: true,
          list: [],
        },
      },
    );
    const res = createRes();
    const { handleError } = require('@librechat/api');

    await buildEndpointOption(req, res, jest.fn());

    expect(handleError).not.toHaveBeenCalledWith(
      res,
      expect.objectContaining({ text: 'No model spec selected' }),
    );
    expect(handleError).not.toHaveBeenCalledWith(
      res,
      expect.objectContaining({ text: 'Invalid model spec' }),
    );
  });
});
