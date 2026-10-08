const router = require('express').Router({ mergeParams: true });
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const { requireRole } = require('../../middleware/rbac');
const { ok, okPage } = require('../../utils/ok');
const { z, uuid, paginationQuery } = require('../../utils/schemas');
const service = require('./members.service');

const userParams = z.object({ orgId: uuid, userId: uuid });
const addBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['MANAGER', 'EMPLOYEE']),
  reportsTo: uuid.optional(),
});
const updateBody = z
  .object({ role: z.enum(['MANAGER', 'EMPLOYEE']).optional(), reportsTo: uuid.nullable().optional() })
  .refine((b) => b.role !== undefined || b.reportsTo !== undefined, { message: 'Provide role and/or reportsTo' });
const listQuery = paginationQuery.extend({
  role: z.enum(['OWNER', 'MANAGER', 'EMPLOYEE']).optional(),
  search: z.string().trim().max(100).optional(),
});

const actor = (req) => ({ id: req.user.id, role: req.membership.role });

// any member can view the member list
router.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  okPage(res, await service.list(req.params.orgId, req.query));
}));

router.post('/', requireRole('OWNER', 'MANAGER'), validate({ body: addBody }), asyncHandler(async (req, res) => {
  ok(res, await service.add(req.params.orgId, actor(req), req.body), 'Member added', 201);
}));

router.patch('/:userId', requireRole('OWNER'), validate({ params: userParams, body: updateBody }), asyncHandler(async (req, res) => {
  ok(res, await service.update(req.params.orgId, actor(req), req.params.userId, req.body), 'Member updated');
}));

router.delete('/:userId', requireRole('OWNER', 'MANAGER'), validate({ params: userParams }), asyncHandler(async (req, res) => {
  await service.remove(req.params.orgId, actor(req), req.params.userId);
  ok(res, null, 'Member removed');
}));

module.exports = router;
