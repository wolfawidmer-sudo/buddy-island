'use strict';
// Stripe-Webhook. Roh-Body (für die Signatur), keine Anmeldung, aber Signaturpflicht.

const { sendJson } = require('../lib/http');

/** @param {{ router: any, stripe: any, logger: any }} deps */
function webhookRoutes({ router, stripe, logger }) {
  router.post('/webhooks/stripe', { raw: true }, async (req, res) => {
    const event = stripe.verify(req.rawBody || Buffer.alloc(0), String(req.headers['stripe-signature'] || ''));
    const result = await stripe.handleEvent(event);
    logger.info('stripe_event', { eventId: event.id, eventType: event.type, result });
    sendJson(res, 200, { received: true });
  });
}

module.exports = { webhookRoutes };
