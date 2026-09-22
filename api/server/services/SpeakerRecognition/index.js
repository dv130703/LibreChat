/** Thin client for the Speaker Recognition service (port 4444 in a
 *  single-machine deployment) - same call shape as
 *  `Transcription/index.js`'s calls into the RAG/WhisperX service: a short-
 *  lived JWT this service validates with the same `JWT_SECRET`, a multipart
 *  upload of the multer temp file already on disk. That service holds no
 *  database of its own (see its own api/README.md) - persisting the
 *  embedding, and resending it back as a match candidate, is entirely this
 *  caller's job.
 */
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const {
  generateShortLivedToken,
  logAxiosError,
  getSpeakerRecognitionApiUrl,
} = require('@librechat/api');

const REQUEST_TIMEOUT_MS = 60 * 1000;

function buildAudioFormData(file) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype,
  });
  return formData;
}

/**
 * `POST /embed` - audio in, a 192-dim ECAPA-TDNN embedding out.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {{path: string, originalname: string, mimetype: string}} params.file - multer file
 * @returns {Promise<number[]>}
 */
async function embedSpeaker({ req, file }) {
  const speakerRecognitionApiUrl = getSpeakerRecognitionApiUrl();
  if (!speakerRecognitionApiUrl) {
    throw new Error(
      'Speaker recognition is not configured on this server (SPEAKER_RECOGNITION_API_URL is not set).',
    );
  }

  const jwtToken = generateShortLivedToken(req.user.id);
  const formData = buildAudioFormData(file);

  try {
    const response = await axios.post(`${speakerRecognitionApiUrl}/embed`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formData.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return response.data.embedding;
  } catch (error) {
    const message = logAxiosError({
      message: '[SpeakerRecognition] POST /embed failed',
      error,
    });
    throw new Error(message);
  }
}

/**
 * `POST /recognize` - an audio clip plus this user's previously-stored
 * embeddings (`candidates`), returns which one it best matches. Stateless on
 * the service's side, so `candidates` is resent on every call.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {{path: string, originalname: string, mimetype: string}} params.file - multer file
 * @param {Array<{label: string, embedding: number[]}>} params.candidates
 * @returns {Promise<{embedding: number[], best_match: string | null, recognized: boolean, scores: Array<{label: string, score: number}>}>}
 */
async function recognizeSpeaker({ req, file, candidates }) {
  const speakerRecognitionApiUrl = getSpeakerRecognitionApiUrl();
  if (!speakerRecognitionApiUrl) {
    throw new Error(
      'Speaker recognition is not configured on this server (SPEAKER_RECOGNITION_API_URL is not set).',
    );
  }

  const jwtToken = generateShortLivedToken(req.user.id);
  const formData = buildAudioFormData(file);
  formData.append('candidates', JSON.stringify(candidates));

  try {
    const response = await axios.post(`${speakerRecognitionApiUrl}/recognize`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formData.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return response.data;
  } catch (error) {
    const message = logAxiosError({
      message: '[SpeakerRecognition] POST /recognize failed',
      error,
    });
    throw new Error(message);
  }
}

module.exports = { embedSpeaker, recognizeSpeaker };
