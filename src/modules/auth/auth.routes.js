const router = require('express').Router();
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middleware/validate');
const authenticate = require('../../middleware/auth');
const { ok } = require('../../utils/ok');
const { z } = require('../../utils/schemas');
const service = require('./auth.service');

const email = z.string().trim().toLowerCase().email().max(255);
// bcrypt only uses the first 72 bytes, so cap there
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');
const phone = z.string().trim().regex(/^\+?[0-9 \-]{7,20}$/, 'Invalid phone number');

const registerBody = z.object({ name: z.string().trim().min(2).max(100), email, password, phone: phone.optional() });
const loginBody = z.object({ email, password: z.string().min(1).max(72) });
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const logoutBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });
const profileBody = z.object({ name: z.string().trim().min(2).max(100).optional(), phone: phone.nullable().optional() });

const meta = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

router.post('/register', validate({ body: registerBody }), asyncHandler(async (req, res) => {
  ok(res, await service.register(req.body), 'Registered successfully', 201);
}));

router.post('/login', validate({ body: loginBody }), asyncHandler(async (req, res) => {
  ok(res, await service.login(req.body, meta(req)), 'Logged in');
}));

router.post('/refresh', validate({ body: refreshBody }), asyncHandler(async (req, res) => {
  ok(res, await service.refresh(req.body.refreshToken, meta(req)));
}));

router.post('/logout', authenticate, validate({ body: logoutBody }), asyncHandler(async (req, res) => {
  await service.logout(req.user, req.body.refreshToken);
  ok(res, null, 'Logged out');
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  ok(res, await service.getProfile(req.user.id));
}));

router.patch('/me', authenticate, validate({ body: profileBody }), asyncHandler(async (req, res) => {
  ok(res, await service.updateProfile(req.user.id, req.body), 'Profile updated');
}));

module.exports = router;
