const { isAgentsEndpoint, defaultAgentCapabilities } = require('librechat-data-provider');
const { isUserProvided } = require('@librechat/api');

/**
 * Generate the configuration for a given key and base URL.
 * @param {string} key
 * @param {string} [baseURL]
 * @param {string} [endpoint]
 * @returns {boolean | { userProvide: boolean, userProvideURL?: boolean }}
 */
function generateConfig(key, baseURL, endpoint) {
  if (!key) {
    return false;
  }

  /** @type {{ userProvide: boolean, userProvideURL?: boolean }} */
  const config = { userProvide: isUserProvided(key) };

  if (baseURL) {
    config.userProvideURL = isUserProvided(baseURL);
  }

  const agents = isAgentsEndpoint(endpoint);
  if (agents) {
    config.capabilities = defaultAgentCapabilities;
  }

  return config;
}

module.exports = {
  generateConfig,
};
