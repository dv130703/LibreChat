const { getEnabledEndpoints } = require('librechat-data-provider');
const { config } = require('./EndpointService');

/**
 * Return a configuration object for the endpoints this deployment supports
 * (Agents and custom/Ollama endpoints).
 * @returns {Object.<string, EndpointWithOrder>} An object whose keys are endpoint names and values are objects that contain the endpoint configuration and an order.
 */
function loadDefaultEndpointsConfig() {
  const enabledEndpoints = getEnabledEndpoints();

  const endpointConfig = {
    agents: config.agents,
  };

  const orderedAndFilteredEndpoints = enabledEndpoints.reduce((config, key, index) => {
    if (endpointConfig[key]) {
      config[key] = { ...(endpointConfig[key] ?? {}), order: index };
    }
    return config;
  }, {});

  return orderedAndFilteredEndpoints;
}

module.exports = loadDefaultEndpointsConfig;
