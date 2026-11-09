'use strict';
// Konto, Guthaben, Nutzung, Käufe (users / wallet / usage / purchases).

const { sendJson } = require('../lib/http');
const { body, limitParam } = require('../middleware/validation');
const { rateLimit, byUser } = require('../middleware/rate-limit');

/** @param {{ router: any, wallet: any, stripe: any, requireAuth: any }} deps */
function accountRoutes({ router, wallet, stripe, requireAuth }) {
  const read = rateLimit({ name: 'read', capacity: 60, refillPerSec: 1, key: byUser });
  const checkout = rateLimit({ name: 'checkout', capacity: 5, refillPerSec: 5 / 60, key: byUser });

  // Profil + Guthaben in einem Aufruf (Start der App)
  router.get('/v1/me', requireAuth, read, async (req, res) => {
    const [profile, w] = await Promise.all([wallet.profile(req.user.id), wallet.wallet(req.user.id)]);
    sendJson(res, 200, { user: { id: req.user.id, email: req.user.email }, profile, wallet: w });
  });

  router.patch('/v1/me', requireAuth, read, body({ displayName: { type: 'string', max: 80 } }), async (req, res) => {
    sendJson(res, 200, { profile: await wallet.updateProfile(req.user.id, req.body) });
  });

  router.get('/v1/wallet', requireAuth, read, async (req, res) => {
    sendJson(res, 200, { wallet: await wallet.wallet(req.user.id) });
  });

  router.get('/v1/wallet/transactions', requireAuth, read, async (req, res) => {
    sendJson(res, 200, { transactions: await wallet.transactions(req.user.id, limitParam(req)) });
  });

  router.get('/v1/usage', requireAuth, read, async (req, res) => {
    sendJson(res, 200, { usage: await wallet.usage(req.user.id, limitParam(req)) });
  });

  router.get('/v1/purchases', requireAuth, read, async (req, res) => {
    sendJson(res, 200, { purchases: await wallet.purchases(req.user.id, limitParam(req)) });
  });

  // Pakete sind öffentlich (Preis in CHF und Credits sichtbar vor dem Kauf)
  router.get('/v1/credit-packages', async (_req, res) => {
    sendJson(res, 200, { packages: await wallet.packages() });
  });

  router.post('/v1/purchases/checkout', requireAuth, checkout, body({ packageId: { type: 'string', required: true, uuid: true } }), async (req, res) => {
    sendJson(res, 201, await stripe.createCheckout(req.user, req.body.packageId));
  });

  return { limits: [read, checkout] };
}

module.exports = { accountRoutes };
