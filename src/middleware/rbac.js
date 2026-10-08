const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { getMembership } = require('../modules/members/members.service');

// Step 1 - is the user a member of :orgId? Attaches req.membership = { role, reports_to }
const requireMember = asyncHandler(async (req, res, next) => {
  const membership = await getMembership(req.params.orgId, req.user.id);
  if (!membership) throw AppError.forbidden('You are not a member of this organization');
  req.membership = membership;
  next();
});

// Step 2 - does the user's role in THIS org allow the action?  requireRole('OWNER', 'MANAGER')
const requireRole = (...roles) => (req, res, next) => {
  if (!req.membership || !roles.includes(req.membership.role)) {
    return next(AppError.forbidden(`This action requires role: ${roles.join(' or ')}`));
  }
  next();
};

module.exports = { requireMember, requireRole };
