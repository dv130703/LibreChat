import * as fs from 'fs';
import { logger } from '@librechat/data-schemas';
import { imageMimeTypes } from 'librechat-data-provider';
import type { Canvas, SKRSContext2D, createCanvas as CreateCanvasFn } from '@napi-rs/canvas';
import type { AxiosError } from 'axios';
import type { MistralOCRUploadResult, ServerRequest } from '~/types';
import { logAxiosError, createAxiosInstance } from '~/utils/axios';

const axios = createAxiosInstance();

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
/** Longest side a rendered page image is scaled to before OCR - keeps the request payload and
 * the vision model's own image-tokenizer cost bounded regardless of the PDF's original page size. */
const MAX_IMAGE_DIMENSION = 1800;
/** Hard cap on pages processed per document. Each page is one full vision-model inference on a
 * local machine, so an unbounded loop over a hundred-page PDF could stall the request indefinitely. */
const MAX_OCR_PAGES = 20;
/** Per-page inference timeout. Local vision models can be slow, especially without a dedicated GPU. */
const PAGE_TIMEOUT_MS = 5 * 60 * 1000;

const TRANSCRIBE_PROMPT =
  'Transcribe every piece of text visible in this image exactly as it appears, preserving line ' +
  'breaks and reading order. Output only the transcribed text - no description, summary, or ' +
  'commentary. If the image contains no readable text at all, respond with exactly: NO_TEXT_FOUND';

const NO_TEXT_MARKER = 'NO_TEXT_FOUND';

interface OCRContext {
  req: ServerRequest;
  file: Express.Multer.File;
  loadAuthValues: (params: {
    userId: string;
    authFields: string[];
    optional?: Set<string>;
  }) => Promise<Record<string, string | undefined>>;
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  error?: string;
}

/** `pdfjs-dist` has no DOM `<canvas>` in Node - this factory backs its renderer with
 * `@napi-rs/canvas` instead, matching the shape pdfjs's own Node examples expect.
 * Takes `createCanvas` as a constructor param rather than importing it at module scope:
 * `@napi-rs/canvas` loads a native binding on require, and `@librechat/api` is a shared
 * barrel - a top-level import here would load that binding for every consumer of the
 * package, not just OCR, and has been observed to break unrelated native-module loads
 * (e.g. DALL-E's tool) when eagerly initialized this way. */
class NodeCanvasFactory {
  constructor(private readonly createCanvas: typeof CreateCanvasFn) {}

