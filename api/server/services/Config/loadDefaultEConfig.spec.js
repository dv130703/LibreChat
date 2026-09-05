const mockGetEnabledEndpoints = jest.fn();

function mockOptionalModule(moduleName, factory) {
  try {
    require.resolve(moduleName);
    jest.doMock(moduleName, factory);
  } catch {
    jest.doMock(moduleName, factory, { virtual: true });
  }
}

function mockDependencies() {
  mockOptionalModule('librechat-data-provider', () => ({
    getEnabledEndpoints: mockGetEnabledEndpoints,
  }));

  jest.doMock('./EndpointService', () => ({
    config: {
      agents: { userProvide: false },
    },
  }));
}

describe('loadDefaultEndpointsConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockDependencies();
  });

  it('includes agents when enabled', async () => {
    mockGetEnabledEndpoints.mockReturnValue(['agents']);
    const loadDefaultEndpointsConfig = require('./loadDefaultEConfig');

    const result = await loadDefaultEndpointsConfig();

    expect(result).toEqual({
      agents: { userProvide: false, order: 0 },
    });
  });

  it('excludes endpoints that are not enabled', async () => {
    mockGetEnabledEndpoints.mockReturnValue([]);
    const loadDefaultEndpointsConfig = require('./loadDefaultEConfig');

    const result = await loadDefaultEndpointsConfig();

    expect(result).toEqual({});
  });
});
