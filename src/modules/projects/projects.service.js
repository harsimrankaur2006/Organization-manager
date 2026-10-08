const { query, withTransaction } = require('../../config/db');
const cache = require('../../config/cache');
const AppError = require('../../utils/AppError');
const { Where, likePattern } = require('../../utils/queryBuilder');
const { parsePagination, paginate } = require('../../utils/pagination');
const audit = require('../audit/audit.service');

const projectCacheKey = (orgId, projectId) => `project:${orgId}:${projectId}`;
const invalidateProject = (orgId, projectId) => {
  cache.del(projectCacheKey(orgId, projectId));
  cache.del(`org:${orgId}`);
};

// actor = { id, role }  (role = role in THIS organization)
const canManage = (project, actor) => actor.role === 'OWNER' || project.manager_id === actor.id;

/**
 * Loads the project, scoped to the org (prevents reading another org's project by guessing its id),
 * and checks the actor may see it: OWNER, the project's manager, or a project member.
 */
async function getAccessible(orgId, projectId, actor) {
  const { rows } = await query(
    `SELECT p.id, p.org_id, p.name, p.project_key, p.status, p.manager_id,
            EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3) AS is_member
       FROM projects p
      WHERE p.id = $1 AND p.org_id = $2`,
    [projectId, orgId, actor.id]
  );
  const project = rows[0];
  if (!project) throw AppError.notFound('Project not found');
  if (!(actor.role === 'OWNER' || project.manager_id === actor.id || project.is_member)) {
    throw AppError.forbidden('You are not part of this project');
  }
  return project;
}

async function assertOrgSupervisor(orgId, userId) {
  const { rowCount } = await query(
    `SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2 AND role IN ('OWNER','MANAGER')`,
    [orgId, userId]
  );
  if (!rowCount) throw AppError.badRequest('managerId must belong to an OWNER or MANAGER of this organization');
}

async function create(orgId, actor, { name, projectKey, description, managerId }) {
  let manager = actor.id;
  if (managerId && managerId !== actor.id) {
    if (actor.role !== 'OWNER') throw AppError.forbidden('Only the owner can assign another manager');
    await assertOrgSupervisor(orgId, managerId);
    manager = managerId;
  }
  try {
    const project = await withTransaction(async (run) => {
      const { rows } = await run(
        `INSERT INTO projects (org_id, name, project_key, description, manager_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, org_id, name, project_key, description, status, manager_id, created_at`,
        [orgId, name, projectKey, description || '', manager, actor.id]
      );
      await run('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)', [rows[0].id, manager]);
      return rows[0];
    });
    cache.del(`org:${orgId}`);
    await audit.record({ orgId, userId: actor.id, action: 'PROJECT_CREATED', entityType: 'project', entityId: project.id, metadata: { name, projectKey } });
    return project;
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict(`Project key '${projectKey}' is already used in this organization`);
    throw err;
  }
}

const SORTABLE = { name: 'p.name', project_key: 'p.project_key', created_at: 'p.created_at', status: 'p.status' };

// OWNER sees all projects. Others only see projects they manage or belong to.
function list(orgId, actor, q) {
  const pg = parsePagination(q, { sortable: SORTABLE, defaultSort: 'created_at', tiebreaker: 'p.id' });
  const where = new Where().add('p.org_id = ?', orgId);
  if (actor.role !== 'OWNER') {
    where.add('(p.manager_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))', actor.id);
  }
  if (q.status) where.add('p.status = ?', q.status);
  if (q.search) where.add('(p.name ILIKE ? OR p.project_key ILIKE ?)', likePattern(q.search));

  return paginate({
    select: `p.id, p.name, p.project_key, p.description, p.status, p.created_at,
             mgr.id AS manager_id, mgr.name AS manager_name,
             (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id)::int AS member_count,
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id)::int            AS task_count`,
    from: 'projects p JOIN users mgr ON mgr.id = p.manager_id',
    where,
    pg,
  });
}

