const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    generateShortLivedToken: jest.fn(),
    logAxiosError: jest.fn(),
    extractChunkEvidence: actual.extractChunkEvidence,
  };
});

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn((options) => Promise.resolve(options.files)),
}));

const { createFileSearchTool } = require('~/app/clients/tools/util/fileSearch');
const { generateShortLivedToken } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getFiles } = require('~/models');

describe('fileSearch.js - tuple return validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
  });

  describe('error cases should return tuple with undefined as second value', () => {
    it('should return tuple when no files provided', async () => {
      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('No files to search. Instruct the user to add files for the search.');
      expect(result[1]).toBeUndefined();
    });

    it('reports unsearchable recordings instead of "no files" when there are none to query', async () => {
      // A conversation whose only document is a recording that failed to
      // index must not answer identically to one with nothing attached -
      // that is what reads to the model as an error worth retrying.
      const tool = await createFileSearchTool({
        userId: 'user-1',
        files: [],
        unavailableNotice: '- Note: standup.m4a could not be indexed. do not retry file_search.',
      });
      const [result] = await tool.func({ query: 'what did they decide' });

      expect(result).toContain('standup.m4a');
      expect(result).toContain('do not retry');
      expect(result).not.toContain('Instruct the user to add files');
    });

    it('still reports unsearchable recordings alongside a genuine empty result', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockResolvedValue({ data: [] });
      const tool = await createFileSearchTool({
        userId: 'user-1',
        files: [{ file_id: 'file-1', filename: 'notes.pdf' }],
        unavailableNotice: '- Note: standup.m4a could not be indexed.',
      });
      const [result] = await tool.func({ query: 'anything' });

      expect(result).toContain('No content found in the files');
      expect(result).toContain('standup.m4a');
    });

    it('should return tuple when JWT token generation fails', async () => {
      generateShortLivedToken.mockReturnValue(null);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-1', filename: 'test.pdf' }],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('There was an error authenticating the file search request.');
      expect(result[1]).toBeUndefined();
    });

    it('should return tuple when no valid results found', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      axios.post.mockRejectedValue(new Error('API Error'));

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-1', filename: 'test.pdf' }],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('No results found or errors occurred while searching the files.');
      expect(result[1]).toBeUndefined();
    });
  });

  describe('success cases should return tuple with artifact object', () => {
    it('should return tuple with formatted results and sources artifact', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockApiResponse = {
        data: [
          [
            {
              page_content: 'This is test content from the document',
              metadata: { source: '/path/to/test.pdf', page: 1 },
            },
            0.2,
          ],
          [
            {
              page_content: 'Additional relevant content',
              metadata: { source: '/path/to/test.pdf', page: 2 },
            },
            0.35,
          ],
        ],
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-123', filename: 'test.pdf' }],
        entity_id: 'agent-456',
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(typeof formattedString).toBe('string');
      expect(formattedString).toContain('File: test.pdf');
      expect(formattedString).toContain('Relevance:');
      expect(formattedString).toContain('This is test content from the document');
      expect(formattedString).toContain('Additional relevant content');

      expect(artifact).toBeDefined();
      expect(artifact).toHaveProperty('file_search');
      expect(artifact.file_search).toHaveProperty('sources');
      expect(artifact.file_search).toHaveProperty('fileCitations', false);
      expect(Array.isArray(artifact.file_search.sources)).toBe(true);
      expect(artifact.file_search.sources.length).toBe(2);

      const source = artifact.file_search.sources[0];
      expect(source).toMatchObject({
        type: 'file',
        fileId: 'file-123',
        fileName: 'test.pdf',
        content: expect.any(String),
        relevance: expect.any(Number),
        pages: [1],
        pageRelevance: { 1: expect.any(Number) },
        chunkId: 'file-123',
        chunkIndex: null,
        transcriptVersion: null,
        indexVersion: null,
        startS: null,
        endS: null,
        speakers: [],
      });
    });

    it('attaches evidence (chunk id, version, time range, speakers) recovered from transcript chunks', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');
      getFiles.mockResolvedValueOnce([
        { file_id: 'transcript-1', transcriptVersion: 5, indexVersion: 5, indexStatus: 'ready' },
      ]);

      const mockApiResponse = {
        data: [
          [
            {
              page_content:
                '[00:42.0-00:46.5] Speaker 1: We agreed on the payment terms.\n[00:46.5-00:50.0] Speaker 2: Yes, that sounds right.',
              metadata: {
                source: '/path/to/transcript.md',
                file_id: 'transcript-1',
                chunk_index: 3,
              },
            },
            0.1,
          ],
        ],
      };
      axios.post.mockResolvedValue(mockApiResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'transcript-1', filename: 'transcript.md' }],
      });

      const [formattedString, artifact] = await fileSearchTool.func({ query: 'payment terms' });

      expect(formattedString).toContain('Time range: 42.0s-50.0s');
      expect(formattedString).toContain('Speakers: Speaker 1, Speaker 2');

      const source = artifact.file_search.sources[0];
      expect(source).toMatchObject({
        chunkId: 'transcript-1#3',
        chunkIndex: 3,
        transcriptVersion: 5,
        indexVersion: 5,
        startS: 42,
        endS: 50,
        speakers: ['Speaker 1', 'Speaker 2'],
      });
    });

    it('should include file citations in description when enabled', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockApiResponse = {
        data: [
          [
            {
              page_content: 'Content with citations',
              metadata: { source: '/path/to/doc.pdf', page: 3 },
            },
            0.15,
          ],
        ],
      };

      axios.post.mockResolvedValue(mockApiResponse);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [{ file_id: 'file-789', filename: 'doc.pdf' }],
        fileCitations: true,
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(formattedString).toContain('Anchor:');
      expect(formattedString).toContain('\\ue202turn0file0');
      expect(artifact.file_search.fileCitations).toBe(true);
    });

    it('should handle multiple files correctly', async () => {
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockResponse1 = {
        data: [
          [
            {
              page_content: 'Content from file 1',
              metadata: { source: '/path/to/file1.pdf', page: 1 },
            },
            0.25,
          ],
        ],
      };

      const mockResponse2 = {
        data: [
          [
            {
              page_content: 'Content from file 2',
              metadata: { source: '/path/to/file2.pdf', page: 1 },
            },
            0.15,
          ],
        ],
      };

      axios.post.mockResolvedValueOnce(mockResponse1).mockResolvedValueOnce(mockResponse2);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'file-1', filename: 'file1.pdf' },
          { file_id: 'file-2', filename: 'file2.pdf' },
        ],
      });

      const result = await fileSearchTool.func({ query: 'test query' });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      const [formattedString, artifact] = result;

      expect(formattedString).toContain('file1.pdf');
      expect(formattedString).toContain('file2.pdf');
      expect(artifact.file_search.sources).toHaveLength(2);
      // Results are sorted by distance (ascending), so file-2 (0.15) comes before file-1 (0.25)
      expect(artifact.file_search.sources[0].fileId).toBe('file-2');
      expect(artifact.file_search.sources[1].fileId).toBe('file-1');
    });

    it('attributes results to the correct file when an earlier file in the same batch fails', async () => {
      // Regression test: file_id used to be recovered from a result's
      // position in the *filtered* (successes-only) results array, indexed
      // back into the original (unfiltered) `files` array - once any file
      // before it in the batch failed, every result after that point got
      // attributed to the wrong file.
      generateShortLivedToken.mockReturnValue('mock-jwt-token');

      const mockResponse2 = {
        data: [
          [
            { page_content: 'Content from file 2', metadata: { source: '/path/to/file2.pdf' } },
            0.1,
          ],
        ],
      };
      const mockResponse3 = {
        data: [
          [
            { page_content: 'Content from file 3', metadata: { source: '/path/to/file3.pdf' } },
            0.2,
          ],
        ],
      };

      axios.post
        .mockRejectedValueOnce(new Error('file-1 query failed'))
        .mockResolvedValueOnce(mockResponse2)
        .mockResolvedValueOnce(mockResponse3);

      const fileSearchTool = await createFileSearchTool({
        userId: 'user1',
        files: [
          { file_id: 'file-1', filename: 'file1.pdf' },
          { file_id: 'file-2', filename: 'file2.pdf' },
          { file_id: 'file-3', filename: 'file3.pdf' },
        ],
      });

      const [, artifact] = await fileSearchTool.func({ query: 'test query' });

      const sources = artifact.file_search.sources;
      expect(sources).toHaveLength(2);
      const byContent = Object.fromEntries(sources.map((s) => [s.content, s.fileId]));
      expect(byContent['Content from file 2']).toBe('file-2');
      expect(byContent['Content from file 3']).toBe('file-3');
    });
  });
});

