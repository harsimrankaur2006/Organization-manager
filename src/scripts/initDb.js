// npm run db:init  -> runs db/schema.sql (DROPS and recreates all tables)
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { pool } = require('../config/db');

(async () => {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to run db:init in production (it drops all tables).');
    process.exit(1);
  }
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Database schema created successfully.');
  } catch (err) {
    console.error('Failed to create schema:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
