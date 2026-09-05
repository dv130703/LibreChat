module.exports = {
  agents: () => ({ sleep: jest.fn() }),

  api: (overrides = {}) => ({
    isEnabled: jest.fn(),
    ImageService: jest.fn().mockImplementation(() => ({
      uploadImage: jest.fn(),
      prepareImageURL: jest.fn(),
      processAvatar: jest.fn(),
    })),
    resolveImportMaxFileSize: jest.fn(() => 262144000),
    createAxiosInstance: jest.fn(() => ({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    })),
    logAxiosError: jest.fn(),
    restoreTenantContextFromReq: jest.fn((req, res, next) => next()),
    deleteConvoSharedLinksWithCleanup: jest.fn(),
    deleteAllSharedLinksWithCleanup: jest.fn(),
    deleteAgentCheckpoints: jest.fn(),
    ...overrides,
  }),

  dataSchemas: () => ({
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    createModels: jest.fn(() => ({
      User: {},
      Conversation: {},
      Message: {},
      SharedLink: {},
    })),
  }),

  dataProvider: (overrides = {}) => ({
    CacheKeys: { GEN_TITLE: 'GEN_TITLE' },
    EModelEndpoint: {
      agents: 'agents',
    },
    FileSources: {
      local: 'local',
      firebase: 'firebase',
      azure: 'azure',
      azure_blob: 'azure_blob',
      s3: 's3',
      cloudfront: 'cloudfront',
      vectordb: 'vectordb',
      execute_code: 'execute_code',
      mistral_ocr: 'mistral_ocr',
      azure_mistral_ocr: 'azure_mistral_ocr',
      vertexai_mistral_ocr: 'vertexai_mistral_ocr',
      text: 'text',
      document_parser: 'document_parser',
    },
    FileContext: { transcript_rag: 'transcript_rag' },
    ...overrides,
  }),

  conversationModel: () => ({
    getConvosByCursor: jest.fn(),
    getConvo: jest.fn(),
    deleteConvos: jest.fn(),
    saveConvo: jest.fn(),
  }),

  toolCallModel: () => ({ deleteToolCalls: jest.fn() }),

  sharedModels: () => ({
    getConvosByCursor: jest.fn(),
    getConvo: jest.fn(),
    deleteConvos: jest.fn(),
    saveConvo: jest.fn(),
    deleteAllSharedLinks: jest.fn(),
    deleteConvoSharedLink: jest.fn(),
    deleteToolCalls: jest.fn(),
    deleteTranscriptCorrections: jest.fn(),
    getFiles: jest.fn().mockResolvedValue([]),
  }),

  filesProcess: () => ({ processDeleteRequest: jest.fn() }),

  requireJwtAuth: () => (req, res, next) => next(),

  middlewarePassthrough: () => ({
    createImportLimiters: jest.fn(() => ({
      importIpLimiter: (req, res, next) => next(),
      importUserLimiter: (req, res, next) => next(),
    })),
    createForkLimiters: jest.fn(() => ({
      forkIpLimiter: (req, res, next) => next(),
      forkUserLimiter: (req, res, next) => next(),
    })),
    configMiddleware: (req, res, next) => next(),
    validateConvoAccess: (req, res, next) => next(),
  }),

  forkUtils: () => ({
    forkConversation: jest.fn(),
    duplicateConversation: jest.fn(),
  }),

  importUtils: () => ({ importConversations: jest.fn() }),

  logStores: () => jest.fn(),

  multerSetup: () => ({
    storage: {},
    importFileFilter: jest.fn(),
  }),

  multerLib: () =>
    jest.fn(() => ({
      single: jest.fn(() => (req, res, next) => {
        req.file = { path: '/tmp/test-file.json' };
        next();
      }),
    })),
};
