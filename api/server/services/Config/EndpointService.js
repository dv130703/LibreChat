const { generateConfig } = require('~/server/utils/handleText');

module.exports = {
  config: {
    /* key will be part of separate config */
    agents: generateConfig('true', undefined, 'agents'),
  },
};
