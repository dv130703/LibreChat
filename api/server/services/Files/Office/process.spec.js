const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OFFICECLI_BIN = path.join(
  __dirname,
  '../../../../../vendor/officecli/src/officecli/bin/Release/net10.0/linux-x64/officecli',
);

// Configurable file size limit for the "exceeds limit" test case.
const fileSizeLimitConfig = { value: 20 * 1024 * 1024 };

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    mergeFileConfig: jest.fn((config) => {
      const merged = actual.mergeFileConfig(config);
      return {
        ...merged,
        get serverFileSizeLimit() {
          return fileSizeLimitConfig.value;
        },
      };
    }),
    getEndpointFileConfig: jest.fn((options) => {
      const config = actual.getEndpointFileConfig(options);
      return {
        ...config,
        get fileSizeLimit() {
          return fileSizeLimitConfig.value;
        },
      };
    }),
  };
});

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-1234'),
}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    // Real, pure logic — this is exactly what the module under test relies
    // on for path-traversal safety and office-preview routing, so it stays
    // real rather than stubbed.
    resolveWorkspacePath: actual.resolveWorkspacePath,
    hasOfficeHtmlPath: actual.hasOfficeHtmlPath,
    classifyCodeArtifact: actual.classifyCodeArtifact,
    getStorageMetadata: jest.fn(() => ({})),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockCreateFile = jest.fn().mockResolvedValue({});
/* Minimal real-ish stand-in for the actual `claimCodeFile` (an atomic Mongo
 * `findOneAndUpdate` upsert keyed by `(filename, conversationId, context)`,
 * see packages/data-schemas/src/methods/file.ts): first call for a given
 * (filename, conversationId) "inserts" (returns the candidate file_id
 * unchanged), every subsequent call for the same pair returns the
 * already-claimed record instead. This is what the regression test below
 * exercises — the real bug was bypassing this dance and minting a fresh
 * file_id on every call, colliding on the unique index in production. */
const codeFileClaims = new Map();
const mockClaimCodeFile = jest.fn(async ({ filename, conversationId, file_id, user, tenantId }) => {
  const key = `${filename}::${conversationId}`;
  const existing = codeFileClaims.get(key);
  if (existing) {
    return existing;
  }
  const claimed = { file_id, user, tenantId, createdAt: '2020-01-01T00:00:00.000Z', usage: 1 };
  codeFileClaims.set(key, claimed);
  return claimed;
});
jest.mock('~/models', () => ({
  createFile: (...args) => mockCreateFile(...args),
  claimCodeFile: (...args) => mockClaimCodeFile(...args),
}));

const mockSaveBuffer = jest.fn();
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({ saveBuffer: mockSaveBuffer })),
}));

jest.mock('~/server/services/Files/retention', () => ({
  getRetentionExpiry: jest.fn(() => ({})),
}));

const mockDetermineFileType = jest.fn();
jest.mock('~/server/utils', () => ({
  determineFileType: (...args) => mockDetermineFileType(...args),
}));

const mockFinalizePreview = jest.fn();
jest.mock('~/server/services/Files/Code/process', () => ({
  finalizePreview: (...args) => mockFinalizePreview(...args),
}));

const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { processOfficeCliOutput } = require('./process');

