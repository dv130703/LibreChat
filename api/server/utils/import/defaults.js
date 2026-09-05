const { logger, getTenantId } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { getModelsConfig } = require('~/server/controllers/ModelController');

/**
 * Picks the first available model for an endpoint from a runtime models config.
 *
 * @param {string} endpoint - The endpoint key (e.g. EModelEndpoint.custom).
 * @param {TModelsConfig} [modelsConfig] - Map of endpoint -> available model list.
 * @returns {string | undefined} The first model for the endpoint, or undefined.
 */
function pickFirstConfiguredModel(endpoint, modelsConfig) {
  const models = modelsConfig?.[endpoint];
  if (!Array.isArray(models)) {
    return undefined;
  }
  for (const model of models) {
    if (typeof model === 'string' && model.length > 0) {
      return model;
    }
  }
  return undefined;
}

/**
 * Resolves the default model that imported conversations should be saved with
 * for a given endpoint. Prefers the first model exposed by the runtime models
 * config (admin-configured custom endpoint, or provider-discovered). There is
 * no universal hardcoded fallback model — custom endpoint models are entirely
 * admin/user-configured — so an empty string is returned as a last resort,
 * leaving the model choice to the user on their next message.
 *
 * @param {object} args
 * @param {string} args.endpoint - The endpoint key the import is targeting.
 * @param {string} args.requestUserId - The id of the importing user.
 * @param {string} [args.userRole] - The role of the importing user.
 * @returns {Promise<string>} The default model name to persist on the conversation.
 */
async function resolveImportDefaultModel({ endpoint, requestUserId, userRole }) {
  try {
    const modelsConfig = await getModelsConfig({
      user: { id: requestUserId, role: userRole, tenantId: getTenantId() },
    });
    const configured = pickFirstConfiguredModel(endpoint, modelsConfig);
    if (configured) {
      return configured;
    }
  } catch (error) {
    logger.warn(
      `[import] Failed to resolve default model from modelsConfig for ${endpoint}: ${error.message}`,
    );
  }
  return '';
}

/**
 * Preferred endpoint order for conversations cloned without a known source
 * endpoint. `custom` (the admin's configured endpoints, e.g. Ollama) is tried
 * first; `agents` is the remaining fallback.
 */
const DEFAULT_ENDPOINT_PREFERENCE = [EModelEndpoint.custom, EModelEndpoint.agents];

/**
 * Resolves an endpoint and model the requesting user can actually use, for
 * conversations cloned without a known source endpoint (shared forks, whose
 * original endpoint is stripped from the sanitized payload). Picks the first
 * preferred endpoint exposing models, then any other configured endpoint, so
 * a deployment without models configured for the preferred endpoint doesn't
 * produce a conversation whose first message is rejected by model validation.
 *
 * @param {object} args
 * @param {string} args.requestUserId - The id of the requesting user.
 * @param {string} [args.userRole] - The role of the requesting user.
 * @returns {Promise<{ endpoint: string, model: string }>} A usable endpoint and model.
 */
async function resolveImportDefaultEndpoint({ requestUserId, userRole }) {
  try {
    const modelsConfig = await getModelsConfig({
      user: { id: requestUserId, role: userRole, tenantId: getTenantId() },
    });
    if (modelsConfig) {
      const orderedEndpoints = [
        ...DEFAULT_ENDPOINT_PREFERENCE,
        ...Object.keys(modelsConfig).filter(
          (endpoint) => !DEFAULT_ENDPOINT_PREFERENCE.includes(endpoint),
        ),
      ];
      for (const endpoint of orderedEndpoints) {
        const model = pickFirstConfiguredModel(endpoint, modelsConfig);
        if (model) {
          return { endpoint, model };
        }
      }
    }
  } catch (error) {
    logger.warn(
      `[import] Failed to resolve a default endpoint from modelsConfig: ${error.message}`,
    );
  }
  return { endpoint: EModelEndpoint.custom, model: '' };
}

module.exports = {
  pickFirstConfiguredModel,
  resolveImportDefaultModel,
  resolveImportDefaultEndpoint,
};
