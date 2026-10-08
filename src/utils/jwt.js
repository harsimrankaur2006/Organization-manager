const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

const ISSUER = 'org-platform';

function signAccessToken(user) {
  const jti = crypto.randomUUID(); // unique id, lets us blacklist this token on logout
  const token = jwt.sign({ sub: user.id, email: user.email, jti }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    issuer: ISSUER,
  });
  return { token, jti };
}

function verifyAccessToken(token) {
  // Pin the algorithm: prevents the classic "alg: none" / algorithm-confusion attacks.
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
}

module.exports = { signAccessToken, verifyAccessToken };
