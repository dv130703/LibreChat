const {
  handleError,
  applyModelSpecPreset,
  findModelSpecByName,
  isModelSpecEndpointMatch,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { parseCompactConvo, getDefaultParamsEndpoint } = require('librechat-data-provider');
const { getEndpointsConfig } = require('~/server/services/Config');
const agents = require('~/server/services/Endpoints/agents');

/**
 * This middleware is only ever mounted on the `/api/agents/chat` router
 * (see `~/server/routes/agents/chat.js`), so every request it handles - for
 * the `agents` endpoint and for `custom` (Ollama) endpoints alike - is
 * built via the agents builder.
 */
async function buildEndpointOption(req, res, next) {
  const { endpoint, endpointType } = req.body;

  let endpointsConfig;
  try {
    endpointsConfig = await getEndpointsConfig(req);
  } catch (error) {
    logger.error('Error fetching endpoints config in buildEndpointOption', error);
  }

  const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);

  let parsedBody;
  try {
    parsedBody = parseCompactConvo({
      endpoint,
      endpointType,
      conversation: req.body,
      defaultParamsEndpoint,
    });
  } catch (error) {
    logger.error(`Error parsing compact conversation for endpoint ${endpoint}`, error);
    logger.debug({
      'Error parsing compact conversation': { endpoint, endpointType, conversation: req.body },
    });
    return handleError(res, { text: 'Error parsing conversation' });
  }

  const appConfig = req.config;
  if (appConfig.modelSpecs?.list?.length && appConfig.modelSpecs?.enforce) {
    /** @type {{ list: TModelSpec[] }}*/
    const { list } = appConfig.modelSpecs;
    const rawSpec = req.body.spec;
    const spec = parsedBody.spec ?? (typeof rawSpec === 'string' ? rawSpec : undefined);
    const rawChatProjectId = req.body.chatProjectId;
    const parsedBodyForModelSpec =
      parsedBody.chatProjectId === undefined &&
      (typeof rawChatProjectId === 'string' || rawChatProjectId === null)
        ? { ...parsedBody, chatProjectId: rawChatProjectId }
        : parsedBody;

    if (!spec) {
      return handleError(res, { text: 'No model spec selected' });
    }

    const currentModelSpec = findModelSpecByName({ list }, spec);
    if (!currentModelSpec) {
      return handleError(res, { text: 'Invalid model spec' });
    }

    if (!isModelSpecEndpointMatch(currentModelSpec, endpoint)) {
      return handleError(res, { text: 'Model spec mismatch' });
    }

    try {
      const result = applyModelSpecPreset({
        modelSpec: currentModelSpec,
        parsedBody: parsedBodyForModelSpec,
        endpoint,
        endpointType,
        defaultParamsEndpoint,
        includePresetDefaults: true,
      });
      parsedBody = result.parsedBody;
    } catch (error) {
      logger.error(`Error parsing model spec for endpoint ${endpoint}`, error);
      return handleError(res, { text: 'Error parsing model spec' });
    }
  } else if (parsedBody.spec && appConfig.modelSpecs?.list) {
    const modelSpec = findModelSpecByName(appConfig.modelSpecs, parsedBody.spec);
    if (modelSpec) {
      if (!isModelSpecEndpointMatch(modelSpec, endpoint)) {
        return handleError(res, { text: 'Model spec mismatch' });
      }

      try {
        const result = applyModelSpecPreset({
          modelSpec,
          parsedBody,
          endpoint,
          endpointType,
          defaultParamsEndpoint,
        });
        parsedBody = result.parsedBody;
      } catch (error) {
        logger.error(`Error parsing model spec for endpoint ${endpoint}`, error);
        return handleError(res, { text: 'Error parsing model spec' });
      }
    }
  }

  try {
    // TODO: use object params
    req.body = req.body || {}; // Express 5: ensure req.body exists
    req.body.endpointOption = await agents.buildOptions(req, endpoint, parsedBody, endpointType);

    next();
  } catch (error) {
    logger.error(
      `Error building endpoint option for endpoint ${endpoint} with type ${endpointType}`,
      error,
    );
    return handleError(res, { text: 'Error building endpoint option' });
  }
}

module.exports = buildEndpointOption;
