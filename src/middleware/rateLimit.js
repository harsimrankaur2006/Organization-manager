const rateLimit = require('express-rate-limit');
const AppError = require('../utils/AppError');

const handler = (req, res, next) => next(new AppError(429, 'Too many requests, please try again later', 'RATE_LIMITED'));

exports.apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 500, standardHeaders: true, legacyHeaders: false, handler });
// Stricter on login/register/refresh to slow down brute force attacks
exports.authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, handler });
