'use strict';
// /v1/cloud/* – OpenAI-Gateway im Format der OpenAI-API, damit der bestehende
// Responses-Adapter der App nur die Basis-Adresse wechseln muss.

const { sendJson } = require('../lib/http');
const { AppError } = require('../lib/errors');
const { rateLimit, byUser } = require('../middleware/rate-limit');

/** @param {{ router: any, gateway: any, billing: any, requireAuth: any }} deps */
function cloudRoutes({ router, gateway, billing, transcriber, requireAuth }) {
  const ai = rateLimit({ name: 'cloud', capacity: 20, refillPerSec: 0.5, key: byUser });
  const dictation = rateLimit({ name: 'dictation', capacity: 10, refillPerSec: 0.2, key: byUser });

  router.get('/v1/cloud/models', requireAuth, async (_req, res) => {
    const ids = await billing.models();
    sendJson(res, 200, { object: 'list', data: ids.sort().map((id) => ({ id, object: 'model', owned_by: 'buddy-island' })) });
  });

  router.post('/v1/cloud/responses', requireAuth, ai, async (req, res) => {
    await gateway.responses(req.user, req.body, req, res);
  });

  // Diktat: { audio: Base64-WAV (16 kHz, 16 Bit, mono, max. 30 s), language?: 'de' } → { text, seconds, creditsCharged }
  router.post('/v1/cloud/audio/transcriptions', requireAuth, dictation, async (req, res) => {
    sendJson(res, 200, await transcriber.transcribe(req.user, req.body));
  });

  // Vorbereitet, aber noch nicht umgesetzt
  const notYet = (what) => async () => { throw new AppError(501, 'not_implemented', `${what} ist in Buddy Cloud noch nicht verfügbar.`); };
  router.post('/v1/cloud/realtime/sessions', requireAuth, notYet('Echtzeit-Sprache'));

  return { limits: [ai, dictation] };
}

module.exports = { cloudRoutes };
