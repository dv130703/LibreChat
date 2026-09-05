const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
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

const execFileAsync = promisify(execFile);
const OFFICECLI_BIN =
  process.env.OFFICECLI_BIN ||
  path.join(
    __dirname,
    '../../../../../vendor/officecli/src/officecli/bin/Release/net10.0/linux-x64/officecli',
  );
const VALIDATION_TIMEOUT_MS = 10000;

/**
 * Best-effort, non-blocking OpenXML validation attached to the file's
 * metadata. There is no delivery gate in this integration — the model can
 * call `validate_document`/`view_issues` but nothing requires it to before
 * a changed file gets promoted as an attachment (see ARCHITECTURE.md's
 * "known gaps"). This doesn't add that gate — blocking promotion is a
 * bigger, riskier behavior change than one file's worth of hardening
 * justifies — but it does mean an invalid delivered file is now visible in
 * its own metadata instead of silently unknown. Never throws: a validation
 * failure (binary missing, timeout, bad JSON) just means `officeCliValid`
 * stays undefined, not that the attachment is blocked.
 *
 * @param {string} absolutePath
 * @returns {Promise<{ valid: boolean, message: string } | null>}
 */
/**
 * `officecli validate --json`'s shape differs between resident and
 * non-resident mode (verified by hand: resident returns `data`/`message` as
 * a string like "Validation passed: no errors found."; non-resident — used
 * here, see the `OFFICECLI_NO_AUTO_RESIDENT` call site below — returns
 * `data: { count, errors: [...] }` with no top-level `message` at all).
 * Handles both rather than assuming the one seen in manual testing is the
 * only one this binary ever produces.
 */
const extractValidationMessage = (result) => {
  if (typeof result.message === 'string') return result.message;
  if (typeof result.data === 'string') return result.data;
  if (Array.isArray(result.data?.errors)) {
    return result.data.errors.length === 0
      ? 'Validation passed: no errors found.'
      : result.data.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
  }
  return result.error?.error ?? '';
};

const runOfficeCliValidation = async (absolutePath) => {
  try {
    const { stdout } = await execFileAsync(OFFICECLI_BIN, ['validate', absolutePath, '--json'], {
      timeout: VALIDATION_TIMEOUT_MS,
      // This is a one-off, isolated call — resident mode (officecli's
      // default) would otherwise leave a background process holding the
      // file open for "faster subsequent commands" that never come,
      // silently leaking a process per validated file (found by hand while
      // testing this: two orphaned `__resident-serve__` processes turned up
      // in `ps aux` from just the manual verification + one test run).
      env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' },
    });
    const result = JSON.parse(stdout);
    return { valid: result.success === true, message: extractValidationMessage(result) };
  } catch (error) {
    logger.warn(`[processOfficeCliOutput] Best-effort validation failed for "${absolutePath}":`, error);
    return null;
  }
};

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

  const [detectedType, officeCliValidation] = await Promise.all([
    determineFileType(buffer, true),
    runOfficeCliValidation(absolutePath),
  ]);
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
    metadata: {
      officeCliWorkspace: workspaceDir,
      ...(officeCliValidation && {
        officeCliValid: officeCliValidation.valid,
        officeCliValidationMessage: officeCliValidation.message,
      }),
    },
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
