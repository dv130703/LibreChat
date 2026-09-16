const { ViolationTypes } = require('librechat-data-provider');
const createLimiterPair = require('./factory');

const createForkLimiters = () =>
  createLimiterPair({
    name: 'fork',
    prefix: 'FORK',
    violationType: ViolationTypes.FILE_UPLOAD_LIMIT,
    cacheKey: 'fork',
    message: 'Too many requests. Try again later',
    defaults: { ipMax: 30, ipWindow: 1, userMax: 7, userWindow: 1 },
  });

module.exports = {
  createForkLimiters,
};
