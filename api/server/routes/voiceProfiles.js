const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { logger } = require('@librechat/data-schemas');
const { inferMimeType, mergeFileConfig } = require('librechat-data-provider');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const configMiddleware = require('~/server/middleware/config/app');
const { storage: uploadStorage } = require('~/server/routes/files/multer');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { embedSpeaker, recognizeSpeaker } = require('~/server/services/SpeakerRecognition');
const db = require('~/models');

const router = express.Router();

const MAX_FULL_NAME_LENGTH = 256;
const MAX_ROLE_LENGTH = 256;
const { serverFileSizeLimit } = mergeFileConfig(undefined);

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: serverFileSizeLimit },
  fileFilter: (req, file, cb) => {
    const mimeType = inferMimeType(file.originalname || '', file.mimetype || '');
    if (mimeType) {
      file.mimetype = mimeType;
    }
    if (!/^audio\//.test(mimeType || '')) {
      return cb(new Error('Only audio files are supported for a voice profile sample'), false);
    }
    cb(null, true);
  },
});

/** Same buffer-based save every storage strategy already exposes for a
 *  small upload (avatars use the identical `saveBuffer` call) - a voice
 *  sample is expected to be a short clip, so there's no need for the
 *  stream-copy path the transcription route uses for multi-hundred-MB
 *  source video. */
async function saveVoiceSample({ req, file, source, fileName }) {
  const { saveBuffer } = getStrategyFunctions(source);
  const buffer = await fs.promises.readFile(file.path);
  return saveBuffer({ userId: req.user.id, fileName, buffer, tenantId: req.user.tenantId });
}

router.use(requireJwtAuth);
router.use(configMiddleware);

router.get('/', async (req, res) => {
  try {
    const profiles = await db.getVoiceProfiles(req.user.id);
    res.status(200).json(profiles);
  } catch (error) {
    logger.error('[GET /api/voice-profiles] Failed to list voice profiles', error);
    res.status(500).json({ error: 'Failed to retrieve voice profiles' });
  }
});

router.post('/', upload.single('file'), async (req, res) => {
  const { file } = req;
  const cleanupUpload = () => fs.promises.unlink(file.path).catch(() => {});

  if (!file) {
    return res.status(400).json({ error: 'An audio recording is required' });
  }

  const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
  const role = typeof req.body.role === 'string' ? req.body.role.trim() : '';
  if (!fullName || fullName.length > MAX_FULL_NAME_LENGTH) {
    await cleanupUpload();
    return res.status(400).json({
      error: `fullName is required and must be at most ${MAX_FULL_NAME_LENGTH} characters`,
    });
  }
  if (!role || role.length > MAX_ROLE_LENGTH) {
    await cleanupUpload();
    return res
      .status(400)
      .json({ error: `role is required and must be at most ${MAX_ROLE_LENGTH} characters` });
  }

  try {
    // Embedded before the audio ever touches storage: a clip the model can't
    // embed (silence, corrupt audio) fails here with nothing yet to roll
    // back, instead of leaving an orphaned blob behind a failed DB write.
    const embedding = await embedSpeaker({ req, file });

    const source = getFileStrategy(req.config, {});
    const filepath = await saveVoiceSample({
      req,
      file,
      source,
      fileName: `${req.file_id}-${file.originalname}`,
    });
    const profile = await db.createVoiceProfile({
      userId: req.user.id,
      fullName,
      role,
      tenantId: req.user.tenantId,
      embedding,
      audio: {
        filepath,
        source,
        type: file.mimetype,
        bytes: file.size,
        filename: file.originalname,
      },
    });
    res.status(201).json(profile);
  } catch (error) {
    logger.error('[POST /api/voice-profiles] Failed to save voice profile', error);
    res.status(502).json({ error: error.message || 'Failed to save voice profile' });
  } finally {
    await cleanupUpload();
  }
});

/**
 * Identifies who's speaking in an audio clip (e.g. one diarized segment out
 * of the Transcription Pipeline) against this user's enrolled voice
 * profiles. The Speaker Recognition service only knows opaque labels and
 * cosine scores - it has no idea a label is a person - so resolving
 * `best_match`/`scores` back to a full name and role, via the profile ids
 * used as candidate labels, is this route's whole reason to exist rather
 * than having the client call that service directly.
 */
router.post('/recognize', upload.single('file'), async (req, res) => {
  const { file } = req;
  const cleanupUpload = () => (file ? fs.promises.unlink(file.path).catch(() => {}) : null);

  if (!file) {
    return res.status(400).json({ error: 'An audio clip is required' });
  }

  try {
    const profiles = await db.getVoiceProfilesWithEmbeddings(req.user.id);
    if (profiles.length === 0) {
      return res.status(200).json({ recognized: false, bestMatch: null, scores: [] });
    }

    const profilesById = new Map(profiles.map((profile) => [String(profile._id), profile]));
    const candidates = profiles.map((profile) => ({
      label: String(profile._id),
      embedding: profile.embedding,
    }));

    const result = await recognizeSpeaker({ req, file, candidates });

    const toIdentity = ({ label, score }) => {
      const profile = profilesById.get(label);
      return {
        id: label,
        fullName: profile?.fullName ?? null,
        role: profile?.role ?? null,
        score,
      };
    };

    const scores = (result.scores || []).map(toIdentity);
    const bestMatch =
      result.recognized && result.best_match != null
        ? (scores.find((entry) => entry.id === result.best_match) ?? null)
        : null;

    res.status(200).json({ recognized: result.recognized, bestMatch, scores });
  } catch (error) {
    logger.error('[POST /api/voice-profiles/recognize] Failed to recognize speaker', error);
    res.status(502).json({ error: error.message || 'Failed to recognize speaker' });
  } finally {
    await cleanupUpload();
  }
});

module.exports = router;
