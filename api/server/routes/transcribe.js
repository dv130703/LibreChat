const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { logger } = require('@librechat/data-schemas');
const {
  inferMimeType,
  mergeFileConfig,
  FileContext,
  FileSources,
} = require('librechat-data-provider');
const { getStorageMetadata, extractAudioTrack } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const configMiddleware = require('~/server/middleware/config/app');
const { storage: uploadStorage } = require('~/server/routes/files/multer');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { saveTranscriptFile } = require('~/server/services/Files/process');
const { getRetentionExpiry } = require('~/server/services/Files/retention');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { transcribeAndEmbed } = require('~/server/services/Transcription');
const localPaths = require('~/config/paths');
const db = require('~/models');

/**
 * Stores the uploaded source audio/video file. Local-strategy uploads stream-copy
 * the multer temp file directly to its destination instead of buffering the whole
 * file in memory and writing it synchronously (`saveLocalBuffer` uses
 * `fs.writeFileSync`, which blocks the event loop for the entire write) - a
 * multi-hundred-MB video would otherwise stall the whole server for minutes.
 */
async function saveSourceFile({ req, file, source, fileName }) {
  if (source !== FileSources.local) {
    const { saveBuffer } = getStrategyFunctions(source);
    const buffer = await fs.promises.readFile(file.path);
    return saveBuffer({ userId: req.user.id, fileName, buffer, tenantId: req.user.tenantId });
  }

  const directoryPath = path.join(localPaths.publicPath, 'images', req.user.id);
  await fs.promises.mkdir(directoryPath, { recursive: true });
  await fs.promises.copyFile(file.path, path.join(directoryPath, fileName));
  return path.posix.join('/', 'images', req.user.id, fileName);
}

const router = express.Router();
router.use(requireJwtAuth);
router.use(configMiddleware);

const AUDIO_VIDEO_PREFIX = /^(audio|video)\//;
/** Static default (512MB) - admin-configured `fileSizeLimit` overrides don't
 *  apply to this route yet; a reasonable simplification for a first pass. */
const { serverFileSizeLimit } = mergeFileConfig(undefined);

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: serverFileSizeLimit },
  fileFilter: (req, file, cb) => {
    const mimeType = inferMimeType(file.originalname || '', file.mimetype || '');
    if (mimeType) {
      file.mimetype = mimeType;
    }
    if (!AUDIO_VIDEO_PREFIX.test(mimeType || '')) {
      return cb(new Error('Only audio/video files are supported for transcription'), false);
    }
    cb(null, true);
  },
});

/**
 * Transcribes an uploaded audio/video file and embeds the transcript into RAG,
 * scoped to a single conversation - a direct REST action the user triggers from
 * the Audio Transcriber page, not a tool the model decides to call. Because this
 * runs before any chat message exists, `file_search` can be forced on for the
 * conversation from the very first turn (no "not bound this turn" race).
 */
