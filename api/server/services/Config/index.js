const appConfig = require('./app');
const mcpToolsCache = require('./mcp');
const { config } = require('./EndpointService');
const getCachedTools = require('./getCachedTools');
const loadCustomConfig = require('./loadCustomConfig');
const loadConfigModels = require('./loadConfigModels');
const getEndpointsConfig = require('./getEndpointsConfig');

module.exports = {
  config,
  loadCustomConfig,
  loadConfigModels,
  ...appConfig,
  ...getCachedTools,
  ...mcpToolsCache,
  ...getEndpointsConfig,
};