// Details + per-status task counts. Access check is live, the heavy part is cached.
async function getById(orgId, projectId, actor) {
  await getAccessible(orgId, projectId, actor);
  return cache.wrap(projectCacheKey(orgId, projectId), 60, async () => {
    const [detail, stats] = await Promise.all([
      query(
        `SELECT p.id, p.name, p.project_key, p.description, p.status, p.created_at,
                mgr.id AS manager_id, mgr.name AS manager_name, mgr.email AS manager_email,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id)::int AS member_count
           FROM projects p
           JOIN users mgr ON mgr.id = p.manager_id
          WHERE p.id = $1 AND p.org_id = $2`,
        [projectId, orgId]
      ),
      query('SELECT status, COUNT(*)::int AS count FROM tasks WHERE project_id = $1 GROUP BY status', [projectId]),
    ]);
    const taskStats = { TODO: 0, IN_PROGRESS: 0, IN_REVIEW: 0, DONE: 0 };
    stats.rows.forEach((r) => { taskStats[r.status] = r.count; });
    return { ...detail.rows[0], taskStats };
  });
}

async function update(orgId, projectId, actor, { name, description, status, managerId }) {
  const project = await getAccessible(orgId, projectId, actor);
  if (!canManage(project, actor)) throw AppError.forbidden('Only the owner or the project manager can edit this project');
  if (managerId) {
    if (actor.role !== 'OWNER') throw AppError.forbidden('Only the owner can change the project manager');
    await assertOrgSupervisor(orgId, managerId);
  }

  await withTransaction(async (run) => {
    await run(
      `UPDATE projects
          SET name        = COALESCE($3, name),
              description = COALESCE($4, description),
              status      = COALESCE($5::project_status, status),
              manager_id  = COALESCE($6::uuid, manager_id),
              updated_at  = now()
        WHERE id = $1 AND org_id = $2`,
      [projectId, orgId, name || null, description === undefined ? null : description, status || null, managerId || null]
    );
    if (managerId) {
      await run('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, managerId]);
    }
  });

  invalidateProject(orgId, projectId);
  await audit.record({ orgId, userId: actor.id, action: 'PROJECT_UPDATED', entityType: 'project', entityId: projectId, metadata: { name, status, managerId } });
  return getById(orgId, projectId, actor);
}

async function listMembers(orgId, projectId, actor) {
  await getAccessible(orgId, projectId, actor);
  const { rows } = await query(
    `SELECT u.id AS user_id, u.name, u.email, m.role, pm.added_at
       FROM project_members pm
       JOIN users u        ON u.id = pm.user_id
       JOIN memberships m  ON m.user_id = u.id AND m.org_id = $2
      WHERE pm.project_id = $1
      ORDER BY u.name`,
    [projectId, orgId]
  );
  return rows;
}

async function addMember(orgId, projectId, actor, userId) {
  const project = await getAccessible(orgId, projectId, actor);
  if (!canManage(project, actor)) throw AppError.forbidden('Only the owner or the project manager can add members');

  const isOrgMember = await query('SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!isOrgMember.rowCount) throw AppError.badRequest('That user is not a member of this organization');

  const { rowCount } = await query(
    'INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [projectId, userId]
  );
  if (!rowCount) throw AppError.conflict('User is already in this project');

  invalidateProject(orgId, projectId);
  await audit.record({ orgId, userId: actor.id, action: 'PROJECT_MEMBER_ADDED', entityType: 'project', entityId: projectId, metadata: { userId } });
}

async function removeMember(orgId, projectId, actor, userId) {
  const project = await getAccessible(orgId, projectId, actor);
  if (!canManage(project, actor)) throw AppError.forbidden('Only the owner or the project manager can remove members');
  if (project.manager_id === userId) throw AppError.conflict('The project manager cannot be removed. Assign a new manager first.');

  const removed = await withTransaction(async (run) => {
    await run('UPDATE tasks SET assignee_id = NULL, updated_at = now() WHERE project_id = $1 AND assignee_id = $2', [projectId, userId]);
    return run('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
  });
  if (!removed.rowCount) throw AppError.notFound('That user is not in this project');

  invalidateProject(orgId, projectId);
  await audit.record({ orgId, userId: actor.id, action: 'PROJECT_MEMBER_REMOVED', entityType: 'project', entityId: projectId, metadata: { userId } });
}

module.exports = { canManage, getAccessible, create, list, getById, update, listMembers, addMember, removeMember, invalidateProject };
