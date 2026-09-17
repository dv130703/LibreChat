const { logger } = require('@librechat/data-schemas');
const { checkPluginAuth, filterUniquePlugins } = require('@librechat/api');
const { availableTools } = require('~/app/clients/tools');

function listAllPlugins() {
  return filterUniquePlugins(availableTools).map((plugin) =>
    checkPluginAuth(plugin) ? { ...plugin, authenticated: true } : plugin,
  );
}

const getAvailablePluginsController = async (req, res) => {
  try {
    res.status(200).json(listAllPlugins());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAvailableTools = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      logger.warn('[getAvailableTools] User ID not found in request');
      return res.status(401).json({ message: 'Unauthorized' });
    }

    res.status(200).json(listAllPlugins());
  } catch (error) {
    logger.error('[getAvailableTools]', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAvailableTools,
  getAvailablePluginsController,
};
