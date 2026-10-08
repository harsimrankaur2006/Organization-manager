const { query } = require('../config/db');
const AppError = require('./AppError');

/**
 * Validates sort params against a WHITELIST (never put user input into ORDER BY directly).
 * sortable: { apiName: 'sql_column' }
 */
function parsePagination(q, { sortable, defaultSort, defaultOrder = 'desc', tiebreaker }) {
  const sortKey = q.sortBy || defaultSort;
  if (!Object.prototype.hasOwnProperty.call(sortable, sortKey)) {
    throw AppError.badRequest(`Invalid sortBy '${sortKey}'. Allowed: ${Object.keys(sortable).join(', ')}`);
  }
  const order = (q.order || defaultOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const page = q.page || 1;
  const size = q.size || 10;
  return {
    page,
    size,
    offset: (page - 1) * size,
    sortKey,
    order: order.toLowerCase(),
    // tiebreaker makes paging stable when many rows share the same sort value
    orderBy: `${sortable[sortKey]} ${order} NULLS LAST, ${tiebreaker}`,
  };
}

function buildMeta({ page, size, total, sortKey, order }) {
  const totalPages = Math.max(1, Math.ceil(total / size));
  return {
    page,
    size,
    totalItems: total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    sortBy: sortKey,
    order,
  };
}

/**
 * Runs the COUNT query and the page query in parallel.
 *   select : column list
 *   from   : FROM clause including JOINs
 *   where  : a Where instance
 *   pg     : result of parsePagination
 */
async function paginate({ select, from, where, pg }) {
  const p = where.params;
  const countSql = `SELECT COUNT(*)::int AS total FROM ${from} ${where.sql}`;
  const dataSql =
    `SELECT ${select} FROM ${from} ${where.sql} ` +
    `ORDER BY ${pg.orderBy} LIMIT $${p.length + 1} OFFSET $${p.length + 2}`;
  const [count, data] = await Promise.all([query(countSql, p), query(dataSql, [...p, pg.size, pg.offset])]);
  return {
    rows: data.rows,
    pagination: buildMeta({ page: pg.page, size: pg.size, total: count.rows[0].total, sortKey: pg.sortKey, order: pg.order }),
  };
}

module.exports = { parsePagination, paginate, buildMeta };
