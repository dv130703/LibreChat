const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const express = require('express');
const multer = require('multer');
const { logger } = require('@librechat/data-schemas');
const {
  inferMimeType,
  mergeFileConfig,
  FileContext,
  FileSources,
} = require('librechat-data-provider');
const {
  getStorageMetadata,
  extractAudioTrack,
  generateShortLivedToken,
  applyTranscriptCorrectionsStructured,
  buildInterviewDocx,
  buildMeetingMinutesDocx,
  buildDiarizationDetail,
  stripSegmentDetail,
} = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const configMiddleware = require('~/server/middleware/config/app');
const { storage: uploadStorage } = require('~/server/routes/files/multer');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const {
  saveTranscriptFile,
  saveDiarizationDetailFile,
} = require('~/server/services/Files/process');
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

/**
 * The option set a transcript came from, plus the model that actually served
 * it. Stored on the conversation so the transcript pane can say which model
 * wrote it, and so a re-transcribe starts from these rather than the dialog's
 * defaults. `model_used` is the server's resolved choice - the only reliable
 * answer when the caller left the model on "auto".
 */
function buildTranscriptionMeta(options, result) {
  return {
    model: result.diagnostics?.model_used,
    requestedModel: result.diagnostics?.model_requested,
    language: result.language,
    diarize: options.diarize,
    minSpeakers: options.minSpeakers,
    maxSpeakers: options.maxSpeakers,
    clusteringThreshold: options.clusteringThreshold,
    includeTimestamps: options.includeTimestamps,
    contextTerms: options.contextTerms,
    context: options.context,
    // The resolved value the decoder ran under, not the request's - the caller
    // may have left it unset and taken the deployment default.
    suppressNumerals: result.diagnostics?.suppress_numerals,
    channelSplit: options.channelSplit,
    diarizationBackend: result.diagnostics?.diarization_backend,
  };
}

/**
 * Persists the full diarization/ASR detail (raw pyannote turns, speaker
 * embeddings, per-word speaker assignments) as its own file, separate from
 * the plain transcript - see `saveDiarizationDetailFile`. Used by both the
 * initial transcribe route and `/retranscribe`, always keyed off the same
 * `sourceFileId` so a re-transcribe overwrites this record rather than
 * leaking a duplicate, same as the transcript file itself.
 */
/** The transcript file's indexing state, alongside its identity - lets a
 *  caller tell "indexed and current" apart from "still indexing" or "the
 *  last index attempt failed" without a separate lookup. */
function toTranscriptFilePayload(transcriptFile) {
  if (!transcriptFile) {
    return null;
  }
  return {
    file_id: transcriptFile.file_id,
    filename: transcriptFile.filename,
    transcriptVersion: transcriptFile.transcriptVersion ?? 0,
    indexVersion: transcriptFile.indexVersion ?? null,
    indexStatus: transcriptFile.indexStatus ?? 'not_indexed',
  };
}

async function persistDiarizationDetail({ req, sourceFileId, filename, result, conversationId }) {
  const detail = buildDiarizationDetail({
    segments: result.segments,
    diarizationTurns: result.diarizationTurns,
    speakerEmbeddings: result.speakerEmbeddings,
    diagnostics: result.diagnostics ?? {},
    recordingProfile: result.recordingProfile ?? null,
  });
  const diarizationDetailFile = await saveDiarizationDetailFile({
    req,
    file_id: `${sourceFileId}-diarization-detail`,
    filename: `${filename}-diarization-detail.json`,
    detail,
    conversationId,
  });
  await db.addConvoFile(conversationId, diarizationDetailFile.file_id);
  return diarizationDetailFile;
}

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
 * When `transcribeAndEmbed`'s call to the RAG/WhisperX service fails, the
 * thrown error is an Axios error whose own `.message` is just the generic
 * "Request failed with status code 500" - the actually useful diagnosis
 * (e.g. "Diarization produced no speaker segments...") lives one level
 * deeper, in the response body the service sent back. Surfacing that instead
 * is the difference between a client error card that says something
 * genuinely actionable and one that just repeats an HTTP status code.
 */
