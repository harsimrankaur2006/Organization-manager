const { query, withTransaction } = require('../../config/db');
const cache = require('../../config/cache');
const AppError = require('../../utils/AppError');
const { Where, likePattern } = require('../../utils/queryBuilder');
const { parsePagination, paginate } = require('../../utils/pagination');
const audit = require('../audit/audit.service');

// The creator automatically becomes OWNER. Two inserts => one transaction.
async function create(userId, name) {
  try {
    const org = await withTransaction(async (run) => {
      const { rows } = await run(
        'INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id, created_at',
        [name, userId]
      );
      await run(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'OWNER')`, [userId, rows[0].id]);
      return rows[0];
    });
    await audit.record({ orgId: org.id, userId, action: 'ORG_CREATED', entityType: 'organization', entityId: org.id, metadata: { name } });
    return org;
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict('An organization with that name already exists');
    throw err;
  }
}

const SORTABLE = { name: 'o.name', joined_at: 'm.joined_at', role: 'm.role' };

// Organizations the current user belongs to
function listMine(userId, q) {
  const pg = parsePagination(q, { sortable: SORTABLE, defaultSort: 'name', defaultOrder: 'asc', tiebreaker: 'o.id' });
  const where = new Where().add('m.user_id = ?', userId);
  if (q.search) where.add('o.name ILIKE ?', likePattern(q.search));

  return paginate({
    select: `o.id, o.name, m.role, m.joined_at,
             (SELECT COUNT(*) FROM memberships mm WHERE mm.org_id = o.id)::int AS member_count`,
    from: 'memberships m JOIN organizations o ON o.id = m.org_id',
    where,
    pg,
  });
}

// Cached for 2 minutes. Invalidated when members/projects change (see invalidate() calls).
function getById(orgId) {
  return cache.wrap(`org:${orgId}`, 120, async () => {
    const { rows } = await query(
      `SELECT o.id, o.name, o.created_at,
              u.id AS owner_id, u.name AS owner_name, u.email AS owner_email,
              (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id AND m.role = 'MANAGER')::int  AS manager_count,
              (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id AND m.role = 'EMPLOYEE')::int AS employee_count,
              (SELECT COUNT(*) FROM projects p    WHERE p.org_id = o.id)::int                          AS project_count
         FROM organizations o
         JOIN users u ON u.id = o.owner_id
        WHERE o.id = $1`,
      [orgId]
    );
    return rows[0] || null;
  }).then((org) => {
    if (!org) throw AppError.notFound('Organization not found');
    return org;
  });
}

async function rename(orgId, userId, name) {
  try {
    await query('UPDATE organizations SET name = $2, updated_at = now() WHERE id = $1', [orgId, name]);
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict('An organization with that name already exists');
    throw err;
  }
  cache.del(`org:${orgId}`);
  await audit.record({ orgId, userId, action: 'ORG_RENAMED', entityType: 'organization', entityId: orgId, metadata: { name } });
  return getById(orgId);
}

module.exports = { create, listMine, getById, rename };
