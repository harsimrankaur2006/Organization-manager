const { z } = require('zod');

const uuid = z.string().uuid('must be a valid UUID');

// Shared by every list endpoint: ?page=1&size=10&sortBy=created_at&order=desc
const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const orgParams = z.object({ orgId: uuid });

module.exports = { z, uuid, paginationQuery, orgParams };
