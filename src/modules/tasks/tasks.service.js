const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { Where, likePattern } = require('../../utils/queryBuilder');
const { parsePagination, paginate } = require('../../utils/pagination');
const projects = require('../projects/projects.service');
const audit = require('../audit/audit.service');

// One SELECT list + FROM used by every task read => consistent shape everywhere.
// Joins: tasks -> projects (key/name), assignee (optional), reporter.
const TASK_SELECT = `
  t.id, p.project_key || '-' || t.task_number AS task_key,
  t.title, t.description, t.status, t.priority, t.due_date, t.created_at, t.updated_at,
  p.id AS project_id, p.name AS project_name,
  a.id AS assignee_id, a.name AS assignee_name,
  r.id AS reporter_id, r.name AS reporter_name`;

const TASK_FROM = `
  tasks t
  JOIN projects p       ON p.id = t.project_id
  LEFT JOIN users a     ON a.id = t.assignee_id
  JOIN users r          ON r.id = t.reporter_id`;

const SORTABLE = {
  created_at: 't.created_at',
  updated_at: 't.updated_at',
  due_date: 't.due_date',
  priority: 't.priority', // enum order: LOW < MEDIUM < HIGH < CRITICAL
  status: 't.status',     // enum order: TODO < IN_PROGRESS < IN_REVIEW < DONE
  title: 't.title',
};

function applyFilters(where, q) {
  if (q.status) where.add('t.status = ?', q.status);
  if (q.priority) where.add('t.priority = ?', q.priority);
  if (q.assigneeId) where.add('t.assignee_id = ?', q.assigneeId);
  if (q.search) where.add('(t.title ILIKE ? OR t.description ILIKE ?)', likePattern(q.search));
  if (q.overdue) where.raw(`t.due_date < CURRENT_DATE AND t.status <> 'DONE'`);
  return where;
}

async function assertProjectMember(projectId, userId) {
  const { rowCount } = await query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
  if (!rowCount) throw AppError.badRequest('Assignee must be a member of the project');
}

async function fetchOne(orgId, taskId) {
  const { rows } = await query(`SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = $1 AND p.org_id = $2`, [taskId, orgId]);
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

async function create(orgId, projectId, actor, { title, description, priority, assigneeId, dueDate }) {
  const project = await projects.getAccessible(orgId, projectId, actor);
  if (!projects.canManage(project, actor)) throw AppError.forbidden('Only the owner or the project manager can create tasks');
  if (project.status === 'ARCHIVED') throw AppError.conflict('Cannot add tasks to an archived project');
  if (assigneeId) await assertProjectMember(projectId, assigneeId);

  const taskId = await withTransaction(async (run) => {
    // The UPDATE takes a row lock on the project, so two people creating tasks at the same
    // moment get different numbers (WEB-7, WEB-8) instead of a duplicate.
    const counter = await run('UPDATE projects SET task_counter = task_counter + 1 WHERE id = $1 RETURNING task_counter', [projectId]);
    const { rows } = await run(
      `INSERT INTO tasks (project_id, task_number, title, description, priority, assignee_id, reporter_id, due_date)
       VALUES ($1, $2, $3, $4, COALESCE($5::task_priority, 'MEDIUM'), $6, $7, $8)
       RETURNING id`,
      [projectId, counter.rows[0].task_counter, title, description || '', priority || null, assigneeId || null, actor.id, dueDate || null]
    );
    return rows[0].id;
  });

  projects.invalidateProject(orgId, projectId);
  await audit.record({ orgId, userId: actor.id, action: 'TASK_CREATED', entityType: 'task', entityId: taskId, metadata: { title, assigneeId } });
  return fetchOne(orgId, taskId);
}

async function listByProject(orgId, projectId, actor, q) {
  await projects.getAccessible(orgId, projectId, actor);
  const pg = parsePagination(q, { sortable: SORTABLE, defaultSort: 'created_at', tiebreaker: 't.id' });
  const where = new Where().add('t.project_id = ?', projectId);
  applyFilters(where, q);
  return paginate({ select: TASK_SELECT, from: TASK_FROM, where, pg });
}

// Tasks assigned to me across all projects of this org
function listMine(orgId, actor, q) {
  const pg = parsePagination(q, { sortable: SORTABLE, defaultSort: 'due_date', defaultOrder: 'asc', tiebreaker: 't.id' });
  const where = new Where().add('p.org_id = ?', orgId).add('t.assignee_id = ?', actor.id);
  applyFilters(where, q);
  return paginate({ select: TASK_SELECT, from: TASK_FROM, where, pg });
}

async function getById(orgId, taskId, actor) {
  const task = await fetchOne(orgId, taskId);
  await projects.getAccessible(orgId, task.project_id, actor);
  return task;
}

const FIELD_MAP = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  status: 'status',
  assigneeId: 'assignee_id',
  dueDate: 'due_date',
};

async function update(orgId, taskId, actor, patch) {
  const current = await fetchOne(orgId, taskId);
  const project = await projects.getAccessible(orgId, current.project_id, actor);
  const manager = projects.canManage(project, actor);

  if (!manager) {
    // An assignee may ONLY move their own task between statuses.
    const onlyStatus = Object.keys(patch).every((k) => k === 'status');
    if (current.assignee_id !== actor.id || !onlyStatus) {
      throw AppError.forbidden('You can only change the status of tasks assigned to you');
    }
  }
  if (patch.assigneeId) await assertProjectMember(current.project_id, patch.assigneeId);

  // Column names come from FIELD_MAP (constants), values are always bound parameters.
  const sets = [];
  const params = [taskId];
  for (const [key, column] of Object.entries(FIELD_MAP)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (!sets.length) throw AppError.badRequest('No updatable fields provided');

  await query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);

  projects.invalidateProject(orgId, current.project_id);
  await audit.record({
    orgId, userId: actor.id, action: 'TASK_UPDATED', entityType: 'task', entityId: taskId,
    metadata: { changed: Object.keys(patch), statusFrom: current.status, statusTo: patch.status },
  });
  return fetchOne(orgId, taskId);
}

async function remove(orgId, taskId, actor) {
  const current = await fetchOne(orgId, taskId);
  const project = await projects.getAccessible(orgId, current.project_id, actor);
  if (!projects.canManage(project, actor)) throw AppError.forbidden('Only the owner or the project manager can delete tasks');

  await query('DELETE FROM tasks WHERE id = $1', [taskId]);
  projects.invalidateProject(orgId, current.project_id);
  await audit.record({ orgId, userId: actor.id, action: 'TASK_DELETED', entityType: 'task', entityId: taskId, metadata: { title: current.title, key: current.task_key } });
}

module.exports = { create, listByProject, listMine, getById, update, remove };
