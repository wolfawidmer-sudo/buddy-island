'use strict';
// Baut die Anwendung aus Konfiguration und Diensten zusammen (ohne zu lauschen),
// damit Tests sie mit Attrappen für Supabase, Google, OpenAI und Stripe starten können.

const { createRouter, createHandler, sendJson } = require('./lib/http');
const { readiness } = require('./config');
const { createTokenVerifier, requireAuth } = require('./middleware/authentication');
const { createSupabase } = require('./services/supabase');
const { createAuthService } = require('./services/authentication');
const { createWalletService } = require('./services/wallet');
const { createBillingService } = require('./services/billing');
const { createOpenAiGateway } = require('./services/openai');
const { createStripeService } = require('./services/stripe');
const { authRoutes } = require('./routes/auth');
const { accountRoutes } = require('./routes/account');
const { cloudRoutes } = require('./routes/cloud');
const { webhookRoutes } = require('./routes/webhooks');

/**
 * @param {{ config: any, logger: any, fetchImpl?: typeof fetch, now?: () => number }} opts
 */
function createApp({ config, logger, fetchImpl = globalThis.fetch, now = Date.now }) {
  const router = createRouter();
  const supabase = createSupabase({ ...config.supabase, fetchImpl, logger });
  const verifier = createTokenVerifier({ supabaseUrl: config.supabase.url, jwtSecret: config.supabase.jwtSecret, fetchImpl, now });
  const auth = createAuthService({ supabase, google: config.google, fetchImpl, logger, now });
  const wallet = createWalletService({ supabase });
  const billing = createBillingService({ supabase, logger, now });
  const gateway = createOpenAiGateway({ config, billing, logger, fetchImpl });
  const stripe = createStripeService({ config, supabase, logger, fetchImpl });
  const authMw = requireAuth(verifier);

  router.get('/health', async (_req, res) => {
    // Nur ob etwas eingerichtet ist, nie Werte
    sendJson(res, 200, { ok: true, service: 'buddy-island-backend', configured: readiness(config) });
  });

  const limits = [
    ...authRoutes({ router, auth, requireAuth: authMw }).limits,
    ...accountRoutes({ router, wallet, stripe, requireAuth: authMw }).limits,
    ...cloudRoutes({ router, gateway, billing, requireAuth: authMw }).limits,
  ];
  webhookRoutes({ router, stripe, logger });

  const handler = createHandler({ router, config, logger });
  return { handler, services: { supabase, auth, wallet, billing, gateway, stripe, verifier }, resetLimits: () => limits.forEach((l) => l.reset()) };
}

module.exports = { createApp };
