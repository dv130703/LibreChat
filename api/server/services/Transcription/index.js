/** Audio Transcriber feature - full removal checklist and external touch
 *  points are documented in `client/src/components/AudioTranscriber/README.md`. */
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { generateShortLivedToken, logAxiosError } = require('@librechat/api');
const { uploadVectors } = require('~/server/services/Files/VectorDB/crud');

/** "125.34" seconds -> "02:05.3". Kept to tenths of a second (not rounded to
 *  a whole second) so the client can bound single-line/turn playback without
 *  cutting into, or leaking audio from, the next line - whole-second
 *  precision left up to half a second of slack on each side of a boundary,
 *  which is audible. All-integer tenths math avoids float rollover bugs
 *  (e.g. 59.96s must become 01:00.0, not 00:59.10). Segments run well past
 *  an hour for long recordings. */
function formatTimestamp(seconds) {
  const totalTenths = Math.max(0, Math.round(seconds * 10));
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = `${String(s).padStart(2, '0')}.${tenths}`;
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Renders one transcript line, honoring the user's timestamp/diarization choices
 *  independently - either, both, or neither may be on. Both the segment's start
 *  AND its own end are written out - the client bounds single-line/turn playback
 *  against this segment's real end, not (as before) the next segment's start,
 *  which is a different value that can sit noticeably later than where this
 *  segment's speech actually stops, letting the next speaker's audio bleed in. */
function formatLine(segment, { includeTimestamps, diarize }) {
  const parts = [];
  if (includeTimestamps) {
    parts.push(`[${formatTimestamp(segment.start)}-${formatTimestamp(segment.end)}]`);
  }
  if (diarize) {
    parts.push(`${segment.speaker}:`);
  }
  parts.push(segment.text);
  return parts.join(' ');
}

/**
 * Embeds a finished transcript into RAG under a deterministic, source-file-derived
 * id, scoped to nothing but that id (no entity_id) so it never surfaces via any
 * other conversation's file_search. `uploadVectors` only reads from a real path on
 * disk, so the transcript is written to a throwaway temp file for the call and
 * removed immediately after, win or lose.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {string} params.file_id - Deterministic id, e.g. `${sourceFileId}-transcript`.
 * @param {string} params.filename
 * @param {string} params.text
 * @returns {Promise<boolean>} Whether the RAG server accepted and embedded it.
 */
async function embedTranscript({ req, file_id, filename, text }) {
  const tmpPath = path.join(os.tmpdir(), `transcribe-${file_id}-${Date.now()}.md`);
  try {
    await fsPromises.writeFile(tmpPath, text, 'utf8');
    const result = await uploadVectors({
      req,
      file: {
        path: tmpPath,
        originalname: filename,
        mimetype: 'text/markdown',
        size: Buffer.byteLength(text, 'utf8'),
      },
      file_id,
      logLabel: 'TRANSCRIPTION',
    });
    return Boolean(result?.embedded);
  } catch (error) {
    logAxiosError({ message: 'Error embedding transcript into RAG', error });
    return false;
  } finally {
    await fsPromises.unlink(tmpPath).catch(() => {});
  }
}

/**
 * Transcribes one audio/video file via the RAG server's WhisperX endpoint and
 * embeds the resulting transcript into RAG for later `file_search` retrieval.
 * Plain service function - no LangChain tool wrapper, no LLM in the loop; the
 * caller (the `/api/transcribe` route) already knows the user wants this to run.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {{path: string, originalname: string, mimetype: string}} params.file - multer file
 * @param {string} params.sourceFileId - id of the persisted source file; the transcript's
 *   own id is derived from it (`${sourceFileId}-transcript`) so re-transcribing the same
 *   source overwrites its transcript instead of leaking a duplicate.
 * @param {{includeTimestamps?: boolean; diarize?: boolean; minSpeakers?: number; maxSpeakers?: number; language?: string; contextTerms?: string; context?: string; model?: string}} [params.options]
 * @returns {Promise<{
 *   segments: Array<{start: number; end: number; speaker: string; text: string}>,
 *   language: string | undefined,
 *   diagnostics: Record<string, unknown> | undefined,
 *   text: string,
 *   transcriptFileId: string | null,
 *   embedded: boolean,
 * }>}
 */
async function transcribeAndEmbed({ req, file, sourceFileId, options = {} }) {
  if (!process.env.RAG_API_URL) {
    throw new Error(
      'Audio transcription is not configured on this server (RAG_API_URL is not set).',
    );
  }

  const {
    includeTimestamps = true,
    diarize = true,
    minSpeakers,
    maxSpeakers,
    language,
    contextTerms,
    context,
    model,
  } = options;

  const jwtToken = generateShortLivedToken(req.user.id);
  const formData = new FormData();
  formData.append('file', fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype,
  });
  formData.append('diarize', String(diarize));
  if (diarize && minSpeakers != null) {
    formData.append('min_speakers', String(minSpeakers));
  }
  if (diarize && maxSpeakers != null) {
    formData.append('max_speakers', String(maxSpeakers));
  }
  if (language) {
    formData.append('language', language);
  }
  // Per-recording accuracy hints - see `build_prompt` in the RAG server's
  // WhisperX service. `contextTerms` is packed into the ASR prompt directly;
  // `context` (free-text prose) is only mined for proper nouns, never sent
  // to the model verbatim.
  if (contextTerms && contextTerms.trim()) {
    formData.append('context_terms', contextTerms.trim());
  }
  if (context && context.trim()) {
    formData.append('context', context.trim());
  }
  // Undefined/omitted uses the RAG server's own configured default
  // (WHISPERX_WHISPER_MODEL) - the server is also the one place that
  // validates this against its allow-list (see `rag_server/app.py`), so
  // nothing here needs to duplicate that check.
  if (model) {
    formData.append('model', model);
  }

  logger.info(
    `[TRANSCRIPTION] POST ${process.env.RAG_API_URL}/transcribe file=${file.originalname}`,
  );
  const response = await axios.post(`${process.env.RAG_API_URL}/transcribe`, formData, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      accept: 'application/json',
      ...formData.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    // WhisperX on a long recording can legitimately take minutes, even with
    // large-v3-turbo on a GPU.
    timeout: 15 * 60 * 1000,
  });

  const { segments = [], language: detectedLanguage, diagnostics } = response.data ?? {};
  if (segments.length === 0) {
    return {
      segments,
      language: detectedLanguage,
      diagnostics,
      text: '',
      transcriptFileId: null,
      embedded: false,
    };
  }

  const text = segments
    .map((segment) => formatLine(segment, { includeTimestamps, diarize }))
    .join('\n');
  const transcriptFileId = `${sourceFileId}-transcript`;
  const embedded = await embedTranscript({
    req,
    file_id: transcriptFileId,
    filename: `${file.originalname}-transcript.md`,
    text,
  });

  return { segments, language: detectedLanguage, diagnostics, text, transcriptFileId, embedded };
}

module.exports = { transcribeAndEmbed, embedTranscript, formatTimestamp, formatLine };
