const jwt = require('jsonwebtoken');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const configMiddleware = require('~/server/middleware/config/app');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');

const router = express.Router();
router.use(configMiddleware);

/**
 * Streams a source audio file's raw bytes straight from wherever they're
 * actually stored (transcription/ARCHITECTURE.md §12 #13), so `<audio src>`
 * in the transcript panel can point directly at this URL - the browser's own
 * media/network stack handles buffering, retry, and (for local storage,
 * where range support is implemented below) real seek-by-range, instead of
 * `useFileDownload`'s old approach of fetching the entire file into a JS
 * `Blob` and caching a single `blob:` object URL forever (`staleTime`/
 * `cacheTime: Infinity`, `retry: false`) - a design where one failed fetch
 * (a network blip, a backgrounded tab) permanently loses the player for the
 * rest of the session, since nothing ever re-triggers it. This route has no
 * such single point of failure: every seek, every remount, every reload is
 * just another ordinary HTTP request.
 *
 * Deliberately NOT behind `requireJwtAuth` - mounted at the same
 * `/api/transcribe` prefix as `transcribe.js` (which applies it router-wide),
 * but registered first in `api/server/index.js` so this specific path is
 * matched before that middleware ever runs. A native `<audio>`/`<video>`
 * element's `src` request can't attach an `Authorization` header, so cookie-
 * or-header JWT auth simply isn't available here; a short-lived, single-
 * purpose token minted by `GET /:sourceFileId/audio-token` (which *is* behind
 * the normal auth chain, in `transcribe.js`) takes its place instead. The
 * token only ever resolves to a userId - identical in shape and secret to a
 * normal session JWT, just narrower in lifetime - and every request here
 * re-checks file ownership from scratch, so it grants nothing beyond what
 * that user could already reach through the authenticated route.
 */
router.get('/:sourceFileId/audio', async (req, res) => {
  const { sourceFileId } = req.params;
  const { token } = req.query;
  if (typeof token !== 'string' || !token) {
    return res.status(401).end();
  }

  let userId;
  try {
    ({ id: userId } = jwt.verify(token, process.env.JWT_SECRET));
  } catch {
    return res.status(401).end();
  }

  let sourceFile;
  try {
    const records = await db.getFiles({ file_id: sourceFileId, user: userId });
    sourceFile = records?.[0] ?? null;
  } catch (error) {
    logger.error(`[transcribeStream] Failed to look up source file ${sourceFileId}`, error);
    return res.status(500).end();
  }
  if (!sourceFile) {
    return res.status(404).end();
  }

  const { getDownloadStream } = getStrategyFunctions(sourceFile.source);
  if (!getDownloadStream) {
    return res.status(501).end();
  }

  // Range support is implemented (`getLocalFileStream`'s new third param)
  // only for local storage, the common self-hosted case this fix targets -
  // every other backend still streams the full file inline below, which is
  // already a correctness and memory improvement over the old blob-download
  // approach even without range support (the browser buffers as bytes
  // arrive rather than the client needing the whole file in memory first),
  // just without efficient scrubbing to an arbitrary timestamp.
  const supportsRange = sourceFile.source === FileSources.local;
  const totalBytes = sourceFile.bytes;
  const range = supportsRange ? parseRange(req.headers.range, totalBytes) : null;

  res.setHeader('Content-Type', sourceFile.type || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (supportsRange) {
    res.setHeader('Accept-Ranges', 'bytes');
  }

  try {
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalBytes}`);
      res.setHeader('Content-Length', range.end - range.start + 1);
      const stream = await getDownloadStream(req, sourceFile.filepath, range);
      stream.pipe(res);
    } else {
      if (Number.isFinite(totalBytes)) {
        res.setHeader('Content-Length', totalBytes);
      }
      const stream = await getDownloadStream(req, sourceFile.filepath);
      stream.pipe(res);
    }
  } catch (error) {
    logger.error(`[transcribeStream] Failed to stream source file ${sourceFileId}`, error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
});

/**
 * Parses a single `Range: bytes=start-end` header value against a known
 * total size. Returns `null` for anything absent/malformed/unsatisfiable -
 * a plain, full `200` response is the correct fallback for all of those,
 * not a `416`; only a well-formed, satisfiable range warrants a `206`.
 */
function parseRange(rangeHeader, totalBytes) {
  if (typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=')) {
    return null;
  }
  const [startStr, endStr] = rangeHeader.slice('bytes='.length).split('-');
  const start = startStr ? parseInt(startStr, 10) : 0;
  const end = endStr ? parseInt(endStr, 10) : totalBytes - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    end >= totalBytes
  ) {
    return null;
  }
  return { start, end };
}

module.exports = router;
