const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const express = require('express');
const multer = require('multer');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const {
  inferMimeType,
  mergeFileConfig,
  FileContext,
  FileSources,
} = require('librechat-data-provider');
const {
  getStorageMetadata,
  extractAudioTrack,
  probeAudioChannels,
  generateShortLivedToken,
  restoreTenantContextFromReq,
  applyTranscriptCorrectionsStructured,
  buildInterviewDocx,
  buildMeetingMinutesDocx,
  buildDiarizationDetail,
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
const {
  enqueueTranscriptionJob,
  getQueueDepth,
} = require('~/server/services/Transcription/jobQueue');
const { HEARTBEAT_INTERVAL_MS } = require('~/server/services/Transcription/reconciliation');
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
 * Confirms `req.user` owns the *source audio* File identified by
 * `sourceFileId` - the `:sourceFileId`-keyed equivalent of
 * `transcriptCorrections.js`'s `assertOwnsConversation`, needed once
 * `/retranscribe` and the docx exports rekeyed off `:conversationId` (see
 * `transcription/ARCHITECTURE.md` §5.2/R4 - flagged there as the
 * highest-risk item in the whole migration plan). `db.getFiles` queries the
 * `File` model, which carries `applyTenantIsolation` - scoping by `user`
 * here, on a route that isn't a multipart upload (so the tenant ALS context
 * from `requireJwtAuth` survives intact), also transitively excludes a
 * same-id file belonging to a different tenant. A mismatched owner gets a
 * 404 indistinguishable from a nonexistent file, never someone else's data.
 */
async function findOwnedSourceFile(req, sourceFileId) {
  if (!sourceFileId) {
    return null;
  }
  const records = await db.getFiles({ file_id: sourceFileId, user: req.user.id });
  return records?.[0] ?? null;
}

async function assertOwnsSourceFile(req, res, sourceFileId) {
  if (!sourceFileId) {
    res.status(400).json({ error: 'sourceFileId is required' });
    return null;
  }
  const sourceFile = await findOwnedSourceFile(req, sourceFileId);
  if (!sourceFile) {
    res.status(404).json({ error: 'Source audio not found' });
    return null;
  }
  return sourceFile;
}

/**
 * The actual queued unit of work (transcription/ARCHITECTURE.md §5.1/D5) -
 * shared by a fresh upload (`POST /`) and `/retranscribe`, so there is one
 * implementation of "call the Python service, persist the outcome" instead
 * of two that could drift. Takes an already-resolved local audio file path;
 * the caller is responsible for having one ready (a freshly extracted
 * upload, or a freshly downloaded copy of stored source audio) and for
 * listing every path that should be deleted once this settles, win or
 * lose - ownership of those temp files transfers here the moment this is
 * enqueued, since the request handler that created them has usually
 * already responded and moved on.
 *
 * Status transitions the source File doc through
 * `transcribing -> ready | failed`, heartbeating every
 * `HEARTBEAT_INTERVAL_MS` while it runs so `reconciliation.js` can tell a
 * job still in progress from one whose process died mid-run. Every update
 * uses dot-notation `$set` paths (`'transcription.status'`, not a whole
 * `transcription: {...}` replacement) so a later stage's write can never
 * clobber fields an earlier stage already set (`jobId`, `requestedOptions`,
 * ...) - unlike Phase 1's single-shot version of this write, this one
 * spans several separate updates over the job's real lifetime.
 *
 * On failure, the source file's `transcription.status` becomes `'failed'`
 * with a diagnosis - nothing is deleted. This is the behavior change
 * §5.1 exists for: a transient WhisperX failure used to discard the user's
 * upload entirely; now it's a retryable state (`POST /:sourceFileId/retry`).
 *
 * Explicitly re-establishes tenant ALS context from the closed-over `req`
 * before doing anything else, rather than trusting whatever context (if
 * any) happens to be ambient when this actually runs. It must: this job is
 * invoked from `jobQueue.js`'s own `while` loop, which processes jobs
 * enqueued by *different* HTTP requests one after another from a single
 * long-lived async chain - that chain's own ALS context is whichever
 * request's call stack originally started the queue processing, not
 * necessarily this job's. Without this, a second user's job could
 * silently run - and get its writes tenant-stamped - under the first
 * user's tenant context. `File.updateFile` calls below target a specific,
 * unguessable `file_id`, so this isn't a cross-tenant *read* leak, but a
 * `TENANT_ISOLATION_STRICT` deployment would reject an unscoped write
 * outright, and a non-strict one would let a job's writes go out under the
 * wrong ambient tenant context.
 */