function getTranscribeErrorMessage(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail) {
    return detail;
  }
  const nestedError = error?.response?.data?.error;
  if (typeof nestedError === 'string' && nestedError) {
    return nestedError;
  }
  return error?.message || 'Failed to transcribe file';
}

/**
 * Transcribes an uploaded audio/video file and embeds the transcript into RAG,
 * scoped to a single conversation - a direct REST action the user triggers from
 * the Audio Transcriber page, not a tool the model decides to call. Because this
 * runs before any chat message exists, `file_search` can be forced on for the
 * conversation from the very first turn (no "not bound this turn" race).
 */
/**
 * This deployment's effective transcription defaults, proxied from the ASR
 * server. The client needs it to label its own "auto" options with the value
 * they actually resolve to - an unlabelled auto is how a recording gets
 * transcribed by a model nobody chose.
 */
router.get('/config', async (req, res) => {
  if (!process.env.RAG_API_URL) {
    return res.status(503).json({
      error: 'Audio transcription is not configured on this server (RAG_API_URL is not set).',
    });
  }
  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const response = await axios.get(`${process.env.RAG_API_URL}/transcribe/config`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
      timeout: 10 * 1000,
    });
    res.json(response.data);
  } catch (error) {
    logger.error('[GET /api/transcribe/config] Failed', error);
    res.status(502).json({ error: 'Could not read transcription defaults' });
  }
});

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
  // back below. The conversation is now only written once the transcript
  // exists (see `saveConvo` further down), so the common failures - diarization
  // errors on short or quiet clips - can no longer strand one. What remains is
  // the narrow window after that write: a conversation whose transcript file
  // failed to save is one `RedirectGuard` can't recognize as belonging to this
  // feature, and revisiting it renders as a plain chat (Presets and the
  // model-selector back in the header, no audio player) - looking exactly like
  // the feature "reverted." The source file is rolled back for its own sake,
  // being a stored upload nothing would ever reference again.
  let sourceFile = null;
  let sourceFileSource = null;
  let conversationCreated = false;

  try {
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

    // Deliberately the first conversation write, and deliberately *after* the
    // transcription rather than before it. A conversation saved up front is
    // sidebar-visible for the entire minutes-long transcription while carrying
    // nothing that can be opened: no transcript file yet, so `RedirectGuard`
    // can't tell it belongs to this feature, and clicking it lands on a plain,
    // empty chat window instead of the transcriber. Nothing between here and
    // the upload needs the conversation to exist - `transcribeAndEmbed` works
    // off the temp file and `req.file_id` alone - so the row is simply not
    // written until there is something behind it.
    //
    // Still ahead of both `addConvoFile` calls below: those are bare,
    // non-upserting updates with nothing to attach to until this row exists.
    //
    // `conversationId` is always a fresh `crypto.randomUUID()` minted by the
    // Audio Transcriber upload flow (see `UploadStep.tsx`), never a
    // pre-existing conversation, so it's always safe to fully delete on failure.
    await db.saveConvo(
      { userId: req.user.id },
      {
        conversationId,
        title: file.originalname,
        endpoint,
        agent_id,
        transcription: buildTranscriptionMeta(options, result),
      },
      { context: 'POST /api/transcribe' },
    );
    conversationCreated = true;
    logger.info(`[TRANSCRIPTION] conversation ready conversationId=${conversationId}`);

    await db.addConvoFile(conversationId, sourceFile.file_id);

    let transcriptFile = null;
    let diarizationDetailFile = null;
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

      diarizationDetailFile = await persistDiarizationDetail({
        req,
        sourceFileId: sourceFile.file_id,
        filename: file.originalname,
        result,
        conversationId,
      });
      logger.info(
        `[TRANSCRIPTION] diarization detail file saved file_id=${diarizationDetailFile.file_id}`,
      );
    }

    logger.info(`[TRANSCRIPTION] responding conversationId=${conversationId}`);
    res.json({
      conversationId,
      segments: stripSegmentDetail(result.segments),
      language: result.language,
      diagnostics: result.diagnostics,
      sourceFile: { file_id: sourceFile.file_id, filename: sourceFile.filename },
      transcriptFile: toTranscriptFilePayload(transcriptFile),
      diarizationDetailFile: diarizationDetailFile
        ? { file_id: diarizationDetailFile.file_id, filename: diarizationDetailFile.filename }
        : null,
    });
  } catch (error) {
    logger.error('[POST /api/transcribe] Failed to transcribe file', error);
    res.status(500).json({ error: getTranscribeErrorMessage(error) });

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

/**
 * Re-runs transcription on the audio already stored for a conversation and
 * replaces that conversation's transcript in place.
 *
 * The source audio is read back out of whichever strategy stored it and staged
 * to a temp file, because `transcribeAndEmbed` streams from a path rather than
 * a buffer. Both the transcript row and its RAG chunks are keyed off the
 * source file's id, and `createFile` upserts on `file_id`, so the previous
 * transcript is overwritten rather than duplicated - same conversation, same
 * URL, one transcript.
 *
 * Corrections for this conversation are dropped rather than carried over: they
 * address line indices in text that no longer exists, and re-applying them to
 * a different transcript would corrupt it silently.
 */
router.post('/:conversationId/retranscribe', async (req, res) => {
  const { conversationId } = req.params;

  let options = {};
  try {
    const raw = req.body?.options;
    options = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
  } catch {
    return res.status(400).json({ error: 'Invalid options payload' });
  }

  let tmpPath = null;
  try {
    const conversation = await db.getConvo(req.user.id, conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const fileIds = conversation.files ?? [];
    const transcriptFileId = fileIds.find((id) => id.endsWith('-transcript'));
    const diarizationDetailFileId = fileIds.find((id) => id.endsWith('-diarization-detail'));
    // Excludes both derived-file suffixes explicitly, rather than "whatever
    // isn't the transcript" - a conversation now carries three files, and a
    // looser check would silently hand the diarization-detail file's id to
    // `getDownloadStream` below as if it were the source audio.
    const sourceFileId = fileIds.find(
      (id) => id !== transcriptFileId && id !== diarizationDetailFileId,
    );
    if (!sourceFileId) {
      return res
        .status(409)
        .json({ error: 'This conversation has no source audio to re-transcribe' });
    }

    const records = await db.getFiles({ file_id: sourceFileId, user: req.user.id });
    const sourceRecord = records?.[0];
    if (!sourceRecord) {
      return res.status(409).json({ error: 'Source audio is no longer available' });
    }

    const { getDownloadStream } = getStrategyFunctions(sourceRecord.source);
    const stream = await getDownloadStream(req, sourceRecord.storageKey || sourceRecord.filepath);
    tmpPath = path.join(os.tmpdir(), `retranscribe-${sourceFileId}-${Date.now()}`);
    await pipeline(stream, fs.createWriteStream(tmpPath));

    logger.info(`[RETRANSCRIBE] conversationId=${conversationId} source=${sourceFileId}`);
    const result = await transcribeAndEmbed({
      req,
      file: {
        path: tmpPath,
        originalname: sourceRecord.filename,
        mimetype: sourceRecord.type || inferMimeType(sourceRecord.filename),
      },
      sourceFileId,
      options,
    });

    await db.deleteTranscriptCorrections([conversationId]);

    const transcriptFile = await saveTranscriptFile({
      req,
      file_id: result.transcriptFileId,
      filename: `${sourceRecord.filename}-transcript.md`,
      text: result.text,
      conversationId,
      embedded: result.embedded,
    });

    const diarizationDetailFile = await persistDiarizationDetail({
      req,
      sourceFileId,
      filename: sourceRecord.filename,
      result,
      conversationId,
    });

    await db.saveConvo(
      { userId: req.user.id },
      { conversationId, transcription: buildTranscriptionMeta(options, result) },
      { context: 'POST /api/transcribe/:conversationId/retranscribe' },
    );

    logger.info(
      `[RETRANSCRIBE] done conversationId=${conversationId} segments=${result.segments.length} model=${result.diagnostics?.model_used}`,
    );
    res.json({
      conversationId,
      segments: stripSegmentDetail(result.segments),
      language: result.language,
      diagnostics: result.diagnostics,
      sourceFile: { file_id: sourceRecord.file_id, filename: sourceRecord.filename },
      transcriptFile: toTranscriptFilePayload(transcriptFile),
      diarizationDetailFile: {
        file_id: diarizationDetailFile.file_id,
        filename: diarizationDetailFile.filename,
      },
    });
  } catch (error) {
    logger.error('[POST /api/transcribe/:conversationId/retranscribe] Failed', error);
    res.status(500).json({ error: getTranscribeErrorMessage(error) });
  } finally {
    if (tmpPath) {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
});

/**
 * The interview cover-sheet export, as an actual .docx - not a plain-text
 * approximation of one wrapped in a fake bordered box. Takes the same form
 * data the pre-export dialog collected (see `InterviewTranscriptDialog.tsx`)
 * and regenerates the CORRECTED transcript text server-side from the stored
 * correction log, the same way `GET /api/transcript-corrections` does -
 * rather than trust whatever text the client happens to send, which could be
 * stale against corrections made in another tab or saved after this page
 * loaded.
 */
/**
 * Loads a conversation's transcript, regenerated from its correction log the
 * same way `GET /api/transcript-corrections` does - shared by every docx
 * export route so none of them can drift into trusting stale client-side
 * text. Throws an `Error` with a `.status` set to the right HTTP code; each
 * route's own catch block reads that instead of duplicating these same
 * lookups and status codes itself.
 */
async function loadCorrectedTranscript(userId, conversationId) {
  const conversation = await db.getConvo(userId, conversationId);
  if (!conversation) {
    throw Object.assign(new Error('Conversation not found'), { status: 404 });
  }

  const fileIds = conversation.files ?? [];
  const transcriptFileId = fileIds.find((id) => id.endsWith('-transcript'));
  if (!transcriptFileId) {
    throw Object.assign(new Error('This conversation has no transcript to export'), {
      status: 409,
    });
  }

  const baseFile = await db.findFileById(transcriptFileId);
  if (!baseFile?.text) {
    throw Object.assign(new Error('Transcript text is not available'), { status: 409 });
  }

  const corrections = await db.getTranscriptCorrections(transcriptFileId);
  const lines = applyTranscriptCorrectionsStructured(baseFile.text, corrections);
  return { conversation, lines };
}

function sendDocx(res, buffer, filename) {
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.send(buffer);
}

router.post('/:conversationId/interview-docx', async (req, res) => {
  const { conversationId } = req.params;
  const { form, speakers } = req.body ?? {};

  if (form == null || !Array.isArray(speakers)) {
    return res.status(400).json({ error: 'form and speakers are required' });
  }

  try {
    const { conversation, lines } = await loadCorrectedTranscript(req.user.id, conversationId);
    const buffer = await buildInterviewDocx({ form, speakers, lines });
    const filename = `${(conversation.title ?? 'transcript').replace(/[/:*?"<>|]/g, '_')}-interview.docx`;
    sendDocx(res, buffer, filename);
  } catch (error) {
    logger.error('[POST /api/transcribe/:conversationId/interview-docx] Failed', error);
    res.status(error.status ?? 500).json({
      error: error.status ? error.message : 'Could not generate the interview transcript',
    });
  }
});

router.post('/:conversationId/meeting-minutes-docx', async (req, res) => {
  const { conversationId } = req.params;
  const { form, speakers } = req.body ?? {};

  if (form == null || !Array.isArray(speakers)) {
    return res.status(400).json({ error: 'form and speakers are required' });
  }

  try {
    const { conversation, lines } = await loadCorrectedTranscript(req.user.id, conversationId);
    const buffer = await buildMeetingMinutesDocx({ form, speakers, lines });
    const filename = `${(conversation.title ?? 'transcript').replace(/[/:*?"<>|]/g, '_')}-meeting-minutes.docx`;
    sendDocx(res, buffer, filename);
  } catch (error) {
    logger.error('[POST /api/transcribe/:conversationId/meeting-minutes-docx] Failed', error);
    res
      .status(error.status ?? 500)
      .json({ error: error.status ? error.message : 'Could not generate the meeting minutes' });
  }
});

module.exports = router;
