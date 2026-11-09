'use strict';
// /v1/cloud/* – OpenAI-Gateway im Format der OpenAI-API, damit der bestehende
// Responses-Adapter der App nur die Basis-Adresse wechseln muss.

const { sendJson } = require('../lib/http');
const { AppError } = require('../lib/errors');
const { rateLimit, byUser } = require('../middleware/rate-limit');

/** @param {{ router: any, gateway: any, billing: any, requireAuth: any }} deps */
function cloudRoutes({ router, gateway, billing, requireAuth }) {
  const ai = rateLimit({ name: 'cloud', capacity: 20, refillPerSec: 0.5, key: byUser });

  router.get('/v1/cloud/models', requireAuth, async (_req, res) => {
    const ids = await billing.models();
    sendJson(res, 200, { object: 'list', data: ids.sort().map((id) => ({ id, object: 'model', owned_by: 'buddy-island' })) });
  });

  router.post('/v1/cloud/responses', requireAuth, ai, async (req, res) => {
    await gateway.responses(req.user, req.body, req, res);
  });

  // Vorbereitet, aber noch nicht umgesetzt: Abrechnung für Sprache braucht eigene Messung
  const notYet = (what) => async () => { throw new AppError(501, 'not_implemented', `${what} ist in Buddy Cloud noch nicht verfügbar.`); };
  router.post('/v1/cloud/audio/transcriptions', requireAuth, notYet('Spracherkennung'));
  router.post('/v1/cloud/realtime/sessions', requireAuth, notYet('Echtzeit-Sprache'));

  return { limits: [ai] };
}

module.exports = { cloudRoutes };
