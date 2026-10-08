const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/jwt');
const { query } = require('../config/db');
const cache = require('../config/cache');

// Authentication: "who are you?"  Requires  Authorization: Bearer <accessToken>
module.exports = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw AppError.unauthorized('Missing or malformed Authorization header');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    throw new AppError(401, expired ? 'Access token expired' : 'Invalid access token', expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
  }

  // Token was blacklisted by logout
  if (cache.get(`bl:${payload.jti}`)) throw new AppError(401, 'Token has been revoked', 'TOKEN_REVOKED');

  const user = await cache.wrap(`user:${payload.sub}`, 60, async () => {
    const { rows } = await query('SELECT id, name, email, is_active FROM users WHERE id = $1', [payload.sub]);
    return rows[0] || null;
  });
  if (!user || !user.is_active) throw AppError.unauthorized('Account not found or disabled');

  req.user = { id: user.id, name: user.name, email: user.email, jti: payload.jti, exp: payload.exp };
  next();
});
