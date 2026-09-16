import winston from 'winston';
import 'winston-daily-rotate-file';
import { levels, level } from './logLevels';
import { getLogDirectory } from './utils';

const { DEBUG_LOGGING = 'false', LOG_TO_FILE } = process.env;

const useDebugLogging =
  (typeof DEBUG_LOGGING === 'string' && DEBUG_LOGGING.toLowerCase() === 'true') ||
  DEBUG_LOGGING === 'true';

const useFileLogging = typeof LOG_TO_FILE !== 'string' || LOG_TO_FILE.toLowerCase() !== 'false';

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
);

const logLevel = useDebugLogging ? 'debug' : 'error';
const transports: winston.transport[] = [];

if (useFileLogging) {
  const logDir = getLogDirectory();

  transports.push(
    new winston.transports.DailyRotateFile({
      level: logLevel,
      filename: `${logDir}/meiliSync-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
    }),
  );
}

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`),
);

transports.push(
  new winston.transports.Console({
    level: 'info',
    format: consoleFormat,
  }),
);

const logger: winston.Logger = winston.createLogger({
  level: level(),
  levels,
  transports,
});

export default logger;