describe('entity_id scoping by file origin', () => {
  const ORIGINAL_RAG_API_URL = process.env.RAG_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
    generateShortLivedToken.mockReturnValue('mock-jwt-token');
    axios.post.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    if (ORIGINAL_RAG_API_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = ORIGINAL_RAG_API_URL;
    }
  });

  function bodiesSent() {
    return axios.post.mock.calls
      .filter(([url]) => String(url).endsWith('/query'))
      .map(([, body]) => body);
  }

  it('sends entity_id only for agent knowledge-base files', async () => {
    const tool = await createFileSearchTool({
      userId: 'user1',
      entity_id: 'agent_123',
      files: [
        { file_id: 'kb-1', filename: 'kb.pdf', fromAgent: true },
        { file_id: 'user-1', filename: 'attachment.txt', fromAgent: false },
      ],
    });
    await tool.func({ query: 'q' });

    const bodies = bodiesSent();
    expect(bodies.find((b) => b.file_id === 'kb-1').entity_id).toBe('agent_123');
    expect(bodies.find((b) => b.file_id === 'user-1').entity_id).toBeUndefined();
  });

  it('omits entity_id when fromAgent is not set (safe default)', async () => {
    const tool = await createFileSearchTool({
      userId: 'user1',
      entity_id: 'agent_123',
      files: [{ file_id: 'legacy-1', filename: 'legacy.pdf' }],
    });
    await tool.func({ query: 'q' });
    expect(bodiesSent()[0].entity_id).toBeUndefined();
  });

  it('sends no entity_id when none is provided', async () => {
    const tool = await createFileSearchTool({
      userId: 'user1',
      files: [{ file_id: 'f1', filename: 'a.txt', fromAgent: true }],
    });
    await tool.func({ query: 'q' });
    expect(bodiesSent()[0].entity_id).toBeUndefined();
  });
});

