const { EModelEndpoint } = require('librechat-data-provider');

const mockGetModelsConfig = jest.fn();

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: (...args) => mockGetModelsConfig(...args),
}));

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    getTenantId: () => 'test-tenant',
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  };
});

const {
  pickFirstConfiguredModel,
  resolveImportDefaultModel,
  resolveImportDefaultEndpoint,
} = require('./defaults');

afterEach(() => {
  jest.clearAllMocks();
});

describe('pickFirstConfiguredModel', () => {
  it('returns the first non-empty string for the endpoint', () => {
    const modelsConfig = {
      [EModelEndpoint.custom]: ['llama3', 'qwen2.5'],
    };
    expect(pickFirstConfiguredModel(EModelEndpoint.custom, modelsConfig)).toBe('llama3');
  });

  it('skips empty strings', () => {
    const modelsConfig = {
      [EModelEndpoint.custom]: ['', 'llama3'],
    };
    expect(pickFirstConfiguredModel(EModelEndpoint.custom, modelsConfig)).toBe('llama3');
  });

  it('returns undefined when modelsConfig is missing', () => {
    expect(pickFirstConfiguredModel(EModelEndpoint.custom, undefined)).toBeUndefined();
  });

  it('returns undefined when the endpoint has no models', () => {
    expect(pickFirstConfiguredModel(EModelEndpoint.custom, {})).toBeUndefined();
    expect(
      pickFirstConfiguredModel(EModelEndpoint.custom, { [EModelEndpoint.custom]: [] }),
    ).toBeUndefined();
  });

  it('returns undefined when the endpoint value is not an array', () => {
    expect(
      pickFirstConfiguredModel(EModelEndpoint.custom, {
        [EModelEndpoint.custom]: 'llama3',
      }),
    ).toBeUndefined();
  });
});

describe('resolveImportDefaultModel', () => {
  it('returns the first model from modelsConfig when present', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({
      [EModelEndpoint.custom]: ['llama3'],
    });

    const result = await resolveImportDefaultModel({
      endpoint: EModelEndpoint.custom,
      requestUserId: 'user-1',
      userRole: 'USER',
    });

    expect(result).toBe('llama3');
    expect(mockGetModelsConfig).toHaveBeenCalledWith({
      user: { id: 'user-1', role: 'USER', tenantId: 'test-tenant' },
    });
  });

  it('returns an empty string when modelsConfig has no models for the endpoint', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({});

    const result = await resolveImportDefaultModel({
      endpoint: EModelEndpoint.custom,
      requestUserId: 'user-1',
    });

    expect(result).toBe('');
  });

  it('returns an empty string for unknown endpoints with no modelsConfig entry', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({});

    const result = await resolveImportDefaultModel({
      endpoint: 'some-custom-endpoint',
      requestUserId: 'user-1',
    });

    expect(result).toBe('');
  });

  it('returns an empty string when getModelsConfig rejects', async () => {
    mockGetModelsConfig.mockRejectedValueOnce(new Error('boom'));

    const result = await resolveImportDefaultModel({
      endpoint: EModelEndpoint.custom,
      requestUserId: 'user-1',
    });

    expect(result).toBe('');
  });
});

describe('resolveImportDefaultEndpoint', () => {
  it('prefers the custom endpoint when it exposes models', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({
      [EModelEndpoint.custom]: ['llama3'],
      [EModelEndpoint.agents]: ['agent-model'],
    });

    const result = await resolveImportDefaultEndpoint({ requestUserId: 'user-1' });

    expect(result).toEqual({ endpoint: EModelEndpoint.custom, model: 'llama3' });
  });

  it('falls back to another configured endpoint when custom is unavailable', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({
      [EModelEndpoint.custom]: [],
      [EModelEndpoint.agents]: ['agent-model'],
    });

    const result = await resolveImportDefaultEndpoint({ requestUserId: 'user-1' });

    expect(result).toEqual({ endpoint: EModelEndpoint.agents, model: 'agent-model' });
  });

  it('selects any other configured endpoint when no preferred endpoint has models', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({
      'my-custom': ['custom-model-1'],
    });

    const result = await resolveImportDefaultEndpoint({ requestUserId: 'user-1' });

    expect(result).toEqual({ endpoint: 'my-custom', model: 'custom-model-1' });
  });

  it('falls back to custom endpoint defaults when the models config is empty', async () => {
    mockGetModelsConfig.mockResolvedValueOnce({});

    const result = await resolveImportDefaultEndpoint({ requestUserId: 'user-1' });

    expect(result).toEqual({ endpoint: EModelEndpoint.custom, model: '' });
  });

  it('falls back to custom endpoint defaults when getModelsConfig rejects', async () => {
    mockGetModelsConfig.mockRejectedValueOnce(new Error('boom'));

    const result = await resolveImportDefaultEndpoint({ requestUserId: 'user-1' });

    expect(result).toEqual({ endpoint: EModelEndpoint.custom, model: '' });
  });
});
