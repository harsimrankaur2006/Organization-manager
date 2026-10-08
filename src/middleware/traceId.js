const { randomUUID } = require('crypto');
const { als } = require('../config/context');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Gives every request a trace id (or reuses a valid incoming X-Trace-Id) and
// stores it in AsyncLocalStorage so logger + audit log can read it anywhere.
module.exports = (req, res, next) => {
  const incoming = req.get('x-trace-id');
  const traceId = incoming && UUID_RE.test(incoming) ? incoming : randomUUID();
  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  als.run({ traceId }, next);
};
