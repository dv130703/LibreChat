const fs = require('fs/promises');
const path = require('path');
const { v4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');
const {
  hasOfficeHtmlPath,
  classifyCodeArtifact,
  getStorageMetadata,
  resolveWorkspacePath,
} = require('@librechat/api');
const {
  fileConfig,
  FileContext,
  mergeFileConfig,
  getEndpointFileConfig,
  EModelEndpoint,
} = require('librechat-data-provider');
const { createFile, claimCodeFile } = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getRetentionExpiry } = require('~/server/services/Files/retention');
const { determineFileType } = require('~/server/utils');
const { finalizePreview } = require('~/server/services/Files/Code/process');

/** OfficeCLI only ever produces these three formats (see `OFFICE_CLI_EXTENSIONS`
 * in `@librechat/api`'s office/detect module, which gates what reaches here). */
const OFFICE_MIME_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * Persists one OfficeCLI-produced file (a filename already flagged as
 * new/changed by `diffOfficeFiles` and resolved/validated to live inside the
 * caller's per-user workspace) through the same storage/DB primitives
 * `processCodeOutput` uses for code-execution output, so the result can be
 * handed to the same `writeAttachment`/`runPreviewFinalize` call sites
 * unchanged.
 *
 * Unlike `processCodeOutput`, there is no remote sandbox session or
 * background-harvest ordering race to guard against: an OfficeCLI MCP tool
 * call is synchronous, so by the time this runs the file is simply sitting
 * on local disk and is read once. Every extension this module accepts
 * (.docx/.xlsx/.pptx) always qualifies for the office HTML preview path, so
 * there is no "skip preview" branch to maintain here (unlike the
 * code-interpreter version, which also handles plain-text/binary
 * artifacts).
 *
 * The DB row still needs `claimCodeFile`'s atomic
 * `(filename, conversationId, context)` upsert, though: a model routinely
 * edits the same office file across many tool calls in one conversation
 * (create, then several `set`/`batch` calls), and the MCP client can also
 * dispatch a batch of parallel tool calls within one LLM turn. Without the
 * claim, each detected edit would mint a fresh `file_id` and collide on the
 * files collection's unique `(filename, conversationId, context)` index the
 * moment a second row for the same logical file is inserted.
 *
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {string} params.workspaceDir - Per-user OfficeCLI workspace root.
 * @param {string} params.fileName - Basename detected via mtime-diff.
 * @param {string} params.toolCallId
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @returns {Promise<{ file: MongoFile & { messageId: string, toolCallId: string }, finalize: () => Promise<MongoFile | null> } | null>}
 */
const processOfficeCliOutput = async ({
  req,
  workspaceDir,
  fileName,
  toolCallId,
  conversationId,
  messageId,
}) => {
  const appConfig = req.config;
  const formattedDate = new Date().toISOString();
  const ext = path.extname(fileName).toLowerCase();
  const fallbackMimeType = OFFICE_MIME_TYPES[ext];
  if (!fallbackMimeType) {
    logger.warn(`[processOfficeCliOutput] Unsupported extension for "${fileName}", skipping`);
    return null;
  }

  let absolutePath;
  try {
    absolutePath = resolveWorkspacePath(workspaceDir, fileName);
  } catch (error) {
    logger.warn(`[processOfficeCliOutput] ${error.message}`);
    return null;
  }

  const mergedFileConfig = mergeFileConfig(appConfig.fileConfig);
  const endpointFileConfig = getEndpointFileConfig({
    fileConfig: mergedFileConfig,
    endpoint: EModelEndpoint.agents,
  });
  const fileSizeLimit = endpointFileConfig.fileSizeLimit ?? mergedFileConfig.serverFileSizeLimit;

  let buffer;
  try {
    buffer = await fs.readFile(absolutePath);
  } catch (error) {
    logger.error(`[processOfficeCliOutput] Failed to read "${fileName}" from workspace:`, error);
    return null;
  }

  if (buffer.length > fileSizeLimit) {
    logger.warn(
      `[processOfficeCliOutput] "${fileName}" (${buffer.length} bytes) exceeds the file size limit; skipping attachment`,
    );
    return null;
  }

  const { saveBuffer } = getStrategyFunctions(appConfig.fileStrategy);
  if (!saveBuffer) {
    logger.warn(
      `[processOfficeCliOutput] saveBuffer not available for strategy ${appConfig.fileStrategy}`,
    );
    return null;
  }

  const detectedType = await determineFileType(buffer, true);
  const mimeType = detectedType?.mime || fallbackMimeType;

  const isSupportedMimeType = fileConfig.checkType(mimeType, endpointFileConfig.supportedMimeTypes);
  if (!isSupportedMimeType) {
    logger.warn(
      `[processOfficeCliOutput] "${fileName}" resolved to unsupported MIME type "${mimeType}", proceeding anyway`,
    );
  }

  /* Atomically get-or-create the file_id for this (filename, conversationId)
   * pair so repeated edits of the same logical file converge on one DB row
   * instead of colliding on the unique index (see the doc comment above). */
  const candidateFileId = v4();
  const claimed = await claimCodeFile({
    filename: fileName,
    conversationId,
    file_id: candidateFileId,
    user: req.user.id,
    tenantId: req.user.tenantId,
  });
  const file_id = claimed.file_id;
  const isUpdate = file_id !== candidateFileId;

  const storageFileName = `${file_id}__${fileName}`;
  const filepath = await saveBuffer({
    userId: req.user.id,
    buffer,
    fileName: storageFileName,
    basePath: 'uploads',
    tenantId: req.user.tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source: appConfig.fileStrategy });
  const category = classifyCodeArtifact(fileName, mimeType);

  /* hasOfficeHtmlPath is true for every extension this module accepts, so
   * every persisted record goes through the pending -> finalize preview
   * lifecycle, mirroring the office branch of `processCodeOutput`. */
  const previewRevision = v4();
  const file = {
    file_id,
    filepath,
    ...storageMetadata,
    messageId,
    object: 'file',
    filename: fileName,
    type: mimeType,
    conversationId,
    user: req.user.id,
    tenantId: req.user.tenantId,
    bytes: buffer.length,
    updatedAt: formattedDate,
    createdAt: isUpdate ? claimed.createdAt : formattedDate,
    usage: isUpdate ? (claimed.usage ?? 0) + 1 : 1,
    source: appConfig.fileStrategy,
    context: FileContext.execute_code,
    text: null,
    textFormat: null,
    status: 'pending',
    previewError: null,
    previewRevision,
    metadata: { officeCliWorkspace: workspaceDir },
    ...(await getRetentionExpiry(req)),
  };

  await createFile(file, true);

  /* Deliberately NOT deleting the workspace scratch file here. This runs on
   * TOOL_END for every individual OfficeCLI tool call, not once at the end
   * of the agent's turn — a normal document build is create_document, then
   * several add_element/edit_text calls against that SAME file within one
   * turn. Unlinking it after the first call that touches it (as this used
   * to do) left every subsequent call in the same turn unable to find the
   * file at all. claimCodeFile already converges repeated edits of the same
   * (filename, conversationId) onto one file_id/DB row, so leaving the
   * scratch file in place just means later calls in the turn keep working
   * and the next mtime-diff picks up the next edit as an update, not a
   * duplicate. The workspace is swept by a separate ops-level retention job
   * (see mcp-wrapper.sh), which is the correct place to reclaim disk once a
   * conversation is actually done with the file. */

  if (!hasOfficeHtmlPath(fileName, mimeType)) {
    logger.warn(
      `[processOfficeCliOutput] "${fileName}" (${mimeType}) unexpectedly did not qualify for office preview`,
    );
    return { file: Object.assign(file, { messageId, toolCallId }) };
  }

  return {
    file: Object.assign(file, { messageId, toolCallId }),
    finalize: () =>
      finalizePreview({ buffer, leafName: fileName, mimeType, category, file_id, previewRevision }),
    previewRevision,
  };
};

module.exports = { processOfficeCliOutput };
