const { ViolationTypes } = require('librechat-data-provider');
const createLimiterPair = require('./factory');

const createTTSLimiters = () =>
  createLimiterPair({
    name: 'tts',
    prefix: 'TTS',
    violationType: ViolationTypes.TTS_LIMIT,
    cacheKey: 'tts',
    message: 'Too many TTS requests. Try again later',
    defaults: { ipMax: 100, ipWindow: 1, userMax: 50, userWindow: 1 },
  });

module.exports = createTTSLimiters;
