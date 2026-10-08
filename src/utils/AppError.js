// Operational (expected) errors. The global error handler turns these into clean JSON.
class AppError extends Error {
  constructor(statusCode, message, code = 'ERROR', details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
  static badRequest(msg = 'Bad request', details) { return new AppError(400, msg, 'BAD_REQUEST', details); }
  static unauthorized(msg = 'Authentication required') { return new AppError(401, msg, 'UNAUTHORIZED'); }
  static forbidden(msg = 'You do not have permission to do this') { return new AppError(403, msg, 'FORBIDDEN'); }
  static notFound(msg = 'Resource not found') { return new AppError(404, msg, 'NOT_FOUND'); }
  static conflict(msg = 'Conflict', details) { return new AppError(409, msg, 'CONFLICT', details); }
}
module.exports = AppError;
