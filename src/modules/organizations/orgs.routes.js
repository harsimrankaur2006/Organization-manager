const router = require('express').Router();
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const authenticate = require('../../middleware/auth');
const { requireMember, requireRole } = require('../../middleware/rbac');
const { ok, okPage } = require('../../utils/ok');
const { z, paginationQuery, orgParams } = require('../../utils/schemas');
const service = require('./orgs.service');

const nameBody = z.object({ name: z.string().trim().min(2).max(150) });
const listQuery = paginationQuery.extend({ search: z.string().trim().max(100).optional() });

// Everything below requires a valid JWT
router.use(authenticate);

router.post('/', validate({ body: nameBody }), asyncHandler(async (req, res) => {
  ok(res, await service.create(req.user.id, req.body.name), 'Organization created', 201);
}));

router.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  okPage(res, await service.listMine(req.user.id, req.query));
}));

// Everything under /:orgId requires membership in that org (RBAC step 1)
router.use('/:orgId', validate({ params: orgParams }), requireMember);

router.get('/:orgId', asyncHandler(async (req, res) => {
  ok(res, { ...(await service.getById(req.params.orgId)), myRole: req.membership.role });
}));

router.patch('/:orgId', requireRole('OWNER'), validate({ body: nameBody }), asyncHandler(async (req, res) => {
  ok(res, await service.rename(req.params.orgId, req.user.id, req.body.name), 'Organization renamed');
}));

// Nested resources (each router applies requireRole where needed - RBAC step 2)
router.use('/:orgId/members', require('../members/members.routes'));
router.use('/:orgId/projects', require('../projects/projects.routes'));
router.use('/:orgId/tasks', require('../tasks/tasks.routes').taskRouter);
router.use('/:orgId/audit-logs', require('../audit/audit.routes'));

module.exports = router;
