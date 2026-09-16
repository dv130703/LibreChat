const rateLimit = require('express-rate-limit');
const { limiterCache, removePorts } = require('@librechat/api');
const logViolation = require('~/cache/logViolation');

const readLimiterEnv = (prefix, defaults) => {
  const ipMax = parseInt(process.env[`${prefix}_IP_MAX`]) || defaults.ipMax;
  const ipWindow = parseInt(process.env[`${prefix}_IP_WINDOW`]) || defaults.ipWindow;
  const userMax = parseInt(process.env[`${prefix}_USER_MAX`]) || defaults.userMax;
  const userWindow = parseInt(process.env[`${prefix}_USER_WINDOW`]) || defaults.userWindow;
  const violationScore = process.env[`${prefix}_VIOLATION_SCORE`];

  const ipWindowMs = ipWindow * 60 * 1000;
  const userWindowMs = userWindow * 60 * 1000;

  return {
    ipMax,
    ipWindowMs,
    ipWindowInMinutes: ipWindowMs / 60000,
    userMax,
    userWindowMs,
    userWindowInMinutes: userWindowMs / 60000,
    violationScore,
  };
};

const defaultRespond = (message) => async (req, res) => {
  res.status(429).json({ message });
};

/**
 * Creates a matched pair of IP- and user-scoped Express rate limiters that share
 * a violation type, cache namespace, and violation response, differing only by
 * env-var prefix and the values supplied here.
 *
 * @param {Object} params
 * @param {string} params.name - camelCase name used to key the returned limiters, e.g. 'fileUpload' -> { fileUploadIpLimiter, fileUploadUserLimiter }.
 * @param {string} params.prefix - Env var prefix, e.g. 'FILE_UPLOAD', 'TTS', 'FORK'.
 * @param {string} params.violationType - One of `ViolationTypes`.
 * @param {string} params.cacheKey - Prefix for the limiter cache store keys.
 * @param {{ ipMax: number, ipWindow: number, userMax: number, userWindow: number }} params.defaults - Fallback values when the env vars are unset.
 * @param {string} [params.message] - Error message returned to the client on violation (used by the default JSON responder).
 * @param {(req: Express.Request, res: Express.Response, errorMessage: Record<string, unknown>) => Promise<unknown>} [params.respond] - Custom violation responder; defaults to a 429 JSON response using `message`.
 * @returns {Record<string, Function>} An object with `${name}IpLimiter` and `${name}UserLimiter` Express middleware.
 */
const createLimiterPair = ({
  name,
  prefix,
  violationType,
  cacheKey,
  defaults,
  message,
  respond,
}) => {
  const {
    ipMax,
    ipWindowMs,
    ipWindowInMinutes,
    userMax,
    userWindowMs,
    userWindowInMinutes,
    violationScore,
  } = readLimiterEnv(prefix, defaults);

  const onLimit = respond ?? defaultRespond(message);

  const createHandler = (ip) => async (req, res) => {
    const errorMessage = {
      type: violationType,
      max: ip ? ipMax : userMax,
      limiter: ip ? 'ip' : 'user',
      windowInMinutes: ip ? ipWindowInMinutes : userWindowInMinutes,
    };

    await logViolation(req, res, violationType, errorMessage, violationScore);
    return onLimit(req, res, errorMessage);
  };

  const ipLimiter = rateLimit({
    windowMs: ipWindowMs,
    max: ipMax,
    handler: createHandler(true),
    keyGenerator: removePorts,
    store: limiterCache(`${cacheKey}_ip_limiter`),
  });

  const userLimiter = rateLimit({
    windowMs: userWindowMs,
    max: userMax,
    handler: createHandler(false),
    keyGenerator: (req) => req.user?.id,
    store: limiterCache(`${cacheKey}_user_limiter`),
  });

  return {
    [`${name}IpLimiter`]: ipLimiter,
    [`${name}UserLimiter`]: userLimiter,
  };
};

module.exports = createLimiterPair;