  create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D } {
    const canvas = this.createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }

  reset(
    canvasAndContext: { canvas: Canvas; context: SKRSContext2D },
    width: number,
    height: number,
  ): void {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: { canvas: Canvas | null; context: SKRSContext2D | null }): void {
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function resolveModel(ocrConfig?: { ollamaVisionModel?: string }): string {
  const model = ocrConfig?.ollamaVisionModel?.trim();
  if (!model) {
    throw new Error(
      'ocr.ollamaVisionModel is not set in librechat.yaml. Pull a vision-capable model ' +
        '(e.g. `ollama pull llama3.2-vision`) and set ocr.ollamaVisionModel to its name.',
    );
  }
  return model;
}

function resolveBaseURL(ocrConfig?: { ollamaBaseURL?: string }): string {
  return (
    ocrConfig?.ollamaBaseURL?.trim() ||
    process.env.OLLAMA_BASE_URL?.trim() ||
    DEFAULT_OLLAMA_BASE_URL
  ).replace(/\/+$/, '');
}

/** Sends one page image to the configured local vision model and returns its transcription,
 * or `''` when the model reports no readable text. */
async function transcribeImage({
  baseURL,
  model,
  imageBase64,
}: {
  baseURL: string;
  model: string;
  imageBase64: string;
}): Promise<string> {
  let response;
  try {
    response = await axios.post<OllamaChatResponse>(
      `${baseURL}/api/chat`,
      {
        model,
        stream: false,
        messages: [{ role: 'user', content: TRANSCRIBE_PROMPT, images: [imageBase64] }],
      },
      { timeout: PAGE_TIMEOUT_MS },
    );
  } catch (error) {
    const axiosError = error as AxiosError<{ error?: string }>;
    const detail = axiosError.response?.data?.error ?? '';
    if (axiosError.response?.status === 404 || /not found/i.test(detail)) {
      throw new Error(
        `Ollama model "${model}" is not available (${detail || 'not found'}). Pull it first: ` +
          `\`ollama pull ${model}\``,
      );
    }
    throw new Error(
      logAxiosError({ error: axiosError, message: 'Error calling Ollama vision model' }),
    );
  }

  const content = response.data?.message?.content?.trim() ?? '';
  if (!content || content === NO_TEXT_MARKER) {
    return '';
  }
  return content;
}

/** Renders `file` (a PDF) to one PNG per page, scaled so its longest side is
 * `MAX_IMAGE_DIMENSION`, and returns each as a base64 string (no data URI prefix). */
async function renderPdfPagesToImages(filePath: string): Promise<string[]> {
  // Imported inline so Jest can test other routes without loading pdfjs's ESM build, and so
  // `@napi-rs/canvas`'s native binding only loads when a PDF is actually being OCR'd (see the
  // NodeCanvasFactory comment above).
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');

  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const canvasFactory = new NodeCanvasFactory(createCanvas);
  /* pdfjs-dist's TS types model the browser's DOM canvas; `canvasFactory` is a real,
   * documented option of the legacy Node build that its types don't reflect. */
  const pdf = await getDocument({ data, canvasFactory } as Parameters<typeof getDocument>[0])
    .promise;

  const pageCount = Math.min(pdf.numPages, MAX_OCR_PAGES);
  if (pdf.numPages > MAX_OCR_PAGES) {
    logger.warn(
      `[uploadOllamaVisionOCR] "${filePath}" has ${pdf.numPages} pages; only the first ${MAX_OCR_PAGES} will be OCR'd.`,
    );
  }

  const images: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      3,
      MAX_IMAGE_DIMENSION / Math.max(baseViewport.width, baseViewport.height),
    );
    const viewport = page.getViewport({ scale: Math.max(scale, 0.1) });
    const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
    /* Same DOM-vs-Node-canvas type mismatch as above: `render` only needs the small
     * subset of CanvasRenderingContext2D that SKRSContext2D already implements. */
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise;
    images.push(canvas.encodeSync('png').toString('base64'));
  }

  return images;
}

/**
 * Uses a local, self-hosted vision-capable Ollama model as an OCR engine: renders each page of a
 * scanned/image-only document to an image and asks the model to transcribe its visible text.
 * Requires `ocr.ollamaVisionModel` to name a vision-capable model already pulled on the target
 * Ollama instance - no external API or key is used.
 *
 * @throws {Error} if `ocr.ollamaVisionModel` is unset, the file type isn't supported (PDF or
 *   image), the model isn't pulled, or the model produced no transcribable text on any page.
 */
export const uploadOllamaVisionOCR = async (
  context: OCRContext,
): Promise<MistralOCRUploadResult> => {
  const ocrConfig = context.req.config?.ocr;
  const model = resolveModel(ocrConfig);
  const baseURL = resolveBaseURL(ocrConfig);
  const { file } = context;
  const mimetype = (file.mimetype || '').toLowerCase();

  let pageImages: string[];
  if (mimetype === 'application/pdf') {
    pageImages = await renderPdfPagesToImages(file.path);
  } else if (imageMimeTypes.test(mimetype)) {
    pageImages = [(await fs.promises.readFile(file.path)).toString('base64')];
  } else {
    throw new Error(
      `Ollama vision OCR only supports PDFs and images directly - "${file.originalname}" is ${file.mimetype}.`,
    );
  }

  const pageTexts: string[] = [];
  for (let i = 0; i < pageImages.length; i++) {
    const text = await transcribeImage({ baseURL, model, imageBase64: pageImages[i] });
    if (text) {
      pageTexts.push(pageImages.length > 1 ? `# PAGE ${i + 1}\n${text}` : text);
    }
  }

  const text = pageTexts.join('\n\n').trim();
  if (!text) {
    throw new Error(
      `Ollama vision model "${model}" found no readable text in "${file.originalname}".`,
    );
  }

  return {
    filename: file.originalname,
    bytes: Buffer.byteLength(text, 'utf8'),
    filepath: 'ollama_vision',
    text,
    images: [],
  };
};
