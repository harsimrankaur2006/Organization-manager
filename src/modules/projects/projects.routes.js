const router = require('express').Router({ mergeParams: true });
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const { requireRole } = require('../../middleware/rbac');
const { ok, okPage } = require('../../utils/ok');
const { z, uuid, paginationQuery } = require('../../utils/schemas');
const service = require('./projects.service');
const { projectTaskRouter } = require('../tasks/tasks.routes');

const projectParams = z.object({ orgId: uuid, projectId: uuid });
const memberParams = z.object({ orgId: uuid, projectId: uuid, userId: uuid });

const createBody = z.object({
  name: z.string().trim().min(2).max(150),
  projectKey: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Key must be 2-10 letters/digits, starting with a letter'),
  description: z.string().trim().max(5000).optional(),
  managerId: uuid.optional(),
});
const updateBody = z
  .object({
    name: z.string().trim().min(2).max(150).optional(),
    description: z.string().trim().max(5000).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    managerId: uuid.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
const listQuery = paginationQuery.extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  search: z.string().trim().max(100).optional(),
});

const actor = (req) => ({ id: req.user.id, role: req.membership.role });

router.post('/', requireRole('OWNER', 'MANAGER'), validate({ body: createBody }), asyncHandler(async (req, res) => {
  ok(res, await service.create(req.params.orgId, actor(req), req.body), 'Project created', 201);
}));

router.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  okPage(res, await service.list(req.params.orgId, actor(req), req.query));
}));

router.get('/:projectId', validate({ params: projectParams }), asyncHandler(async (req, res) => {
  ok(res, await service.getById(req.params.orgId, req.params.projectId, actor(req)));
}));

router.patch('/:projectId', validate({ params: projectParams, body: updateBody }), asyncHandler(async (req, res) => {
  ok(res, await service.update(req.params.orgId, req.params.projectId, actor(req), req.body), 'Project updated');
}));

// ---- project members
router.get('/:projectId/members', validate({ params: projectParams }), asyncHandler(async (req, res) => {
  ok(res, await service.listMembers(req.params.orgId, req.params.projectId, actor(req)));
}));

router.post('/:projectId/members', validate({ params: projectParams, body: z.object({ userId: uuid }) }), asyncHandler(async (req, res) => {
  await service.addMember(req.params.orgId, req.params.projectId, actor(req), req.body.userId);
  ok(res, null, 'Member added to project', 201);
}));

router.delete('/:projectId/members/:userId', validate({ params: memberParams }), asyncHandler(async (req, res) => {
  await service.removeMember(req.params.orgId, req.params.projectId, actor(req), req.params.userId);
  ok(res, null, 'Member removed from project');
}));

// ---- tasks of a project:  /api/orgs/:orgId/projects/:projectId/tasks
router.use('/:projectId/tasks', projectTaskRouter);

module.exports = router;