router.post('/', upload.single('file'), async (req, res) => {
  const { file } = req;
  if (!file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const extractedAudioPath = `${file.path}-audio.m4a`;
  const cleanupTempFile = () =>
    Promise.all([
      fs.promises.unlink(file.path).catch(() => {}),
      fs.promises.unlink(extractedAudioPath).catch(() => {}),
    ]);

  const { conversationId, endpoint, agent_id } = req.body;
  if (!conversationId) {
    await cleanupTempFile();
    return res.status(400).json({ error: 'conversationId is required' });
  }

  let options = {};
  try {
    options = req.body.options ? JSON.parse(req.body.options) : {};
  } catch {
    await cleanupTempFile();
    return res.status(400).json({ error: 'Invalid options payload' });
  }

  // Tracks what's actually been persisted so a mid-way failure can be rolled
  // back below - otherwise a failed transcription (diarization errors are
  // common on short/quiet clips) leaves a broken, sidebar-visible
  // conversation behind: no transcript file, so `RedirectGuard` never
  // recognizes it as belonging to this feature, and revisiting it later
  // renders as a plain chat (Presets/model-selector-in-header back, no
  // audio player) - looking exactly like the feature "reverted."
  let sourceFile = null;
  let sourceFileSource = null;
  let conversationCreated = false;

  try {
    // Must exist before `addConvoFile` (a bare, non-upserting update) can attach
    // the transcript to it - this is the very first write for a fresh session.
    // `conversationId` is always a fresh `crypto.randomUUID()` minted by the
    // Audio Transcriber upload flow (see `UploadStep.tsx`), never a
    // pre-existing conversation, so it's always safe to fully delete on failure.
    await db.saveConvo(
      { userId: req.user.id },
      { conversationId, title: file.originalname, endpoint, agent_id },
      { context: 'POST /api/transcribe' },
    );
    conversationCreated = true;
    logger.info(`[TRANSCRIPTION] conversation ready conversationId=${conversationId}`);

    // Video keyframes commonly sit several seconds apart, and browsers snap
    // seeks to the nearest one - fine for scrubbing a movie, but far too
    // imprecise for jumping to one transcript line. Extracting just the
    // audio (uniformly, even for audio-only uploads) is what makes per-line
    // playback seeking land where it's supposed to; it's also what gets
    // transcribed, since WhisperX only ever needed the audio anyway.
    await extractAudioTrack(file.path, extractedAudioPath);
    const audioFile = {
      path: extractedAudioPath,
      originalname: `${path.parse(file.originalname).name}.m4a`,
      mimetype: 'audio/mp4',
      size: (await fs.promises.stat(extractedAudioPath)).size,
    };

    sourceFileSource = getFileStrategy(req.config, { isImage: false });
    const filepath = await saveSourceFile({
      req,
      file: audioFile,
      source: sourceFileSource,
      fileName: `${req.file_id}-${audioFile.originalname}`,
    });
    const storageMetadata = getStorageMetadata({ filepath, source: sourceFileSource });
    sourceFile = await db.createFile(
      {
        type: audioFile.mimetype,
        source: sourceFileSource,
        context: FileContext.transcript_rag,
        file_id: req.file_id,
        filepath,
        ...storageMetadata,
        filename: audioFile.originalname,
        user: req.user.id,
        bytes: audioFile.size,
        conversationId,
        ...(await getRetentionExpiry(req)),
        tenantId: req.user.tenantId,
      },
      true,
    );
    await db.addConvoFile(conversationId, sourceFile.file_id);
    logger.info(`[TRANSCRIPTION] source file stored file_id=${sourceFile.file_id}`);

    const result = await transcribeAndEmbed({
      req,
      file: audioFile,
      sourceFileId: sourceFile.file_id,
      options,
    });
    logger.info(
      `[TRANSCRIPTION] transcribeAndEmbed done segments=${result.segments.length} embedded=${result.embedded}`,
    );

    let transcriptFile = null;
    if (result.transcriptFileId) {
      transcriptFile = await saveTranscriptFile({
        req,
        file_id: result.transcriptFileId,
        filename: `${file.originalname}-transcript.md`,
        text: result.text,
        conversationId,
        embedded: result.embedded,
      });
      logger.info(`[TRANSCRIPTION] transcript file saved file_id=${transcriptFile.file_id}`);
      await db.addConvoFile(conversationId, transcriptFile.file_id);
      logger.info(`[TRANSCRIPTION] transcript attached to conversation`);
    }

    logger.info(`[TRANSCRIPTION] responding conversationId=${conversationId}`);
    res.json({
      conversationId,
      segments: result.segments,
      language: result.language,
      diagnostics: result.diagnostics,
      sourceFile: { file_id: sourceFile.file_id, filename: sourceFile.filename },
      transcriptFile: transcriptFile
        ? { file_id: transcriptFile.file_id, filename: transcriptFile.filename }
        : null,
    });
  } catch (error) {
    logger.error('[POST /api/transcribe] Failed to transcribe file', error);
    res.status(500).json({ error: error.message || 'Failed to transcribe file' });

    // Best-effort rollback so a failed attempt never leaves a broken,
    // un-flaggable conversation sitting in the sidebar. Never let a cleanup
    // failure surface - the 500 above has already been sent.
    try {
      if (sourceFile) {
        const { deleteFile: deleteStoredFile } = getStrategyFunctions(sourceFileSource);
        if (deleteStoredFile) {
          await deleteStoredFile(req, sourceFile).catch(() => {});
        }
        await db.deleteFile(sourceFile.file_id);
      }
      if (conversationCreated) {
        await db.deleteConvos(req.user.id, { conversationId });
      }
    } catch (cleanupError) {
      logger.error('[POST /api/transcribe] Failed to roll back failed transcription', cleanupError);
    }
  } finally {
    await cleanupTempFile();
  }
});

module.exports = router;
