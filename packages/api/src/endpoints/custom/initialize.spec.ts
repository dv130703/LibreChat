import { AuthType, ErrorTypes } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';

const mockValidateEndpointURL = jest.fn();
const mockCreateSSRFSafeUndiciConnect = jest.fn(
  (_allowedAddresses?: string[] | null, _port?: string | number | null) => ({
    lookup: jest.fn(),
  }),
);
jest.mock('~/auth', () => ({
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
  createSSRFSafeUndiciConnect: (
    ...args: [allowedAddresses?: string[] | null, port?: string | number | null]
  ) => mockCreateSSRFSafeUndiciConnect(...args),
}));

const mockGetOpenAIConfig = jest.fn().mockReturnValue({
  llmConfig: { model: 'test-model' },
  configOptions: {},
});
jest.mock('~/endpoints/openai/config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/endpoints/models', () => ({
  fetchModels: jest.fn(),
}));

jest.mock('~/cache', () => ({
  standardCache: jest.fn(() => ({ get: jest.fn().mockResolvedValue(null) })),
  tokenConfigCache: jest.fn(() => ({ get: jest.fn().mockResolvedValue(null) })),
}));

jest.mock('~/utils', () => ({
  isUserProvided: (val: string) => val === 'user_provided',
  checkUserKeyExpiry: jest.fn(),
}));

const mockGetCustomEndpointConfig = jest.fn();
jest.mock('~/app/config', () => ({
  getCustomEndpointConfig: (...args: unknown[]) => mockGetCustomEndpointConfig(...args),
}));

import { getTokenConfigKey, initializeCustom } from './initialize';
import { SCOPED_TOKEN_CONFIG_KEY_PREFIX } from '../keys';

function createParams(overrides: {
  apiKey?: string;
  baseURL?: string;
  userBaseURL?: string;
  userApiKey?: string;
  expiresAt?: string;
  headers?: Record<string, string>;
}): BaseInitializeParams {
  const { apiKey = 'sk-test-key', baseURL = 'https://api.example.com/v1' } = overrides;

  mockGetCustomEndpointConfig.mockReturnValue({
    apiKey,
    baseURL,
    models: {},
    headers: overrides.headers,
  });

  const db = {
    getUserKeyValues: jest.fn().mockResolvedValue({
      apiKey: overrides.userApiKey ?? 'sk-user-key',
      baseURL: overrides.userBaseURL ?? 'https://user-api.example.com/v1',
    }),
  } as unknown as BaseInitializeParams['db'];

  return {
    req: {
      user: { id: 'user-1' },
      body: { key: overrides.expiresAt ?? '2099-01-01' },
      config: {},
    } as unknown as BaseInitializeParams['req'],
    endpoint: 'test-custom',
    model_parameters: { model: 'gpt-4' },
    db,
  };
}

describe('initializeCustom – Agents API user key resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch user key even when expiresAt is not in request body (Agents API flow)', async () => {
    const { checkUserKeyExpiry } = jest.requireMock('~/utils');
    const params = createParams({
      apiKey: AuthType.USER_PROVIDED,
      baseURL: 'https://api.example.com/v1',
      userApiKey: 'sk-user-key',
    });
    // Simulate Agents API request body (no `key` field)
    params.req.body = { model: 'agent_123' };

    await initializeCustom(params);

    expect(params.db.getUserKeyValues).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'test-custom',
    });
    expect(checkUserKeyExpiry).not.toHaveBeenCalled();
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'sk-user-key',
      expect.any(Object),
      'test-custom',
    );
  });

  it('should fetch user key for user-provided URL without expiresAt (Agents API flow)', async () => {
    const { checkUserKeyExpiry } = jest.requireMock('~/utils');
    const params = createParams({
      apiKey: 'sk-system-key',
      baseURL: AuthType.USER_PROVIDED,
      userBaseURL: 'https://user-api.example.com/v1',
    });
    params.req.body = { model: 'agent_123' };

    await initializeCustom(params);

    expect(params.db.getUserKeyValues).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'test-custom',
    });
    expect(checkUserKeyExpiry).not.toHaveBeenCalled();
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'sk-user-key',
      expect.any(Object),
      'test-custom',
    );
  });

  it('should still check key expiry when expiresAt is provided (UI flow)', async () => {
    const { checkUserKeyExpiry } = jest.requireMock('~/utils');
    const params = createParams({
      apiKey: AuthType.USER_PROVIDED,
      baseURL: 'https://api.example.com/v1',
      userApiKey: 'sk-user-key',
      expiresAt: '2099-01-01',
    });

    await initializeCustom(params);

    expect(checkUserKeyExpiry).toHaveBeenCalledWith('2099-01-01', 'test-custom');
    expect(params.db.getUserKeyValues).toHaveBeenCalled();
  });

  it('should throw EXPIRED_USER_KEY when expiresAt is expired', async () => {
    const { checkUserKeyExpiry } = jest.requireMock('~/utils');
    checkUserKeyExpiry.mockImplementationOnce(() => {
      throw new Error(JSON.stringify({ type: ErrorTypes.EXPIRED_USER_KEY }));
    });

    const params = createParams({
      apiKey: AuthType.USER_PROVIDED,
      baseURL: 'https://api.example.com/v1',
      userApiKey: 'sk-user-key',
      expiresAt: '2020-01-01',
    });

    await expect(initializeCustom(params)).rejects.toThrow(ErrorTypes.EXPIRED_USER_KEY);
    expect(params.db.getUserKeyValues).not.toHaveBeenCalled();
  });

  it('should NOT call getUserKeyValues when key and URL are system-defined', async () => {
    const params = createParams({
      apiKey: 'sk-system-key',
      baseURL: 'https://api.provider.com/v1',
    });

    await initializeCustom(params);

    expect(params.db.getUserKeyValues).not.toHaveBeenCalled();
  });
});

