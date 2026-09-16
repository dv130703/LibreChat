const { ViolationTypes } = require('librechat-data-provider');
const denyRequest = require('~/server/middleware/denyRequest');
const createLimiterPair = require('./factory');

const { messageIpLimiter, messageUserLimiter } = createLimiterPair({
  name: 'message',
  prefix: 'MESSAGE',
  violationType: ViolationTypes.MESSAGE_LIMIT,
  cacheKey: 'message',
  respond: denyRequest,
  defaults: { ipMax: 40, ipWindow: 1, userMax: 40, userWindow: 1 },
});

module.exports = {
  messageIpLimiter,
  messageUserLimiter,
};
