const path = require('path');
const express = require('express');
const { createBlackBoxRequestHandler } = require('@librechat/api');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');

/**
 * Ingest endpoint for the frontend "black box" crash logger
 * (`client/src/blackBox`). This file only resolves where `api/logs` lives on
 * disk and wires auth/body-parsing - the actual sanitizing, file rotation,
 * and non-blocking write logic is in `packages/api/src/blackBox/logger.ts`,
 * shared so it can eventually be unit tested and reused outside Express.
 *
 * Auth is optional, not required, deliberately: `navigator.sendBeacon` (used
 * for the tab-close/session-end flush, since it's the one delivery method
 * that survives page teardown) cannot attach an Authorization header at
 * all - requiring auth here would make that specific, most-important-to-
 * catch event always fail. A beacon without a valid session still gets
 * logged, just without a `userId` attached; the regular interval flush
 * (a normal `fetch`, which can carry the header) attaches one when a
 * session is active. Same shape as `optionalJwtAuth`'s existing use on
 * `/api/config`.
 *
 * The log directory mirrors `api/config/meiliLogger.js`'s resolution order
 * (env override, then a local `api/logs` relative to this file) so crash
 * logs land next to the app's other log files instead of a new location
 * someone has to go hunting for.
 */
const router = express.Router();
router.use(optionalJwtAuth);
router.use(express.json({ limit: '1mb' }));

const logDir = process.env.LIBRECHAT_LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const handleBlackBoxLogs = createBlackBoxRequestHandler(logDir);

router.post('/logs', handleBlackBoxLogs);

module.exports = router;