async function runTranscriptionCore(params) {
  // The callback must be declared `async` (not just Promise-returning) -
  // `tenantStorage.run` only keeps ALS context attached across `await`
  // boundaries inside an actual async function; a plain arrow that
  // synchronously returns a promise loses it at the first `await` inside
  // `runTranscriptionJob`. See `tenantStorage.run`'s own doc comment.
  return tenantStorage.run(
    { tenantId: params.req.user.tenantId, userId: params.req.user.id },
    async () => runTranscriptionJob(params),
  );
}

async function runTranscriptionJob({
  req,
  sourceFileId,
  sourceFilename,
  audioFile,
  conversationId,
  options,
  wipeCorrections,
  cleanupPaths,
}) {
  const heartbeat = setInterval(() => {
    db.updateFile({ file_id: sourceFileId, 'transcription.heartbeatAt': new Date() }).catch(
      (error) => {
        logger.error(`[TRANSCRIPTION] Failed to update heartbeat for ${sourceFileId}`, error);
      },
    );
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    await db.updateFile({
      file_id: sourceFileId,
      'transcription.status': 'transcribing',
      'transcription.startedAt': new Date(),
      'transcription.heartbeatAt': new Date(),
      'transcription.error': null,
    });

    const result = await transcribeAndEmbed({ req, file: audioFile, sourceFileId, options });
    logger.info(
      `[TRANSCRIPTION] job transcribeAndEmbed done sourceFileId=${sourceFileId} segments=${result.segments.length} embedded=${result.embedded}`,
    );

    if (wipeCorrections) {
      await db.deleteTranscriptCorrections([conversationId]);
    }

    let transcriptFile = null;
    let diarizationDetailFile = null;
    if (result.transcriptFileId) {
      transcriptFile = await saveTranscriptFile({
        req,
        file_id: result.transcriptFileId,
        filename: `${sourceFilename}-transcript.md`,
        text: result.text,
        conversationId,
        embedded: result.embedded,
        sourceFileId,
      });
      await db.addConvoFile(conversationId, transcriptFile.file_id);

      diarizationDetailFile = await persistDiarizationDetail({
        req,
        sourceFileId,
        filename: sourceFilename,
        result,
        conversationId,
      });
    }

    // Dual-write, same as Phase 1: `Conversation.transcription` stays
    // populated for the deprecated fallback read path alongside the File
    // doc below, which is now the source of truth.
    await db.saveConvo(
      { userId: req.user.id },
      { conversationId, transcription: buildTranscriptionMeta(options, result) },
      { context: 'transcription job' },
    );

    await db.updateFile({
      file_id: sourceFileId,
      'transcription.status': 'ready',
      'transcription.completedAt': new Date(),
      'transcription.effectiveOptions': buildTranscriptionMeta(options, result),
      'transcription.transcriptFileId': transcriptFile?.file_id ?? null,
      'transcription.diarizationDetailFileId': diarizationDetailFile?.file_id ?? null,
      'transcription.speakerCount': result.diagnostics?.diarization_speaker_count ?? null,
    });

    logger.info(
      `[TRANSCRIPTION] job complete sourceFileId=${sourceFileId} conversationId=${conversationId}`,
    );
  } catch (error) {
    logger.error(`[TRANSCRIPTION] job failed sourceFileId=${sourceFileId}`, error);
    await db
      .updateFile({
        file_id: sourceFileId,
        'transcription.status': 'failed',
        'transcription.completedAt': new Date(),
        'transcription.error': getTranscribeErrorMessage(error),
      })
      .catch((updateError) => {
        logger.error(
          `[TRANSCRIPTION] Failed to persist failure state for ${sourceFileId}`,
          updateError,
        );
      });
    throw error;
  } finally {
    clearInterval(heartbeat);
    await Promise.all(cleanupPaths.map((p) => fs.promises.unlink(p).catch(() => {})));
  }
}

/**
 * Persists the full diarization/ASR detail (raw pyannote turns, speaker
 * embeddings, per-word speaker assignments) as its own file, separate from
 * the plain transcript - see `saveDiarizationDetailFile`. Used by both the
 * initial transcribe route and `/retranscribe`, always keyed off the same
 * `sourceFileId` so a re-transcribe overwrites this record rather than
 * leaking a duplicate, same as the transcript file itself.
 */
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

/**
 * Stateless channel-count probe (transcription/ARCHITECTURE.md §6.2/R9,
 * Phase 4) - replaces the composer's former client-side heuristic
 * (`probeMultiChannelAudio` in `UploadStep.tsx`), which decoded a possibly-
 * truncated chunk of the file via the browser's Web Audio API and could
 * silently mis-detect on large files or codecs the browser couldn't decode
 * at all. No File record is created and no job is queued - the upload is
 * probed and deleted within this one request. `probeAudioChannels` reads
 * channel count straight from container metadata (`-select_streams a:0`),
 * so there's no need to extract just the audio track first the way the
 * real transcribe pipeline does.
 */
router.post('/probe', upload.single('file'), restoreTenantContextFromReq, async (req, res) => {
  const { file } = req;
  if (!file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  try {
    const channelCount = await probeAudioChannels(file.path);
    res.json({ channelCount });
  } finally {
    await fs.promises.unlink(file.path).catch(() => {});
  }
});

/**
 * Accepts an upload and returns immediately once the source audio is safely
 * stored and queued - the actual transcription runs afterward, off the
 * in-process FIFO (`jobQueue.js`). This is the core behavior change of
 * Phase 2 (transcription/ARCHITECTURE.md §5.1): the old synchronous version
 * held the HTTP connection open for up to 15 minutes and discarded the
 * upload entirely on any failure in that window; this version can't do
 * either, because nothing downstream of "conversation exists, source file
 * queued" is on the response's critical path anymore.
 *
 * The conversation is created here, synchronously, *before* transcription
 * even starts - deliberately different from the old ordering (which
 * deferred it until success, specifically to avoid a sidebar entry nothing
 * could open yet). That reasoning no longer applies: once the wait is
 * async, `conversationId`'s response value takes the client straight to a
 * `queued`/`transcribing` job it can watch settle, not a dead end.
 */
router.post('/', upload.single('file'), restoreTenantContextFromReq, async (req, res) => {
  const { file } = req;
  if (!file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const extractedAudioPath = `${file.path}-audio.m4a`;
  const cleanupUploadTempFiles = () =>
    Promise.all([
      fs.promises.unlink(file.path).catch(() => {}),
      fs.promises.unlink(extractedAudioPath).catch(() => {}),
    ]);

  const { conversationId, endpoint, agent_id } = req.body;
  if (!conversationId) {
    await cleanupUploadTempFiles();
    return res.status(400).json({ error: 'conversationId is required' });
  }

  let options = {};
  try {
    options = req.body.options ? JSON.parse(req.body.options) : {};
  } catch {
    await cleanupUploadTempFiles();
    return res.status(400).json({ error: 'Invalid options payload' });
  }

  // Tracks what's actually been persisted so a mid-way failure - during
  // this synchronous *preparation* phase only (extraction, storage,
  // conversation creation) - can be rolled back below. Once the job is
  // actually enqueued, a failure is no longer this kind of rollback: it's
  // `transcription.status = 'failed'`, a retryable state on the file that
  // was already committed (see `runTranscriptionCore`).
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
    const now = new Date();
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
        transcription: {
          status: 'queued',
          jobId: crypto.randomUUID(),
          instanceId: os.hostname(),
          heartbeatAt: now,
          requestedOptions: options,
        },
        ...(await getRetentionExpiry(req)),
        tenantId: req.user.tenantId,
      },
      true,
    );
    logger.info(`[TRANSCRIPTION] source file queued file_id=${sourceFile.file_id}`);

    // Phase 4 (transcription/ARCHITECTURE.md §6.1): the composer can now
    // call this route against a conversation that already exists (attaching
    // a recording mid-chat), not just the standalone page's always-fresh
    // id. Checked explicitly rather than assumed from the caller, since
    // getting this wrong is a real, not theoretical, correctness bug two
    // different ways: (1) unconditionally writing `title`/`endpoint` would
    // silently rename the user's ongoing conversation to the audio
    // filename; (2) `conversationCreated` gates the failure-path rollback
    // below, which fully *deletes* the conversation - if it were set true
    // for a pre-existing conversation, a prep-phase failure (a bad upload,
    // a storage error) would delete the user's entire chat, not just this
    // attempt's leftovers. Left `false` here is what keeps that rollback
    // scoped to conversations this request itself created.
    const existingConversation = await db.getConvo(req.user.id, conversationId);
    if (existingConversation) {
      await db.addConvoFile(conversationId, sourceFile.file_id);
      logger.info(
        `[TRANSCRIPTION] attached to existing conversation conversationId=${conversationId}`,
      );
    } else {
      await db.saveConvo(
        { userId: req.user.id },
        { conversationId, title: file.originalname, endpoint, agent_id },
        { context: 'POST /api/transcribe' },
      );
      conversationCreated = true;
      await db.addConvoFile(conversationId, sourceFile.file_id);
      logger.info(`[TRANSCRIPTION] conversation ready conversationId=${conversationId}`);
    }

    res.status(202).json({
      conversationId,
      sourceFile: { file_id: sourceFile.file_id, filename: sourceFile.filename },
      status: 'queued',
      queuePosition: getQueueDepth(),
    });

    // Not awaited - the queue itself serializes execution (D5), and this
    // request is done the moment the client has a conversation to open.
    // `runTranscriptionCore` persists its own success/failure state, so
    // the `.catch` below exists only to keep an unhandled-rejection
    // warning from firing for this fire-and-forget enqueue.
    enqueueTranscriptionJob(() =>
      runTranscriptionCore({
        req,
        sourceFileId: sourceFile.file_id,
        sourceFilename: file.originalname,
        audioFile,
        conversationId,
        options,
        wipeCorrections: false,
        cleanupPaths: [file.path, extractedAudioPath],
      }),
    ).catch(() => {});
  } catch (error) {
    logger.error('[POST /api/transcribe] Failed to prepare transcription job', error);
    if (!res.headersSent) {
      res.status(500).json({ error: getTranscribeErrorMessage(error) });
    }

    // Best-effort rollback of the *preparation* phase only - nothing here
    // runs once the job has actually been enqueued, since by then the
    // response has already gone out and cleanup is `runTranscriptionCore`'s
    // job instead.
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
      logger.error('[POST /api/transcribe] Failed to roll back failed preparation', cleanupError);
    }
    await cleanupUploadTempFiles();
  }
});

