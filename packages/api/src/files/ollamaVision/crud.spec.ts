jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('~/utils/axios', () => {
  const mockPost = jest.fn();
  return {
    createAxiosInstance: () => ({ post: mockPost }),
    logAxiosError: jest.fn(({ message }: { message?: string }) => message || 'Error'),
    __mockPost: mockPost,
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ServerRequest } from '~/types';
import { uploadOllamaVisionOCR } from './crud';

const mockPost = jest.requireMock('~/utils/axios').__mockPost as jest.Mock;

function makeContext(
  file: Partial<Express.Multer.File>,
  ocr: Record<string, unknown> = { ollamaVisionModel: 'llama3.2-vision' },
) {
  return {
    req: { config: { ocr } } as unknown as ServerRequest,
    file: file as Express.Multer.File,
    loadAuthValues: jest.fn(),
  };
}

describe('uploadOllamaVisionOCR', () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    mockPost.mockReset();
    for (const filePath of tempFiles.splice(0)) {
      await fs.promises.rm(filePath, { force: true });
    }
  });

  it('throws a clear error when ocr.ollamaVisionModel is not configured', async () => {
    const context = makeContext(
      { path: '/tmp/whatever.pdf', mimetype: 'application/pdf', originalname: 'whatever.pdf' },
      {},
    );
    await expect(uploadOllamaVisionOCR(context)).rejects.toThrow(/ollamaVisionModel/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects unsupported file types without calling the model', async () => {
    const context = makeContext({
      path: '/tmp/whatever.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalname: 'whatever.docx',
    });
    await expect(uploadOllamaVisionOCR(context)).rejects.toThrow(/only supports PDFs and images/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  // The PDF-rendering path (`renderPdfPagesToImages`) dynamically imports pdfjs-dist's ESM
  // build, which Jest cannot parse (`import.meta` outside a module) - the same known
  // constraint `documents/crud.ts`'s `pdfToText` works around by deferring that same import.
  // It's exercised through manual/integration testing instead; the image-file path below
  // covers the shared transcription/error-handling logic without touching that import.

  it('sends an image file directly to the model without rendering', async () => {
    const filePath = path.join(os.tmpdir(), `ollama-vision-image-${Date.now()}.png`);
    tempFiles.push(filePath);
    // Real PNG magic bytes, not a full valid image - the model call is mocked, so only the
    // base64 encoding of the file's own bytes matters here.
    await fs.promises.writeFile(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    mockPost.mockResolvedValueOnce({ data: { message: { content: 'a scanned receipt' } } });

    const context = makeContext({
      path: filePath,
      mimetype: 'image/png',
      originalname: 'scan.png',
    });
    const result = await uploadOllamaVisionOCR(context);

    expect(result.text).toBe('a scanned receipt');
  });

  it('throws when the model reports no readable text on any page', async () => {
    const filePath = path.join(os.tmpdir(), `ollama-vision-blank-${Date.now()}.png`);
    tempFiles.push(filePath);
    await fs.promises.writeFile(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    mockPost.mockResolvedValueOnce({ data: { message: { content: 'NO_TEXT_FOUND' } } });

    const context = makeContext({
      path: filePath,
      mimetype: 'image/png',
      originalname: 'blank.png',
    });
    await expect(uploadOllamaVisionOCR(context)).rejects.toThrow(/found no readable text/);
  });

  it('gives an actionable error when the configured model is not pulled', async () => {
    const filePath = path.join(os.tmpdir(), `ollama-vision-404-${Date.now()}.png`);
    tempFiles.push(filePath);
    await fs.promises.writeFile(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    mockPost.mockRejectedValueOnce({
      response: {
        status: 404,
        data: { error: 'model "llama3.2-vision" not found, try pulling it first' },
      },
    });

    const context = makeContext({
      path: filePath,
      mimetype: 'image/png',
      originalname: 'scan.png',
    });
    await expect(uploadOllamaVisionOCR(context)).rejects.toThrow(/ollama pull llama3\.2-vision/);
  });

  it('prefers ocr.ollamaBaseURL over OLLAMA_BASE_URL over the localhost default', async () => {
    const filePath = path.join(os.tmpdir(), `ollama-vision-baseurl-${Date.now()}.png`);
    tempFiles.push(filePath);
    await fs.promises.writeFile(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    mockPost.mockResolvedValueOnce({ data: { message: { content: 'text' } } });

    const context = makeContext(
      { path: filePath, mimetype: 'image/png', originalname: 'scan.png' },
      { ollamaVisionModel: 'llama3.2-vision', ollamaBaseURL: 'http://gpu-box:11434' },
    );
    await uploadOllamaVisionOCR(context);

    expect(mockPost.mock.calls[0][0]).toBe('http://gpu-box:11434/api/chat');
  });
});
