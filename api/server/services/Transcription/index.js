/** Audio Transcriber feature - full removal checklist and external touch
 *  points are documented in `client/src/components/AudioTranscriber/README.md`. */
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { setTimeout: sleep } = require('timers/promises');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const {
  generateShortLivedToken,
  logAxiosError,
  getTranscriptionApiUrl,
  realignSegments,
} = require('@librechat/api');
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
 * @param {{includeTimestamps?: boolean; diarize?: boolean; speakerCount?: number; clusteringThreshold?: number; language?: string; contextTerms?: string; model?: string; suppressNumerals?: boolean; channelSplit?: boolean}} [params.options]
 * @param {AbortSignal} [params.signal] - lets a best-effort cancel abort the underlying request
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
async function transcribeAndEmbed({ req, file, sourceFileId, options = {}, signal }) {
  const transcriptionApiUrl = getTranscriptionApiUrl();
  if (!transcriptionApiUrl) {
    throw new Error(
      'Audio transcription is not configured on this server (neither TRANSCRIPTION_API_URL nor RAG_API_URL is set).',
    );
  }

  const {
    includeTimestamps = true,
    diarize = true,
    speakerCount,
    clusteringThreshold,
    language,
    contextTerms,
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
  // Lets `cancelTranscription` (a separate request, fired by
  // `POST /:sourceFileId/cancel`) find and kill this specific run's
  // subprocess on the Python side - see api/watchdog.py's job registry.
  // `sourceFileId` is already this run's unique identity on the Node side,
  // so it's reused as-is rather than minting a second id for the same job.
  formData.append('job_id', sourceFileId);
  formData.append('diarize', String(diarize));
  // Channel-split replaces pyannote clustering outright (each channel is its
  // own speaker) - the speaker-count/threshold hints exist to tune
  // clustering, so they have nothing to apply to here and are left off the
  // request.
  if (channelSplit) {
    formData.append('channel_split', 'true');
  }
  if (diarize && !channelSplit && speakerCount != null) {
    formData.append('speaker_count', String(speakerCount));
  }
  if (diarize && !channelSplit && clusteringThreshold != null) {
    formData.append('clustering_threshold', String(clusteringThreshold));
  }
  if (language) {
    formData.append('language', language);
  }
  // Per-recording accuracy hint - see `build_prompt` in the RAG server's
  // WhisperX service. `contextTerms` is packed into the ASR prompt directly.
  if (contextTerms && contextTerms.trim()) {
    formData.append('context_terms', contextTerms.trim());
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

  logger.info(`[TRANSCRIPTION] POST ${transcriptionApiUrl}/transcribe file=${file.originalname}`);
  const response = await axios.post(`${transcriptionApiUrl}/transcribe`, formData, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      accept: 'application/json',
      ...formData.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    // Kept above the Python service's own PIPELINE_TIMEOUT_S (config.py,
    // currently 1h) so that service is always the one to report a real,
    // specific timeout error and free the GPU lock - this is only a
    // backstop for if Python itself becomes unreachable, not the ceiling
    // that's meant to fire in the normal case.
    timeout: 75 * 60 * 1000,
    // Lets a best-effort cancel (`POST /:sourceFileId/cancel`) actually stop
    // this specific request instead of just discarding its eventual result -
    // see `runTranscriptionJob`'s `registerActiveController`. Kept as its
    // own parameter rather than folded into `options`, which gets persisted
    // verbatim (`transcription.effectiveOptions`) - an `AbortSignal` can't
    // serialize.
    signal,
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

  // Diarization hands each word to whichever turn its timestamp lands in, and
  // at a turn boundary that routinely tears one sentence across two speakers
  // ("Jordan: All" / "Alex: right."). Repaired here, on the rendered text
  // only - `segments` below is still the pipeline's raw output, so the
  // original attribution stays on record in the diarization detail file.
  const text = realignSegments(segments)
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

// Short: this is a "please stop" nudge, not a request expected to do real
// work - if the Python service is unreachable or slow to answer, the caller
// (`POST /:sourceFileId/cancel`) should still return promptly to the user
// rather than hang waiting for it. Aborting Node's own axios request via
// `signal` (see `transcribeAndEmbed`) already makes Node stop listening for
// a result either way; this call is what actually stops the GPU work.
const CANCEL_REQUEST_TIMEOUT_MS = 5 * 1000;

/**
 * Best-effort: tells the Transcription Pipeline service to kill the
 * subprocess it registered for `sourceFileId` (sent as `job_id` on the
 * original `/transcribe` call - see `transcribeAndEmbed`), if that run is
 * still in flight. Never throws - a cancel that can't reach the Python
 * service, or finds nothing left to cancel, is not an error the caller
 * needs to handle differently; `requestCancel`'s own client-side abort
 * already covers Node's side of "stop waiting" regardless.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {string} params.sourceFileId
 * @returns {Promise<boolean>} Whether a running job was actually found and killed.
 */
async function cancelTranscription({ req, sourceFileId }) {
  const transcriptionApiUrl = getTranscriptionApiUrl();
  if (!transcriptionApiUrl) {
    return false;
  }
  const jwtToken = generateShortLivedToken(req.user.id);
  try {
    const response = await axios.post(
      `${transcriptionApiUrl}/transcribe/${encodeURIComponent(sourceFileId)}/cancel`,
      {},
      {
        headers: { Authorization: `Bearer ${jwtToken}`, accept: 'application/json' },
        timeout: CANCEL_REQUEST_TIMEOUT_MS,
      },
    );
    return Boolean(response.data?.cancelled);
  } catch (error) {
    logAxiosError({
      message: `[TRANSCRIPTION] Failed to cancel sourceFileId=${sourceFileId} on the Python service`,
      error,
    });
    return false;
  }
}

module.exports = {
  transcribeAndEmbed,
  embedTranscript,
  cancelTranscription,
  formatTimestamp,
  formatLine,
};
