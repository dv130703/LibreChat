jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('~/app/clients/tools', () => ({
  availableTools: [],
  toolkits: [],
}));

const { getAvailableTools, getAvailablePluginsController } = require('./PluginController');

describe('PluginController', () => {
  let mockReq, mockRes;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = { user: { id: 'test-user-id' } };
    mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    require('~/app/clients/tools').availableTools.length = 0;
  });

  describe('getAvailablePluginsController', () => {
    it('uses filterUniquePlugins to remove duplicate plugins', async () => {
      require('~/app/clients/tools').availableTools.push(
        { name: 'Plugin1', pluginKey: 'key1', description: 'First' },
        { name: 'Plugin1', pluginKey: 'key1', description: 'First duplicate' },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second' },
      );

      await getAvailablePluginsController(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData.map((p) => p.pluginKey)).toEqual(['key1', 'key2']);
    });

    it('uses checkPluginAuth to mark authentication status', async () => {
      require('~/app/clients/tools').availableTools.push({
        name: 'Plugin1',
        pluginKey: 'key1',
        description: 'First',
      });

      await getAvailablePluginsController(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData[0].authenticated).toBeUndefined();
    });

    it('includes agentsOnly plugins — nothing is hidden from this listing', async () => {
      require('~/app/clients/tools').availableTools.push(
        { name: 'Ask User', pluginKey: 'ask_user_question', description: 'q', agentsOnly: true },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second' },
      );

      await getAvailablePluginsController(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData.map((p) => p.pluginKey)).toEqual(['ask_user_question', 'key2']);
    });

    it('handles error cases gracefully', async () => {
      // A malformed authConfig (not an array) makes checkPluginAuth throw
      // when it calls `.every` on it — a genuine unexpected-error path.
      require('~/app/clients/tools').availableTools.push({
        name: 'Broken',
        pluginKey: 'broken',
        description: 'broken',
        authConfig: 'not-an-array',
      });

      await getAvailablePluginsController(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        message: expect.stringContaining('every is not a function'),
      });
    });
  });

  describe('getAvailableTools', () => {
    it('returns 401 when no user id is present on the request', async () => {
      await getAvailableTools({ user: {} }, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ message: 'Unauthorized' });
    });

    it('includes agentsOnly plugins regardless of route (agents or assistants)', async () => {
      require('~/app/clients/tools').availableTools.push({
        name: 'Ask User',
        pluginKey: 'ask_user_question',
        description: 'q',
        agentsOnly: true,
      });

      mockReq.baseUrl = '/api/assistants/v2/tools';
      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.json.mock.calls[0][0].map((t) => t.pluginKey)).toContain('ask_user_question');
    });

    it('uses filterUniquePlugins to deduplicate plugins', async () => {
      require('~/app/clients/tools').availableTools.push(
        { name: 'Tool1', pluginKey: 'tool1', description: 'First' },
        { name: 'Tool1', pluginKey: 'tool1', description: 'First duplicate' },
      );

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      const responseData = mockRes.json.mock.calls[0][0];
      expect(responseData.filter((t) => t.pluginKey === 'tool1')).toHaveLength(1);
    });

    it('uses checkPluginAuth to mark authentication status', async () => {
      require('~/app/clients/tools').availableTools.push({
        name: 'Tool1',
        pluginKey: 'tool1',
        description: 'Tool 1',
      });

      await getAvailableTools(mockReq, mockRes);

      const responseData = mockRes.json.mock.calls[0][0];
      const tool = responseData.find((t) => t.pluginKey === 'tool1');
      expect(tool.authenticated).toBeUndefined();
    });

    it('handles error cases gracefully', async () => {
      require('~/app/clients/tools').availableTools.push({
        name: 'Broken',
        pluginKey: 'broken',
        description: 'broken',
        authConfig: 'not-an-array',
      });

      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        message: expect.stringContaining('every is not a function'),
      });
    });

    it('returns an empty list when there are no available tools', async () => {
      await getAvailableTools(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith([]);
    });
  });
});
