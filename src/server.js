const env = require('./config/env');
const logger = require('./config/logger');
const { pool } = require('./config/db');
const app = require('./app');

async function start() {
  try {
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connection OK');
  } catch (err) {
    logger.error('Cannot connect to PostgreSQL. Check DATABASE_URL in .env', { message: err.message });
    process.exit(1);
  }

  const server = app.listen(env.PORT, () => logger.info(`Server running on http://localhost:${env.PORT} (${env.NODE_ENV})`));

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Last line of defence for errors that escape Express
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception - exiting', { stack: err.stack });
  process.exit(1);
});

start();
