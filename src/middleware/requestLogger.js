const logger = require('../config/logger');

// Logs request start and finish. Never logs bodies (passwords, tokens).
module.exports = (req, res, next) => {
  const start = process.hrtime.bigint();
  const path = req.originalUrl.split('?')[0];
  logger.info('request started', { method: req.method, path });

  res.on('finish', () => {
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger.log(level, 'request finished', {
      traceId: req.traceId,
      method: req.method,
      path,
      status: res.statusCode,
      ms,
      userId: req.user ? req.user.id : undefined,
      ip: req.ip,
    });
  });
  next();
};
