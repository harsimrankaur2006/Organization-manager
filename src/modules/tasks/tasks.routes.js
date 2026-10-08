const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const { ok, okPage } = require('../../utils/ok');
const { z, uuid, paginationQuery } = require('../../utils/schemas');
const service = require('./tasks.service');

const actor = (req) => ({ id: req.user.id, role: req.membership.role });

const projectParams = z.object({ orgId: uuid, projectId: uuid });
const taskParams = z.object({ orgId: uuid, taskId: uuid });

const status = z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']);
const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const createBody = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(10000).optional(),
  priority: priority.optional(),
  assigneeId: uuid.optional(),
  dueDate: dueDate.optional(),
});
const updateBody = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(10000).optional(),
    priority: priority.optional(),
    status: status.optional(),
    assigneeId: uuid.nullable().optional(),
    dueDate: dueDate.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

const listQuery = paginationQuery.extend({
  status: status.optional(),
  priority: priority.optional(),
  assigneeId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

// ---------- mounted at /api/orgs/:orgId/projects/:projectId/tasks
const projectTaskRouter = express.Router({ mergeParams: true });

projectTaskRouter.post('/', validate({ params: projectParams, body: createBody }), asyncHandler(async (req, res) => {
  ok(res, await service.create(req.params.orgId, req.params.projectId, actor(req), req.body), 'Task created', 201);
}));

projectTaskRouter.get('/', validate({ params: projectParams, query: listQuery }), asyncHandler(async (req, res) => {
  okPage(res, await service.listByProject(req.params.orgId, req.params.projectId, actor(req), req.query));
}));

// ---------- mounted at /api/orgs/:orgId/tasks
const taskRouter = express.Router({ mergeParams: true });

// must be declared BEFORE '/:taskId' so "mine" is not treated as an id
taskRouter.get('/mine', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  okPage(res, await service.listMine(req.params.orgId, actor(req), req.query));
}));

taskRouter.get('/:taskId', validate({ params: taskParams }), asyncHandler(async (req, res) => {
  ok(res, await service.getById(req.params.orgId, req.params.taskId, actor(req)));
}));

taskRouter.patch('/:taskId', validate({ params: taskParams, body: updateBody }), asyncHandler(async (req, res) => {
  ok(res, await service.update(req.params.orgId, req.params.taskId, actor(req), req.body), 'Task updated');
}));

taskRouter.delete('/:taskId', validate({ params: taskParams }), asyncHandler(async (req, res) => {
  await service.remove(req.params.orgId, req.params.taskId, actor(req));
  ok(res, null, 'Task deleted');
}));

module.exports = { projectTaskRouter, taskRouter };
