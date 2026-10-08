const { query, withTransaction } = require('../../config/db');
const cache = require('../../config/cache');
const AppError = require('../../utils/AppError');
const { Where, likePattern } = require('../../utils/queryBuilder');
const { parsePagination, paginate } = require('../../utils/pagination');
const audit = require('../audit/audit.service');

// Used by the RBAC middleware on EVERY org request, so it is cached (60s).
// Cache is invalidated whenever a membership changes.
function getMembership(orgId, userId) {
  return cache.wrap(`member:${orgId}:${userId}`, 60, async () => {
    const { rows } = await query(
      'SELECT role, reports_to FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    return rows[0] || null;
  });
}

const invalidate = (orgId, userId) => {
  if (userId) cache.del(`member:${orgId}:${userId}`);
  cache.del(`org:${orgId}`);
  cache.delByPrefix(`project:${orgId}:`);
};

async function assertCanSupervise(orgId, userId) {
  const { rowCount } = await query(
    `SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2 AND role IN ('OWNER', 'MANAGER')`,
    [orgId, userId]
  );
  if (!rowCount) throw AppError.badRequest('reportsTo must be an OWNER or MANAGER of this organization');
}

async function add(orgId, actor, { email, role, reportsTo }) {
  // OWNER can add MANAGER / EMPLOYEE. MANAGER can add EMPLOYEE only.
  if (actor.role === 'MANAGER' && role !== 'EMPLOYEE') throw AppError.forbidden('Managers can only add employees');

  const userRes = await query('SELECT id, name, email, is_active FROM users WHERE email = $1', [email]);
  const target = userRes.rows[0];
  if (!target || !target.is_active) throw AppError.notFound('No registered user with that email. Ask them to register first.');

  if (reportsTo) await assertCanSupervise(orgId, reportsTo);

  try {
    const { rows } = await query(
      `INSERT INTO memberships (user_id, org_id, role, reports_to)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, org_id, role, reports_to, joined_at`,
      [target.id, orgId, role, reportsTo || actor.id]
    );
    invalidate(orgId, target.id);
    await audit.record({ orgId, userId: actor.id, action: 'MEMBER_ADDED', entityType: 'user', entityId: target.id, metadata: { email, role } });
    return { ...rows[0], name: target.name, email: target.email };
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict('User is already a member of this organization');
    throw err;
  }
}

const SORTABLE = { name: 'u.name', email: 'u.email', role: 'm.role', joined_at: 'm.joined_at' };

function list(orgId, q) {
  const pg = parsePagination(q, { sortable: SORTABLE, defaultSort: 'joined_at', defaultOrder: 'asc', tiebreaker: 'u.id' });
  const where = new Where().add('m.org_id = ?', orgId);
  if (q.role) where.add('m.role = ?', q.role);
  if (q.search) where.add('(u.name ILIKE ? OR u.email ILIKE ?)', likePattern(q.search));

  return paginate({
    select: `u.id AS user_id, u.name, u.email, m.role, m.joined_at,
             r.id AS reports_to_id, r.name AS reports_to_name`,
    from: `memberships m
           JOIN users u       ON u.id = m.user_id
           LEFT JOIN users r  ON r.id = m.reports_to`,
    where,
    pg,
  });
}

async function getTarget(orgId, userId) {
  const { rows } = await query('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!rows[0]) throw AppError.notFound('That user is not a member of this organization');
  return rows[0];
}

async function assertNoProjectsManaged(orgId, userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM projects WHERE org_id = $1 AND manager_id = $2',
    [orgId, userId]
  );
  if (rows[0].n > 0) throw AppError.conflict(`User still manages ${rows[0].n} project(s). Reassign them first.`);
}

// OWNER only (route level)
async function update(orgId, actor, targetUserId, { role, reportsTo }) {
  const target = await getTarget(orgId, targetUserId);
  if (target.role === 'OWNER') throw AppError.forbidden('The owner role cannot be changed');
  if (reportsTo) await assertCanSupervise(orgId, reportsTo);
  if (reportsTo === targetUserId) throw AppError.badRequest('A user cannot report to themselves');

  const demoting = role === 'EMPLOYEE' && target.role === 'MANAGER';
  if (demoting) await assertNoProjectsManaged(orgId, targetUserId);

  const updated = await withTransaction(async (run) => {
    const { rows } = await run(
      `UPDATE memberships
          SET role       = COALESCE($3::member_role, role),
              reports_to = CASE WHEN $4::boolean THEN $5::uuid ELSE reports_to END
        WHERE org_id = $1 AND user_id = $2
        RETURNING user_id, org_id, role, reports_to`,
      [orgId, targetUserId, role || null, reportsTo !== undefined, reportsTo === undefined ? null : reportsTo]
    );
    if (demoting) {
      // people who reported to the demoted manager now report to the owner
      await run('UPDATE memberships SET reports_to = $3 WHERE org_id = $1 AND reports_to = $2', [orgId, targetUserId, actor.id]);
    }
    return rows[0];
  });

  invalidate(orgId, targetUserId);
  await audit.record({ orgId, userId: actor.id, action: 'MEMBER_UPDATED', entityType: 'user', entityId: targetUserId, metadata: { from: target.role, role, reportsTo } });
  return updated;
}

async function remove(orgId, actor, targetUserId) {
  const target = await getTarget(orgId, targetUserId);
  if (target.role === 'OWNER') throw AppError.forbidden('The owner cannot be removed');
  if (actor.role === 'MANAGER' && target.role !== 'EMPLOYEE') throw AppError.forbidden('Managers can only remove employees');
  await assertNoProjectsManaged(orgId, targetUserId);

  await withTransaction(async (run) => {
    // un-assign their tasks and drop them from this org's projects
    await run(
      `UPDATE tasks SET assignee_id = NULL, updated_at = now()
        WHERE assignee_id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
      [orgId, targetUserId]
    );
    await run(
      `DELETE FROM project_members
        WHERE user_id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
      [orgId, targetUserId]
    );
    // their reports move up to the owner
    await run(
      `UPDATE memberships
          SET reports_to = (SELECT owner_id FROM organizations WHERE id = $1)
        WHERE org_id = $1 AND reports_to = $2`,
      [orgId, targetUserId]
    );
    await run('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, targetUserId]);
  });

  invalidate(orgId, targetUserId);
  await audit.record({ orgId, userId: actor.id, action: 'MEMBER_REMOVED', entityType: 'user', entityId: targetUserId, metadata: { role: target.role } });
}

module.exports = { getMembership, add, list, update, remove };
