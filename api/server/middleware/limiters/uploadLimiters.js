const { ViolationTypes } = require('librechat-data-provider');
const createLimiterPair = require('./factory');

const createFileLimiters = () =>
  createLimiterPair({
    name: 'fileUpload',
    prefix: 'FILE_UPLOAD',
    violationType: ViolationTypes.FILE_UPLOAD_LIMIT,
    cacheKey: 'file_upload',
    message: 'Too many file upload requests. Try again later',
    defaults: { ipMax: 100, ipWindow: 15, userMax: 50, userWindow: 15 },
  });

module.exports = {
  createFileLimiters,
};
