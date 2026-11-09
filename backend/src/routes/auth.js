'use strict';
// /v1/auth/* – Anmeldung. Strenges Rate-Limit pro IP gegen Passwort-Raten.

const { sendJson } = require('../lib/http');
const { body } = require('../middleware/validation');
const { rateLimit, byIp } = require('../middleware/rate-limit');

const email = { type: 'string', required: true, email: true, max: 320 };
const password = { type: 'string', required: true, min: 8, max: 128, trim: false };
const code = { type: 'string', required: true, pattern: /^[0-9]{6,10}$/ };

/** @param {{ router: any, auth: any, requireAuth: any }} deps */
function authRoutes({ router, auth, requireAuth }) {
  const strict = rateLimit({ name: 'auth', capacity: 10, refillPerSec: 10 / 60, key: byIp });
  const refreshLimit = rateLimit({ name: 'refresh', capacity: 30, refillPerSec: 30 / 60, key: byIp });

  router.post('/v1/auth/signup', strict, body({ email, password, displayName: { type: 'string', max: 80 } }), async (req, res) => {
    const r = await auth.signup(req.body);
    sendJson(res, r.session ? 200 : 202, r);
  });

  router.post('/v1/auth/login', strict, body({ email, password }), async (req, res) => {
    sendJson(res, 200, { session: await auth.login(req.body) });
  });

  router.post('/v1/auth/verify-email', strict, body({ email, code }), async (req, res) => {
    sendJson(res, 200, { session: await auth.verifyEmail(req.body) });
  });

  router.post('/v1/auth/resend-confirmation', strict, body({ email }), async (req, res) => {
    await auth.resendConfirmation(req.body);
    sendJson(res, 202, { ok: true });
  });

  router.post('/v1/auth/password-reset', strict, body({ email }), async (req, res) => {
    await auth.requestPasswordReset(req.body);
    sendJson(res, 202, { ok: true });
  });

  router.post('/v1/auth/password-reset/confirm', strict, body({ email, code, password }), async (req, res) => {
    sendJson(res, 200, { session: await auth.resetPassword(req.body) });
  });

  router.post('/v1/auth/refresh', refreshLimit, body({ refreshToken: { type: 'string', required: true, min: 10, max: 2000 } }), async (req, res) => {
    sendJson(res, 200, { session: await auth.refresh(req.body) });
  });

  router.post('/v1/auth/logout', requireAuth, async (req, res) => {
    await auth.logout({ accessToken: req.user.token });
    sendJson(res, 200, { ok: true });
  });

  router.get('/v1/auth/google/config', async (_req, res) => {
    sendJson(res, 200, auth.googleConfig());
  });

  router.post('/v1/auth/google', strict, body({
    code: { type: 'string', required: true, min: 10, max: 2048 },
    codeVerifier: { type: 'string', required: true, min: 43, max: 128, pattern: /^[A-Za-z0-9._~-]+$/ },
    redirectUri: { type: 'string', required: true, max: 64 },
    nonce: { type: 'string', required: true, min: 32, max: 128, pattern: /^[A-Za-z0-9._~-]+$/ },
  }), async (req, res) => {
    sendJson(res, 200, { session: await auth.google(req.body) });
  });

  return { limits: [strict, refreshLimit] };
}

module.exports = { authRoutes };
