const { ViolationTypes } = require('librechat-data-provider');
const createLimiterPair = require('./factory');

const createSTTLimiters = () =>
  createLimiterPair({
    name: 'stt',
    prefix: 'STT',
    violationType: ViolationTypes.STT_LIMIT,
    cacheKey: 'stt',
    message: 'Too many STT requests. Try again later',
    defaults: { ipMax: 100, ipWindow: 1, userMax: 50, userWindow: 1 },
  });

module.exports = createSTTLimiters;