/**
 * Batch status poll for the cards/panel of an open conversation - one
 * request instead of one per file. `fileIds` are the *source audio* file
 * ids (the ones `transcription/ARCHITECTURE.md` §4.1's job state lives on).
 * Scoped by `user: req.user.id`, same reasoning as `assertOwnsSourceFile` -
 * a caller only ever gets back files they own, silently omitted rather than
 * erroring for any id that doesn't resolve (not found, not owned, or not a
 * source file at all) so a stale id from a since-deleted file doesn't 500
 * an otherwise-healthy poll.
 */
router.get('/status', async (req, res) => {
  const raw = req.query.fileIds;
  let rawIds = [];
  if (Array.isArray(raw)) {
    rawIds = raw;
  } else if (typeof raw === 'string') {
    rawIds = raw.split(',');
  }
  const fileIds = rawIds.map((id) => id.trim()).filter(Boolean);
  if (fileIds.length === 0) {
    return res.status(400).json({ error: 'fileIds is required' });
  }

  try {
    const records = await db.getFiles({ file_id: { $in: fileIds }, user: req.user.id });
    const files = (records ?? [])
      .filter((record) => record.transcription)
      .map((record) => ({
        file_id: record.file_id,
        status: record.transcription.status,
        error: record.transcription.error ?? null,
        transcriptFileId: record.transcription.transcriptFileId ?? null,
        diarizationDetailFileId: record.transcription.diarizationDetailFileId ?? null,
      }));
    res.json({ files });
  } catch (error) {
    logger.error('[GET /api/transcribe/status] Failed', error);
    res.status(500).json({ error: 'Could not read transcription status' });
  }
});

