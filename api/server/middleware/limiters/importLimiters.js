const { ViolationTypes } = require('librechat-data-provider');
const createLimiterPair = require('./factory');

const createImportLimiters = () =>
  createLimiterPair({
    name: 'import',
    prefix: 'IMPORT',
    violationType: ViolationTypes.FILE_UPLOAD_LIMIT,
    cacheKey: 'import',
    message: 'Too many conversation import requests. Try again later',
    defaults: { ipMax: 100, ipWindow: 15, userMax: 50, userWindow: 15 },
  });

module.exports = {
  createImportLimiters,
};
