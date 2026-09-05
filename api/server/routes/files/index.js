const multer = require('multer');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  createFileLimiters,
  configMiddleware,
  requireJwtAuth,
  uaParser,
  checkBan,
} = require('~/server/middleware');
const { restoreTenantContextFromReq } = require('@librechat/api');
const { avatar: agentAvatarRouter } = require('~/server/routes/agents/v1');
const { createMulterInstance } = require('./multer');

const files = require('./files');
const images = require('./images');
const avatar = require('./avatar');
const speech = require('./speech');

const initialize = async () => {
  const router = express.Router();
  router.use(requireJwtAuth);
  router.use(configMiddleware);
  router.use(checkBan);
  router.use(uaParser);

  const upload = await createMulterInstance();
  router.post('/speech/stt', upload.single('audio'), restoreTenantContextFromReq);

  /* Important: speech route must be added before the upload limiters */
  router.use('/speech', speech);

  const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();

  /** Apply rate limiters to all POST routes (excluding /speech which is handled
   *  above, and /usage — a metadata touch that must not consume upload quota) */
  router.use((req, res, next) => {
    if (req.method === 'POST' && !req.path.startsWith('/speech') && req.path !== '/usage') {
      return fileUploadIpLimiter(req, res, (err) => {
        if (err) {
          return next(err);
        }
        return fileUploadUserLimiter(req, res, next);
      });
    }
    next();
  });

  router.post('/', upload.single('file'), restoreTenantContextFromReq);
  router.post('/images', upload.single('file'), restoreTenantContextFromReq);
  router.post('/images/avatar', upload.single('file'), restoreTenantContextFromReq);
  router.post(
    '/images/agents/:agent_id/avatar',
    upload.single('file'),
    restoreTenantContextFromReq,
  );
  router.use('/', files);
  router.use('/images', images);
  router.use('/images/avatar', avatar);
  router.use('/images/agents', agentAvatarRouter);

  /* Multer rejects (unsupported type, size limit) reach Express via next(err),
   * and without a handler here they surface as an unlogged HTML 500 that names
   * no cause. Log them and return the real reason to the client instead. */
  router.use((err, req, res, next) => {
    if (!err) {
      return next();
    }

    const isMulterError = err instanceof multer.MulterError;
    const status = isMulterError || err.userErrorStatusCode ? 400 : 500;

    logger.error(
      `[/files] Upload rejected before processing (${req.method} ${req.originalUrl}) file="${
        req.file?.originalname ?? 'n/a'
      }" mimetype="${req.file?.mimetype ?? 'n/a'}" code=${err.code ?? 'n/a'}:`,
      err,
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(err.userErrorStatusCode ?? status).json({ message: err.message });
  });

  return router;
};

module.exports = { initialize };
