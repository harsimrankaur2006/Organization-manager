const { query } = require('../../config/db');
const logger = require('../../config/logger');
const { getTraceId } = require('../../config/context');
const { Where } = require('../../utils/queryBuilder');
const { parsePagination, paginate } = require('../../utils/pagination');

// Writes one audit row. Never throws: a failing audit write must not break the user's request.
async function record({ orgId = null, userId = null, action, entityType = null, entityId = null, metadata = {} }) {
  try {
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, entity_type, entity_id, trace_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, userId, action, entityType, entityId, getTraceId() || null, JSON.stringify(metadata)]
    );
  } catch (err) {
    logger.error('Failed to write audit log', { action, message: err.message });
  }
}

const SORTABLE = { created_at: 'a.created_at', action: 'a.action', entity_type: 'a.entity_type' };

async function list(orgId, q) {
  const pg = parsePagination(q, { sortable: SORTABLE, defaultSort: 'created_at', tiebreaker: 'a.id DESC' });
  const where = new Where().add('a.org_id = ?', orgId);
  if (q.action) where.add('a.action = ?', q.action);
  if (q.userId) where.add('a.user_id = ?', q.userId);
  if (q.entityType) where.add('a.entity_type = ?', q.entityType);
  if (q.traceId) where.add('a.trace_id = ?', q.traceId);

  return paginate({
    select: `a.id::text AS id, a.action, a.entity_type, a.entity_id, a.trace_id, a.metadata, a.created_at,
             u.id AS user_id, u.name AS user_name, u.email AS user_email`,
    from: 'audit_logs a LEFT JOIN users u ON u.id = a.user_id',
    where,
    pg,
  });
}

module.exports = { record, list };
