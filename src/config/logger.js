const winston = require('winston');
const env = require('./env');
const { getTraceId } = require('./context');

// Adds the current request's trace id to every log line automatically.
const addTraceId = winston.format((info) => {
  const traceId = getTraceId();
  if (traceId && !info.traceId) info.traceId = traceId;
  return info;
});

const consoleFormat = winston.format.combine(
  addTraceId(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, traceId, stack, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} [${traceId || '-'}] ${message}${extra}${stack ? `\n${stack}` : ''}`;
  })
);

const fileFormat = winston.format.combine(
  addTraceId(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({ filename: 'logs/combined.log', format: fileFormat, maxsize: 5_000_000, maxFiles: 3 }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error', format: fileFormat, maxsize: 5_000_000, maxFiles: 3 }),
  ],
});

module.exports = logger;
