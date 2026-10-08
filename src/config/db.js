const { Pool, types } = require('pg');
const env = require('./env');
const logger = require('./logger');

// Return DATE columns (OID 1082) as plain 'YYYY-MM-DD' strings. Avoids timezone shifts (e.g. IST -> previous day).
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error('Unexpected PostgreSQL pool error', { message: err.message }));

// Always use parameterised queries: query('... WHERE id = $1', [id])
async function query(text, params = []) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 200) logger.warn('Slow query', { ms, sql: text.replace(/\s+/g, ' ').slice(0, 200) });
  else logger.debug('query', { ms, rows: result.rowCount });
  return result;
}

// Runs fn(run) inside BEGIN/COMMIT. Any throw => ROLLBACK.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