describe('processOfficeCliOutput', () => {
  let workspaceDir;
  const baseParams = {
    toolCallId: 'tool-call-1',
    conversationId: 'convo-1',
    messageId: 'message-1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    codeFileClaims.clear();
    mockCreateFile.mockResolvedValue({});
    mockSaveBuffer.mockResolvedValue('/uploads/user-1/mock-uuid-1234__report.xlsx');
    mockDetermineFileType.mockResolvedValue({
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    getStrategyFunctions.mockReturnValue({ saveBuffer: mockSaveBuffer });
    fileSizeLimitConfig.value = 20 * 1024 * 1024;
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'officecli-process-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const makeReq = () => ({
    user: { id: 'user-1', tenantId: 'tenant-1' },
    config: { fileConfig: {}, fileStrategy: 'local' },
  });

  it('persists a newly written xlsx, leaves the workspace copy in place for later tool calls, and returns a pending file + finalize', async () => {
    await fs.writeFile(path.join(workspaceDir, 'report.xlsx'), 'fake-xlsx-bytes');

    const result = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'report.xlsx',
      ...baseParams,
    });

    expect(mockSaveBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        fileName: 'mock-uuid-1234__report.xlsx',
        basePath: 'uploads',
      }),
    );
    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'mock-uuid-1234',
        filename: 'report.xlsx',
        conversationId: 'convo-1',
        messageId: 'message-1',
        status: 'pending',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      true,
    );
    expect(result.file.toolCallId).toBe('tool-call-1');
    expect(typeof result.finalize).toBe('function');

    // Regression: the scratch copy must NOT be deleted here — a document
    // build is create_document followed by several add_element/edit_text
    // calls against this same file within one turn, and this hook fires on
    // every individual tool call, not once at the end of the turn. Deleting
    // it after the first call left every later call unable to find the file.
    await expect(fs.access(path.join(workspaceDir, 'report.xlsx'))).resolves.toBeUndefined();
  });

  it('attaches best-effort OpenXML validation results to the file metadata', async () => {
    // Real officecli binary, real valid docx — not a mock, per this repo's
    // testing philosophy. Confirms the metadata.officeCliValid wiring added
    // for ARCHITECTURE.md's "no delivery gate" gap actually reaches the
    // created file record end to end.
    execFileSync(OFFICECLI_BIN, ['create', 'valid.docx', '--type', 'docx'], { cwd: workspaceDir });
    execFileSync(
      OFFICECLI_BIN,
      ['add', 'valid.docx', '/body', '--type', 'paragraph', '--prop', 'text=Hello'],
      { cwd: workspaceDir },
    );
    execFileSync(OFFICECLI_BIN, ['close', 'valid.docx'], { cwd: workspaceDir });

    await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'valid.docx',
      ...baseParams,
    });

    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          officeCliValid: true,
          officeCliValidationMessage: expect.stringContaining('Validation passed'),
        }),
      }),
      true,
    );
  }, 20000);

  it('reuses the same file_id when the same filename is edited again in the same conversation (regression: avoided E11000 on the files unique index)', async () => {
    const { v4 } = require('uuid');
    v4.mockReturnValueOnce('candidate-1') // call #1 candidateFileId
      .mockReturnValueOnce('preview-1') // call #1 previewRevision
      .mockReturnValueOnce('candidate-2') // call #2 candidateFileId — must be discarded
      .mockReturnValueOnce('preview-2'); // call #2 previewRevision

    await fs.writeFile(path.join(workspaceDir, 'report.xlsx'), 'v1-bytes');
    const first = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'report.xlsx',
      ...baseParams,
    });

    await fs.writeFile(path.join(workspaceDir, 'report.xlsx'), 'v2-bytes-longer');
    const second = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'report.xlsx',
      ...baseParams,
    });

    expect(first.file.file_id).toBe('candidate-1');
    expect(second.file.file_id).toBe('candidate-1');
    expect(mockCreateFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ file_id: 'candidate-1', usage: 2 }),
      true,
    );
  });

  it('calls the shared finalizePreview helper (not a duplicated implementation) when finalize runs', async () => {
    await fs.writeFile(path.join(workspaceDir, 'deck.pptx'), 'fake-pptx-bytes');
    mockDetermineFileType.mockResolvedValue({
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });

    const result = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'deck.pptx',
      ...baseParams,
    });

    await result.finalize();
    expect(mockFinalizePreview).toHaveBeenCalledWith(
      expect.objectContaining({ leafName: 'deck.pptx', file_id: 'mock-uuid-1234' }),
    );
  });

  it('refuses a path-traversal filename without touching storage or the DB', async () => {
    const result = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: '../escape.xlsx',
      ...baseParams,
    });

    expect(result).toBeNull();
    expect(mockSaveBuffer).not.toHaveBeenCalled();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('skips an unsupported extension without touching the filesystem', async () => {
    const result = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'notes.txt',
      ...baseParams,
    });

    expect(result).toBeNull();
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('skips a file that exceeds the configured size limit', async () => {
    fileSizeLimitConfig.value = 10;
    await fs.writeFile(path.join(workspaceDir, 'big.docx'), 'this-is-more-than-ten-bytes');

    const result = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'big.docx',
      ...baseParams,
    });

    expect(result).toBeNull();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it('returns null when the configured storage strategy has no saveBuffer', async () => {
    getStrategyFunctions.mockReturnValue({});
    await fs.writeFile(path.join(workspaceDir, 'report.xlsx'), 'fake-xlsx-bytes');

    const result = await processOfficeCliOutput({
      req: makeReq(),
      workspaceDir,
      fileName: 'report.xlsx',
      ...baseParams,
    });

    expect(result).toBeNull();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });
});
