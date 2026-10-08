const router = require('express').Router({ mergeParams: true });
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const { requireRole } = require('../../middleware/rbac');
const { okPage } = require('../../utils/ok');
const { z, uuid, paginationQuery } = require('../../utils/schemas');
const service = require('./audit.service');

const listQuery = paginationQuery.extend({
  action: z.string().max(60).optional(),
  userId: uuid.optional(),
  entityType: z.string().max(40).optional(),
  traceId: z.string().max(64).optional(),
});

// OWNER only
router.get('/', requireRole('OWNER'), validate({ query: listQuery }), asyncHandler(async (req, res) => {
  okPage(res, await service.list(req.params.orgId, req.query));
}));

module.exports = router;
