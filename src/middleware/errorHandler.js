const logger = require('../config/logger');
const env = require('../config/env');
const AppError = require('../utils/AppError');

// 404 for any route nothing else matched
exports.notFound = (req, res, next) => next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl.split('?')[0]}`));

// Translate known low-level errors into AppErrors
function normalize(err) {
  if (err instanceof AppError) return err;

  // Malformed JSON / body too large (body-parser)
  if (err.type === 'entity.parse.failed') return AppError.badRequest('Malformed JSON in request body');
  if (err.type === 'entity.too.large') return new AppError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE');

  // jsonwebtoken
  if (err.name === 'TokenExpiredError') return new AppError(401, 'Token expired', 'TOKEN_EXPIRED');
  if (err.name === 'JsonWebTokenError') return new AppError(401, 'Invalid token', 'INVALID_TOKEN');

  // PostgreSQL error codes
  switch (err.code) {
    case '23505': return AppError.conflict('A record with the same unique value already exists', { constraint: err.constraint });
    case '23503': return AppError.conflict('Operation violates a relationship with another record', { constraint: err.constraint });
    case '23514': return AppError.badRequest('A value violates a database rule', { constraint: err.constraint });
    case '22P02': return AppError.badRequest('Invalid identifier or value format');
    case '22007':
    case '22008': return AppError.badRequest('Invalid date format');
    case '22001': return AppError.badRequest('A value is too long');
    default: return null;
  }
}

// Global error handler: the ONLY place that writes error responses.
// eslint-disable-next-line no-unused-vars
exports.errorHandler = (err, req, res, next) => {
  const known = normalize(err);
  const traceId = req.traceId;

  if (known) {
    const level = known.statusCode >= 500 ? 'error' : 'warn';
    logger.log(level, `${known.code}: ${known.message}`, { traceId, status: known.statusCode, path: req.originalUrl.split('?')[0] });
  } else {
    logger.error(`Unhandled error: ${err.message}`, { traceId, stack: err.stack, path: req.originalUrl.split('?')[0] });
  }

  const status = known ? known.statusCode : 500;
  const body = {
    success: false,
    error: {
      code: known ? known.code : 'INTERNAL_ERROR',
      // never leak internals for unexpected errors in production
      message: known ? known.message : env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
      ...(known && known.details ? { details: known.details } : {}),
      traceId,
      timestamp: new Date().toISOString(),
    },
  };
  if (res.headersSent) return next(err);
  res.status(status).json(body);
};