/**
 * Re-enqueues a failed job with the options it originally ran with -
 * §5.2's `POST /:sourceFileId/retry`. Only valid from `'failed'`: retrying a
 * job that's already `queued`/`transcribing` would double-run it against
 * the same source audio, and one that's already `ready` has nothing to
 * retry.
 */
router.post('/:sourceFileId/retry', async (req, res) => {
  const { sourceFileId } = req.params;
  const sourceFile = await assertOwnsSourceFile(req, res, sourceFileId);
  if (!sourceFile) {
    return;
  }
  if (sourceFile.transcription?.status !== 'failed') {
    return res.status(409).json({
      error: `Only a failed job can be retried (current status: ${sourceFile.transcription?.status ?? 'unknown'})`,
    });
  }

  let tmpPath = null;
  try {
    const { getDownloadStream } = getStrategyFunctions(sourceFile.source);
    const stream = await getDownloadStream(req, sourceFile.storageKey || sourceFile.filepath);
    tmpPath = path.join(os.tmpdir(), `retry-${sourceFileId}-${Date.now()}`);
    await pipeline(stream, fs.createWriteStream(tmpPath));

    await db.updateFile({
      file_id: sourceFileId,
      'transcription.status': 'queued',
      'transcription.error': null,
      'transcription.heartbeatAt': new Date(),
    });

    logger.info(`[TRANSCRIPTION] retry queued sourceFileId=${sourceFileId}`);
    res.status(202).json({
      sourceFile: { file_id: sourceFile.file_id, filename: sourceFile.filename },
      status: 'queued',
      queuePosition: getQueueDepth(),
    });

    enqueueTranscriptionJob(() =>
      runTranscriptionCore({
        req,
        sourceFileId,
        sourceFilename: sourceFile.filename,
        audioFile: {
          path: tmpPath,
          originalname: sourceFile.filename,
          mimetype: sourceFile.type || inferMimeType(sourceFile.filename),
        },
        conversationId: sourceFile.conversationId,
        options: sourceFile.transcription?.requestedOptions ?? {},
        wipeCorrections: false,
        cleanupPaths: [tmpPath],
      }),
    ).catch(() => {});
  } catch (error) {
    logger.error(
      `[POST /api/transcribe/:sourceFileId/retry] Failed sourceFileId=${sourceFileId}`,
      error,
    );
    if (!res.headersSent) {
      res.status(500).json({ error: getTranscribeErrorMessage(error) });
    }
    if (tmpPath) {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
});

/**
 * Re-runs transcription on the audio already stored for a source file and
 * replaces its conversation's transcript in place - rekeyed from
 * `:conversationId` to `:sourceFileId` (transcription/ARCHITECTURE.md §5.2),
 * since a conversation may now hold more than one recording (D1) and
 * `:conversationId` alone can no longer say which one. Ownership is
 * re-verified explicitly via `assertOwnsSourceFile` rather than inherited
 * from a conversation lookup - see that function's own comment on why this
 * is the highest-risk change in the whole migration (R4).
 *
 * Async, same as `POST /` (§5.1): responds once the job is queued rather
 * than once transcription finishes. The source audio is read back out of
 * whichever strategy stored it and staged to a temp file, because
 * `transcribeAndEmbed` streams from a path rather than a buffer - handed
 * off to `runTranscriptionCore`, the same job implementation `POST /` uses,
 * so both entry points can never drift in how a job actually runs.
 *
 * Corrections for this conversation are dropped rather than carried over:
 * they address line indices in text that no longer exists, and re-applying
 * them to a different transcript would corrupt it silently.
 */
router.post('/:sourceFileId/retranscribe', async (req, res) => {
  const { sourceFileId } = req.params;
  const sourceFile = await assertOwnsSourceFile(req, res, sourceFileId);
  if (!sourceFile) {
    return;
  }
  const conversationId = sourceFile.conversationId;
  if (!conversationId) {
    return res.status(409).json({ error: 'Source audio is not attached to a conversation' });
  }

  let options = {};
  try {
    const raw = req.body?.options;
    options = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
  } catch {
    return res.status(400).json({ error: 'Invalid options payload' });
  }

  let tmpPath = null;
  try {
    const { getDownloadStream } = getStrategyFunctions(sourceFile.source);
    const stream = await getDownloadStream(req, sourceFile.storageKey || sourceFile.filepath);
    tmpPath = path.join(os.tmpdir(), `retranscribe-${sourceFileId}-${Date.now()}`);
    await pipeline(stream, fs.createWriteStream(tmpPath));

    await db.updateFile({
      file_id: sourceFileId,
      'transcription.status': 'queued',
      'transcription.error': null,
      'transcription.heartbeatAt': new Date(),
      'transcription.requestedOptions': options,
    });

    logger.info(`[RETRANSCRIBE] conversationId=${conversationId} source=${sourceFileId}`);
    res.status(202).json({
      conversationId,
      sourceFile: { file_id: sourceFile.file_id, filename: sourceFile.filename },
      status: 'queued',
      queuePosition: getQueueDepth(),
    });

    enqueueTranscriptionJob(() =>
      runTranscriptionCore({
        req,
        sourceFileId,
        sourceFilename: sourceFile.filename,
        audioFile: {
          path: tmpPath,
          originalname: sourceFile.filename,
          mimetype: sourceFile.type || inferMimeType(sourceFile.filename),
        },
        conversationId,
        options,
        wipeCorrections: true,
        cleanupPaths: [tmpPath],
      }),
    ).catch(() => {});
  } catch (error) {
    logger.error(
      `[POST /api/transcribe/:sourceFileId/retranscribe] Failed sourceFileId=${sourceFileId}`,
      error,
    );
    if (!res.headersSent) {
      res.status(500).json({ error: getTranscribeErrorMessage(error) });
    }
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
 * Loads a recording's transcript, regenerated from its correction log the
 * same way `GET /api/transcript-corrections` does - shared by every docx
 * export route so none of them can drift into trusting stale client-side
 * text. Rekeyed off `sourceFileId` rather than `conversationId` (§5.2, same
 * reasoning as `/retranscribe`) - `sourceFile.transcription.transcriptFileId`
 * (Phase 1) is the explicit link now, not a suffix-matched guess over
 * `conversation.files`. Throws an `Error` with a `.status` set to the right
 * HTTP code; each route's own catch block reads that instead of duplicating
 * these same lookups and status codes itself.
 */
async function loadCorrectedTranscript(req, sourceFileId) {
  const sourceFile = await findOwnedSourceFile(req, sourceFileId);
  if (!sourceFile) {
    throw Object.assign(new Error('Source audio not found'), { status: 404 });
  }

  const transcriptFileId = sourceFile.transcription?.transcriptFileId;
  if (!transcriptFileId) {
    throw Object.assign(new Error('This recording has no transcript to export'), { status: 409 });
  }

  const baseFile = await db.findFileById(transcriptFileId);
  if (!baseFile?.text) {
    throw Object.assign(new Error('Transcript text is not available'), { status: 409 });
  }

  const conversation = await db.getConvo(req.user.id, sourceFile.conversationId);
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

router.post('/:sourceFileId/interview-docx', async (req, res) => {
  const { sourceFileId } = req.params;
  const { form, speakers } = req.body ?? {};

  if (form == null || !Array.isArray(speakers)) {
    return res.status(400).json({ error: 'form and speakers are required' });
  }

  try {
    const { conversation, lines } = await loadCorrectedTranscript(req, sourceFileId);
    const buffer = await buildInterviewDocx({ form, speakers, lines });
    const filename = `${(conversation.title ?? 'transcript').replace(/[/:*?"<>|]/g, '_')}-interview.docx`;
    sendDocx(res, buffer, filename);
  } catch (error) {
    logger.error('[POST /api/transcribe/:sourceFileId/interview-docx] Failed', error);
    res.status(error.status ?? 500).json({
      error: error.status ? error.message : 'Could not generate the interview transcript',
    });
  }
});

router.post('/:sourceFileId/meeting-minutes-docx', async (req, res) => {
  const { sourceFileId } = req.params;
  const { form, speakers } = req.body ?? {};

  if (form == null || !Array.isArray(speakers)) {
    return res.status(400).json({ error: 'form and speakers are required' });
  }

  try {
    const { conversation, lines } = await loadCorrectedTranscript(req, sourceFileId);
    const buffer = await buildMeetingMinutesDocx({ form, speakers, lines });
    const filename = `${(conversation.title ?? 'transcript').replace(/[/:*?"<>|]/g, '_')}-meeting-minutes.docx`;
    sendDocx(res, buffer, filename);
  } catch (error) {
    logger.error('[POST /api/transcribe/:sourceFileId/meeting-minutes-docx] Failed', error);
    res
      .status(error.status ?? 500)
      .json({ error: error.status ? error.message : 'Could not generate the meeting minutes' });
  }
});

module.exports = router;