describe('initializeCustom – OpenAI-compatible header forwarding', () => {
  const userControlledHeaderCases: Array<{
    headerType: string;
    headers: Record<string, string>;
  }> = [
    {
      headerType: 'Authorization',
      headers: { Authorization: 'Bearer static-gateway-token' },
    },
    {
      headerType: 'env-secret',
      headers: { 'X-Env-Secret': '${GATEWAY_SECRET}' },
    },
    {
      headerType: 'user-placeholder',
      headers: { 'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}' },
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves configured headers for admin-trusted base URLs', async () => {
    const headers = {
      Authorization: 'Bearer static-gateway-token',
      'X-Env-Secret': '${GATEWAY_SECRET}',
      'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
    };
    const params = createParams({
      apiKey: 'sk-system-key',
      baseURL: 'https://gateway.example.com/v1',
      headers,
    });

    await initializeCustom(params);

    const clientOptions = mockGetOpenAIConfig.mock.calls[0][1] as {
      headers?: Record<string, string>;
    };
    expect(clientOptions.headers).toEqual(headers);
  });

  it('uses the user API key when the user supplies the base URL', async () => {
    const params = createParams({
      apiKey: 'sk-system-key',
      baseURL: AuthType.USER_PROVIDED,
      userApiKey: 'sk-user-owned-key',
      userBaseURL: 'https://user-controlled.example.com/v1',
    });

    await initializeCustom(params);

    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'sk-user-owned-key',
      expect.any(Object),
      'test-custom',
    );
    expect(mockGetOpenAIConfig).not.toHaveBeenCalledWith(
      'sk-system-key',
      expect.any(Object),
      'test-custom',
    );
  });

  it('throws NO_USER_KEY when the user supplies the base URL without an API key', async () => {
    const params = createParams({
      apiKey: 'sk-system-key',
      baseURL: AuthType.USER_PROVIDED,
      userApiKey: '',
      userBaseURL: 'https://user-controlled.example.com/v1',
    });

    await expect(initializeCustom(params)).rejects.toThrow(ErrorTypes.NO_USER_KEY);
    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });

  it.each(userControlledHeaderCases)(
    'withholds configured $headerType headers when the user supplies the base URL',
    async ({ headers }) => {
      const params = createParams({
        apiKey: 'sk-system-key',
        baseURL: AuthType.USER_PROVIDED,
        userBaseURL: 'https://user-controlled.example.com/v1',
        headers,
      });

      await initializeCustom(params);

      const clientOptions = mockGetOpenAIConfig.mock.calls[0][1] as {
        headers?: Record<string, string>;
      };
      expect(clientOptions.headers).toBeUndefined();
    },
  );
});

describe('initializeCustom – SSRF guard wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call validateEndpointURL when baseURL is user_provided', async () => {
    const params = createParams({
      apiKey: 'sk-test-key',
      baseURL: AuthType.USER_PROVIDED,
      userBaseURL: 'https://user-api.example.com/v1',
      expiresAt: '2099-01-01',
    });

    await initializeCustom(params);

    expect(mockValidateEndpointURL).toHaveBeenCalledTimes(1);
    expect(mockValidateEndpointURL).toHaveBeenCalledWith(
      'https://user-api.example.com/v1',
      'test-custom',
      undefined,
    );
  });

  it('should NOT call validateEndpointURL when baseURL is system-defined', async () => {
    const params = createParams({
      apiKey: 'sk-test-key',
      baseURL: 'https://api.provider.com/v1',
    });

    await initializeCustom(params);

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should propagate SSRF rejection from validateEndpointURL', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(
      new Error('Base URL for test-custom targets a restricted address.'),
    );

    const params = createParams({
      apiKey: 'sk-test-key',
      baseURL: AuthType.USER_PROVIDED,
      userBaseURL: 'http://169.254.169.254/latest/meta-data/',
      expiresAt: '2099-01-01',
    });

    await expect(initializeCustom(params)).rejects.toThrow('targets a restricted address');
    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });
});
