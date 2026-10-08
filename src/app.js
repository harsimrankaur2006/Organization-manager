const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const env = require('./config/env');
const { query } = require('./config/db');
const cache = require('./config/cache');

const traceId = require('./middleware/traceId');
const requestLogger = require('./middleware/requestLogger');
const { apiLimiter, authLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const asyncHandler = require('./utils/asyncHandler');

const app = express();
app.disable('x-powered-by');

app.use(traceId);                                   // 1. trace id for every request
// upgrade-insecure-requests would break http://localhost in some browsers
app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'upgrade-insecure-requests': null } } }));  // 2. security headers
app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '100kb' }));          // 3. body parser (limit stops huge payloads)
app.use(express.static(path.join(__dirname, '..', 'public')));  // simple frontend

app.use('/api', requestLogger, apiLimiter);         // 4. logging + global rate limit

app.get('/api/health', asyncHandler(async (req, res) => {
  await query('SELECT 1');
  res.json({ success: true, data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()), cache: cache.stats() } });
}));

app.use('/api/auth', authLimiter, require('./modules/auth/auth.routes'));
app.use('/api/orgs', require('./modules/organizations/orgs.routes'));

app.use(notFound);                                  // 5. unknown route -> JSON 404
app.use(errorHandler);                              // 6. THE global exception handler (must be last)

module.exports = app;
