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
const {
  formatTranscriptLine: formatLine,
  formatTranscriptTimestamp: formatTimestamp,
} = require('librechat-data-provider');
const { uploadVectors } = require('~/server/services/Files/VectorDB/crud');

// A RAG-server hiccup (a restart, a momentary connection reset) is the
// realistic failure this guards against - not a persistent outage, which no
// number of retries within one request's lifetime can paper over anyway.
// Total added latency on a full failure is bounded (~2s) rather than left to
// axios's own connection-level retry behavior (none) or an unbounded loop.
const EMBED_MAX_ATTEMPTS = 3;
const EMBED_RETRY_DELAYS_MS = [500, 1500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Embeds a finished transcript into RAG under a deterministic, source-file-derived
 * id, scoped to nothing but that id (no entity_id) so it never surfaces via any
 * other conversation's file_search. `uploadVectors` only reads from a real path on
 * disk, so the transcript is written to a throwaway temp file for the call and
 * removed immediately after, win or lose. Retries transient failures up to
 * `EMBED_MAX_ATTEMPTS` times before giving up - see `EMBED_MAX_ATTEMPTS`.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {string} params.file_id - Deterministic id, e.g. `${sourceFileId}-transcript`.
 * @param {string} params.filename
 * @param {string} params.text
 * @returns {Promise<boolean>} Whether the RAG server accepted and embedded it,
 *   after retries.
 */
async function embedTranscript({ req, file_id, filename, text }) {
  const tmpPath = path.join(os.tmpdir(), `transcribe-${file_id}-${Date.now()}.md`);
  try {
    await fsPromises.writeFile(tmpPath, text, 'utf8');
    for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt += 1) {
      try {
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
        logAxiosError({
          message: `Error embedding transcript into RAG (attempt ${attempt}/${EMBED_MAX_ATTEMPTS})`,
          error,
        });
        if (attempt === EMBED_MAX_ATTEMPTS) {
          return false;
        }
        await sleep(EMBED_RETRY_DELAYS_MS[attempt - 1]);
      }
    }
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
 * @param {{includeTimestamps?: boolean; diarize?: boolean; minSpeakers?: number; maxSpeakers?: number; clusteringThreshold?: number; language?: string; contextTerms?: string; context?: string; model?: string; suppressNumerals?: boolean; channelSplit?: boolean}} [params.options]
 * @returns {Promise<{
 *   segments: Array<{start: number; end: number; speaker: string; text: string; assignmentMethod?: string; words?: Array<{word: string; start?: number; end?: number; speaker?: string; assignmentMethod: string}>}>,
 *   language: string | undefined,
 *   diagnostics: Record<string, unknown> | undefined,
 *   diarizationTurns: Array<{start: number; end: number; speaker: string}>,
 *   speakerEmbeddings: Record<string, number[]> | null,
 *   recordingProfile: Record<string, unknown> | null,
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
    clusteringThreshold,
    language,
    contextTerms,
    context,
    model,
    suppressNumerals,
    channelSplit,
  } = options;

  const jwtToken = generateShortLivedToken(req.user.id);
  const formData = new FormData();
  formData.append('file', fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype,
  });
  formData.append('diarize', String(diarize));
  // Channel-split replaces pyannote clustering outright (each channel is its
  // own speaker) - the min/max/threshold hints exist to tune clustering, so
  // they have nothing to apply to here and are left off the request.
  if (channelSplit) {
    formData.append('channel_split', 'true');
  }
  if (diarize && !channelSplit && minSpeakers != null) {
    formData.append('min_speakers', String(minSpeakers));
  }
  if (diarize && !channelSplit && maxSpeakers != null) {
    formData.append('max_speakers', String(maxSpeakers));
  }
  if (diarize && !channelSplit && clusteringThreshold != null) {
    formData.append('clustering_threshold', String(clusteringThreshold));
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
  // Explicitly forwarded even when false: digits are suppressed at the decoder,
  // so `false` is a real instruction ("emit numerals"), not an absent option.
  if (suppressNumerals != null) {
    formData.append('suppress_numerals', String(suppressNumerals));
  }
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

  const {
    segments = [],
    language: detectedLanguage,
    diagnostics,
    diarization_turns: diarizationTurns = [],
    speaker_embeddings: speakerEmbeddings = null,
    recording_profile: recordingProfile = null,
  } = response.data ?? {};
  if (segments.length === 0) {
    return {
      segments,
      language: detectedLanguage,
      diagnostics,
      diarizationTurns,
      speakerEmbeddings,
      recordingProfile,
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

  return {
    segments,
    language: detectedLanguage,
    diagnostics,
    diarizationTurns,
    speakerEmbeddings,
    recordingProfile,
    text,
    transcriptFileId,
    embedded,
  };
}

module.exports = { transcribeAndEmbed, embedTranscript, formatTimestamp, formatLine };
