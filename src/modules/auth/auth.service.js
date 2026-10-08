const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const env = require('../../config/env');
const cache = require('../../config/cache');
const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { encrypt, decrypt, sha256, randomToken } = require('../../utils/crypto');
const { signAccessToken } = require('../../utils/jwt');
const audit = require('../audit/audit.service');
const logger = require('../../config/logger');

// Used so a login for an unknown email takes the same time as a real one (timing attack defence).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', env.BCRYPT_ROUNDS);

async function register({ name, email, password, phone }) {
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
  try {
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, phone_enc)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, created_at`,
      [name, email.toLowerCase(), passwordHash, encrypt(phone)]
    );
    await audit.record({ userId: rows[0].id, action: 'USER_REGISTERED', entityType: 'user', entityId: rows[0].id });
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict('Email is already registered');
    throw err;
  }
}

// Creates an access token (JWT, short lived) + refresh token (random, stored hashed, long lived)
async function issueTokens(user, { familyId, userAgent, ip }, run = query) {
  const { token: accessToken } = signAccessToken(user);
  const refreshToken = randomToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await run(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, sha256(refreshToken), familyId || randomUUID(), expiresAt, (userAgent || '').slice(0, 255), ip || null]
  );
  return { tokenType: 'Bearer', accessToken, expiresIn: env.JWT_ACCESS_EXPIRES_IN, refreshToken };
}

async function login({ email, password }, meta) {
  const { rows } = await query('SELECT id, name, email, password_hash, is_active FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];
  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid || !user.is_active) {
    logger.warn('Failed login attempt', { email: email.toLowerCase() });
    throw AppError.unauthorized('Invalid email or password');
  }
  const tokens = await issueTokens(user, meta);
  await audit.record({ userId: user.id, action: 'USER_LOGIN', entityType: 'user', entityId: user.id });
  return { user: { id: user.id, name: user.name, email: user.email }, ...tokens };
}

// Refresh-token ROTATION: every refresh revokes the old token and issues a new one.
// If an already-used token shows up again, someone stole it => revoke the whole session family.
async function refresh(rawToken, meta) {
  const outcome = await withTransaction(async (run) => {
    const { rows } = await run(
      `SELECT rt.id, rt.user_id, rt.family_id, rt.revoked, rt.expires_at, u.email, u.is_active
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
          FOR UPDATE OF rt`,
      [sha256(rawToken)]
    );
    const row = rows[0];
    if (!row) return { error: 'invalid' };
    if (row.revoked) {
      await run('UPDATE refresh_tokens SET revoked = TRUE WHERE family_id = $1', [row.family_id]);
      return { error: 'reuse', userId: row.user_id };
    }
    if (new Date(row.expires_at) < new Date() || !row.is_active) return { error: 'expired' };

    await run('UPDATE refresh_tokens SET revoked = TRUE, last_used_at = now() WHERE id = $1', [row.id]);
    const tokens = await issueTokens({ id: row.user_id, email: row.email }, { ...meta, familyId: row.family_id }, run);
    return { tokens };
  });

  // Throw AFTER the transaction committed so the family revocation is kept.
  if (outcome.error === 'reuse') {
    logger.warn('Refresh token reuse detected - session family revoked', { userId: outcome.userId });
    await audit.record({ userId: outcome.userId, action: 'REFRESH_TOKEN_REUSE_DETECTED', entityType: 'user', entityId: outcome.userId });
    throw new AppError(401, 'Refresh token reuse detected. Please log in again.', 'TOKEN_REUSE');
  }
  if (outcome.error) throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  return outcome.tokens;
}

async function logout(user, rawRefreshToken) {
  // 1. blacklist the current access token until it would have expired anyway
  const ttl = Math.max(1, user.exp - Math.floor(Date.now() / 1000));
  cache.set(`bl:${user.jti}`, true, ttl);

  // 2. revoke this login session (the whole token family)
  if (rawRefreshToken) {
    await query(
      `UPDATE refresh_tokens SET revoked = TRUE
        WHERE user_id = $2
          AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2)`,
      [sha256(rawRefreshToken), user.id]
    );
  }
  await audit.record({ userId: user.id, action: 'USER_LOGOUT', entityType: 'user', entityId: user.id });
}

async function getProfile(userId) {
  const [userRes, orgRes] = await Promise.all([
    query('SELECT id, name, email, phone_enc, created_at FROM users WHERE id = $1', [userId]),
    query(
      `SELECT m.org_id, o.name AS org_name, m.role, m.joined_at
         FROM memberships m
         JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1
        ORDER BY o.name`,
      [userId]
    ),
  ]);
  const u = userRes.rows[0];
  if (!u) throw AppError.notFound('User not found');
  return { id: u.id, name: u.name, email: u.email, phone: decrypt(u.phone_enc), createdAt: u.created_at, organizations: orgRes.rows };
}

async function updateProfile(userId, { name, phone }) {
  const phoneProvided = phone !== undefined;
  await query(
    `UPDATE users
        SET name       = COALESCE($2, name),
            phone_enc  = CASE WHEN $3::boolean THEN $4 ELSE phone_enc END,
            updated_at = now()
      WHERE id = $1`,
    [userId, name || null, phoneProvided, phoneProvided ? encrypt(phone) : null]
  );
  cache.del(`user:${userId}`);
  return getProfile(userId);
}

module.exports = { register, login, refresh, logout, getProfile, updateProfile };
