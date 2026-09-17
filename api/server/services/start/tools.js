const fs = require('fs');
const path = require('path');
const { Calculator } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { Tool } = require('@librechat/agents/langchain/tools');
const { Tools, ImageVisionTool } = require('librechat-data-provider');
const { oaiToolkit, geminiToolkit, createAskUserQuestionTool } = require('@librechat/api');

/**
 * Loads and formats tools from the specified tool directory.
 *
 * The directory is scanned for JavaScript files, excluding any files in the filter set.
 * For each file, it attempts to load the file as a module and instantiate a class, if it's a subclass of `StructuredTool`.
 * Each tool instance is then formatted to be compatible with the OpenAI Assistant.
 * Additionally, instances of LangChain Tools are included in the result.
 *
 * @param {object} params - The parameters for the function.
 * @param {string} params.directory - The directory path where the tools are located.
 * @returns {Record<string, FunctionTool>} An object mapping each tool's plugin key to its instance.
 */
function loadAndFormatTools({ directory }) {
  const tools = [];
  /* Structured Tools Directory */
  const files = fs.readdirSync(directory);

  for (const file of files) {
    const filePath = path.join(directory, file);
    if (!file.endsWith('.js')) {
      continue;
    }

    let ToolClass = null;
    try {
      ToolClass = require(filePath);
    } catch (error) {
      logger.error(`[loadAndFormatTools] Error loading tool from ${filePath}:`, error);
      continue;
    }

    if (!ToolClass || !(ToolClass.prototype instanceof Tool)) {
      continue;
    }

    let toolInstance = null;
    try {
      toolInstance = new ToolClass({ override: true });
    } catch (error) {
      logger.error(
        `[loadAndFormatTools] Error initializing \`${file}\` tool; if it requires authentication, is the \`override\` field configured?`,
        error,
      );
      continue;
    }

    if (!toolInstance) {
      continue;
    }

    const formattedTool = formatToOpenAIAssistantTool(toolInstance);
    tools.push(formattedTool);
  }

  const basicToolInstances = [
    new Calculator(),
    createAskUserQuestionTool(),
    ...Object.values(oaiToolkit),
    ...Object.values(geminiToolkit),
  ];
  for (const toolInstance of basicToolInstances) {
    const formattedTool = formatToOpenAIAssistantTool(toolInstance);
    tools.push(formattedTool);
  }

  tools.push(ImageVisionTool);

  return tools.reduce((map, tool) => {
    map[tool.function.name] = tool;
    return map;
  }, {});
}

/**
 * Checks if a schema is a Zod schema by looking for the _def property
 * @param {unknown} schema - The schema to check
 * @returns {boolean} True if it's a Zod schema
 */
function isZodSchema(schema) {
  return schema && typeof schema === 'object' && '_def' in schema;
}

/**
 * Formats a `StructuredTool` instance into a format that is compatible
 * with OpenAI's ChatCompletionFunctions. It uses the `zodToJsonSchema`
 * function to convert the schema of the `StructuredTool` into a JSON
 * schema, which is then used as the parameters for the OpenAI function.
 * If the schema is already a JSON schema, it is used directly.
 *
 * @param {StructuredTool} tool - The StructuredTool to format.
 * @returns {FunctionTool} The OpenAI Assistant Tool.
 */
function formatToOpenAIAssistantTool(tool) {
  const parameters = isZodSchema(tool.schema) ? zodToJsonSchema(tool.schema) : tool.schema;
  return {
    type: Tools.function,
    [Tools.function]: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}

module.exports = {
  loadAndFormatTools,
};
