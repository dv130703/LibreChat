const axios = require('axios');
const { FileContext } = require('librechat-data-provider');
const createContextHandlers = require('./createContextHandlers');

jest.mock('axios');

describe('createContextHandlers', () => {
  const req = { user: { id: 'user-1' } };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = 'http://localhost:1234';
  });

  afterEach(() => {
    delete process.env.RAG_USE_FULL_CONTEXT;
  });

  it('returns undefined when RAG_API_URL is not configured', () => {
    delete process.env.RAG_API_URL;
    expect(createContextHandlers(req, 'hello')).toBeUndefined();
  });

  describe('chunk-level search (RAG_USE_FULL_CONTEXT unset)', () => {
    it('queries /query and renders the returned chunks as an XML context block', async () => {
      axios.post.mockResolvedValue({
        data: [[{ page_content: 'relevant passage' }, 0.2]],
      });

      const handlers = createContextHandlers(req, 'what does this say?');
      await handlers.processFile({ file_id: 'file-1', filename: 'doc.pdf', embedded: true });
      const prompt = await handlers.createContext();

      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:1234/query',
        expect.objectContaining({ file_id: 'file-1', query: 'what does this say?' }),
        expect.anything(),
      );
      expect(axios.get).not.toHaveBeenCalled();
      expect(prompt).toContain('relevant passage');
    });

    it('skips a file that is not embedded', async () => {
      const handlers = createContextHandlers(req, 'q');
      await handlers.processFile({ file_id: 'file-1', filename: 'doc.pdf', embedded: false });
      const prompt = await handlers.createContext();

      expect(axios.post).not.toHaveBeenCalled();
      expect(prompt).toBe('');
    });
  });

  describe('RAG_USE_FULL_CONTEXT=true', () => {
    beforeEach(() => {
      process.env.RAG_USE_FULL_CONTEXT = 'true';
    });

    it('fetches the whole document for an ordinary embedded file', async () => {
      axios.get.mockResolvedValue({ data: 'the entire document, verbatim' });

      const handlers = createContextHandlers(req, 'q');
      await handlers.processFile({ file_id: 'file-1', filename: 'report.pdf', embedded: true });
      const prompt = await handlers.createContext();

      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:1234/documents/file-1/context',
        expect.anything(),
      );
      expect(axios.post).not.toHaveBeenCalled();
      expect(prompt).toContain('the entire document, verbatim');
    });

    it(
      'NEVER fetches a transcript_rag file\'s whole text, even with the flag on - ' +
        'falls back to chunk-level /query instead',
      async () => {
        // A-2: RAG_USE_FULL_CONTEXT's whole point is "inject the entire
        // document", which is exactly the failure mode a transcript must
        // never hit - it can be tens of KB, unbounded in principle, and
        // would blow a small model's context window silently.
        axios.post.mockResolvedValue({
          data: [[{ page_content: 'a relevant transcript chunk' }, 0.3]],
        });

        const handlers = createContextHandlers(req, 'what was said?');
        await handlers.processFile({
          file_id: 'transcript-1',
          filename: 'meeting.mp4-transcript.md',
          embedded: true,
          context: FileContext.transcript_rag,
        });
        const prompt = await handlers.createContext();

        expect(axios.get).not.toHaveBeenCalled();
        expect(axios.post).toHaveBeenCalledWith(
          'http://localhost:1234/query',
          expect.objectContaining({ file_id: 'transcript-1', query: 'what was said?' }),
          expect.anything(),
        );
        expect(prompt).toContain('a relevant transcript chunk');
      },
    );

    it('NEVER fetches a transcript_diarization_detail file\'s whole text either', async () => {
      axios.post.mockResolvedValue({ data: [] });

      const handlers = createContextHandlers(req, 'q');
      await handlers.processFile({
        file_id: 'detail-1',
        filename: 'meeting.mp4-diarization-detail.json',
        embedded: true,
        context: FileContext.transcript_diarization_detail,
      });
      await handlers.createContext();

      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalled();
    });

    it('renders a mixed batch correctly - one file full-context, one chunked', async () => {
      axios.get.mockResolvedValue({ data: 'full report text' });
      axios.post.mockResolvedValue({
        data: [[{ page_content: 'transcript chunk' }, 0.1]],
      });

      const handlers = createContextHandlers(req, 'q');
      await handlers.processFile({ file_id: 'doc-1', filename: 'report.pdf', embedded: true });
      await handlers.processFile({
        file_id: 'transcript-1',
        filename: 'call.mp4-transcript.md',
        embedded: true,
        context: FileContext.transcript_rag,
      });
      const prompt = await handlers.createContext();

      expect(prompt).toContain('full report text');
      expect(prompt).toContain('transcript chunk');
    });
  });
});
