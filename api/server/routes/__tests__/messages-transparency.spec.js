const express = require('express');
const request = require('supertest');

jest.mock('@librechat/agents', () => ({
  sleep: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  getAgent: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  validateMessageReq: jest.fn((req, res, next) => next()),
  sendValidationResponse: jest.fn(),
  prepareMessageRequestValidation: jest.fn((req, res, next) => next()),
  configMiddleware: (req, res, next) => next(),
}));

jest.mock('~/db/models', () => ({
  Message: {
    findOne: jest.fn(),
    find: jest.fn(),
    meiliSearch: jest.fn(),
  },
}));

describe('GET /:conversationId/:messageId/transparency', () => {
  let app;
  const { getMessages, getAgent } = require('~/models');

  const authenticatedUserId = 'user-owner-123';

  beforeAll(() => {
    const messagesRouter = require('../messages');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: authenticatedUserId };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 404 when the message does not exist', async () => {
    getMessages.mockResolvedValue([]);

    const response = await request(app).get('/api/messages/convo-1/message-1/transparency');

    expect(response.status).toBe(404);
  });

  it('extracts tool calls and flags handoffs/subagent calls, with no agent for non-agent endpoints', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'convo-1',
        isCreatedByUser: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        model: 'gpt-4o',
        endpoint: 'openAI',
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'tool_call',
            tool_call: { id: 't1', name: 'web_search', args: { q: 'x' }, output: 'result' },
          },
          {
            type: 'tool_call',
            tool_call: { id: 't2', name: 'transfer_to_billing', args: {}, output: 'ok' },
          },
          {
            type: 'tool_call',
            tool_call: { id: 't3', name: 'subagent', args: {}, output: 'done' },
          },
        ],
      },
    ]);

    const response = await request(app).get('/api/messages/convo-1/message-1/transparency');

    expect(response.status).toBe(200);
    expect(getAgent).not.toHaveBeenCalled();
    expect(response.body.agent).toBeNull();
    expect(response.body.toolCalls).toEqual([
      {
        id: 't1',
        name: 'web_search',
        args: { q: 'x' },
        output: 'result',
        isHandoff: false,
        isSubagent: false,
      },
      {
        id: 't2',
        name: 'transfer_to_billing',
        args: {},
        output: 'ok',
        isHandoff: true,
        isSubagent: false,
      },
      { id: 't3', name: 'subagent', args: {}, output: 'done', isHandoff: false, isSubagent: true },
    ]);
  });

  it('resolves the current agent config when nothing has changed since the message', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'convo-1',
        isCreatedByUser: false,
        createdAt: '2026-03-01T00:00:00.000Z',
        model: 'agent-abc',
        endpoint: 'agents',
        content: [],
      },
    ]);
    getAgent.mockResolvedValue({
      id: 'agent-abc',
      name: 'Support Agent',
      provider: 'openAI',
      model: 'gpt-4o',
      instructions: 'Current instructions',
      tools: ['web_search'],
      versions: [{ updatedAt: '2026-01-01T00:00:00.000Z', instructions: 'Old instructions' }],
    });

    const response = await request(app).get('/api/messages/convo-1/message-1/transparency');

    expect(response.status).toBe(200);
    expect(getAgent).toHaveBeenCalledWith({ id: 'agent-abc' });
    expect(response.body.agent).toMatchObject({
      id: 'agent-abc',
      instructions: 'Current instructions',
      source: 'current',
    });
  });

  it('reconstructs the agent config from version history when the agent was edited after the message', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'convo-1',
        isCreatedByUser: false,
        createdAt: '2026-02-01T00:00:00.000Z',
        model: 'agent-abc',
        endpoint: 'agents',
        content: [],
      },
    ]);
    getAgent.mockResolvedValue({
      id: 'agent-abc',
      name: 'Support Agent',
      provider: 'openAI',
      model: 'gpt-4o',
      instructions: 'Current (newer) instructions',
      tools: ['web_search'],
      versions: [
        {
          updatedAt: '2026-01-01T00:00:00.000Z',
          provider: 'openAI',
          model: 'gpt-4o-mini',
          instructions: 'Instructions as of January',
          tools: ['file_search'],
        },
        {
          updatedAt: '2026-03-01T00:00:00.000Z',
          provider: 'openAI',
          model: 'gpt-4o',
          instructions: 'Current (newer) instructions',
          tools: ['web_search'],
        },
      ],
    });

    const response = await request(app).get('/api/messages/convo-1/message-1/transparency');

    expect(response.status).toBe(200);
    expect(response.body.agent).toMatchObject({
      instructions: 'Instructions as of January',
      model: 'gpt-4o-mini',
      tools: ['file_search'],
      source: 'reconstructed',
      versionUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns a null agent when the agent has been deleted', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'convo-1',
        isCreatedByUser: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        model: 'agent-deleted',
        endpoint: 'agents',
        content: [],
      },
    ]);
    getAgent.mockResolvedValue(null);

    const response = await request(app).get('/api/messages/convo-1/message-1/transparency');

    expect(response.status).toBe(200);
    expect(response.body.agent).toBeNull();
  });
});
