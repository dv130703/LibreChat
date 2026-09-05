jest.mock('~/server/utils/handleText', () => ({
  generateConfig: (key) => (key ? { userProvide: key === 'user_provided' } : false),
}));

describe('EndpointService', () => {
  it('always enables the agents endpoint', () => {
    const { config } = require('../EndpointService');

    expect(config.agents).toEqual({ userProvide: false });
  });
});
