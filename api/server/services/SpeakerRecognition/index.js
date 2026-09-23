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

/**
 * Matches an audio clip against a user's already-fetched voice profiles.
 * Shared by `POST /api/voice-profiles/recognize` and the automatic
 * speaker-labeling step run after transcription - both need the same
 * candidate-building and score-to-identity mapping, just against a clip that
 * arrives differently (a direct upload vs. one cut from the source
 * recording).
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {{path: string, originalname: string, mimetype: string}} params.file - multer file
 * @param {Array<{_id: string, fullName: string, role: string, embedding: number[]}>} params.profiles
 * @param {typeof recognizeSpeaker} [params.recognize] - injected for tests
 * @returns {Promise<{recognized: boolean, bestMatch: {id: string, fullName: string, role: string, score: number} | null, scores: Array<{id: string, fullName: string, role: string, score: number}>}>}
 */
async function matchAgainstProfiles({ req, file, profiles, recognize = recognizeSpeaker }) {
  if (profiles.length === 0) {
    return { recognized: false, bestMatch: null, scores: [] };
  }

  const profilesById = new Map(profiles.map((profile) => [String(profile._id), profile]));
  const candidates = profiles.map((profile) => ({
    label: String(profile._id),
    embedding: profile.embedding,
  }));

  const result = await recognize({ req, file, candidates });

  const toIdentity = ({ label, score }) => {
    const profile = profilesById.get(label);
    return { id: label, fullName: profile?.fullName ?? null, role: profile?.role ?? null, score };
  };

  const scores = (result.scores || []).map(toIdentity);
  const bestMatch =
    result.recognized && result.best_match != null
      ? (scores.find((entry) => entry.id === result.best_match) ?? null)
      : null;

  return { recognized: result.recognized, bestMatch, scores };
}

module.exports = { embedSpeaker, recognizeSpeaker, matchAgainstProfiles };