describe('retrieval logging', () => {
  const ORIGINAL_RAG_API_URL = process.env.RAG_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:8000';
    generateShortLivedToken.mockReturnValue('mock-jwt-token');
  });

  afterEach(() => {
    if (ORIGINAL_RAG_API_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = ORIGINAL_RAG_API_URL;
    }
  });

  it('reports staleness for a queried file whose index has fallen behind its transcript version', async () => {
    getFiles.mockResolvedValueOnce([
      { file_id: 'file-1', transcriptVersion: 3, indexVersion: 2, indexStatus: 'stale' },
    ]);
    axios.post.mockResolvedValueOnce({
      data: [[{ page_content: 'stale content', metadata: { source: '/path/to/file1.pdf' } }, 0.1]],
    });

    const tool = await createFileSearchTool({
      userId: 'user1',
      files: [{ file_id: 'file-1', filename: 'file1.pdf' }],
    });
    await tool.func({ query: 'test query' });

    expect(logger.info).toHaveBeenCalledWith(
      '[RAG] file_search retrieval',
      expect.objectContaining({
        query: 'test query',
        candidateCount: 1,
        returnedCount: 1,
        staleness: [
          expect.objectContaining({
            file_id: 'file-1',
            transcriptVersion: 3,
            indexVersion: 2,
            indexStatus: 'stale',
            isStale: true,
          }),
        ],
      }),
    );
  });

  it('omits staleness for a file with no tracked version (not the Audio Transcriber)', async () => {
    getFiles.mockResolvedValueOnce([]);
    axios.post.mockResolvedValueOnce({ data: [] });

    const tool = await createFileSearchTool({
      userId: 'user1',
      files: [{ file_id: 'plain-file', filename: 'doc.pdf' }],
    });
    await tool.func({ query: 'test query' });

    expect(logger.info).toHaveBeenCalledWith(
      '[RAG] file_search retrieval',
      expect.objectContaining({ staleness: undefined }),
    );
  });
});
