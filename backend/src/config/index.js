'use strict';
// Konfiguration nur aus Umgebungsvariablen. Geheimnisse werden nie geloggt.

/** @param {string} name @param {string} [fallback] */
function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v.trim();
}

/** @param {string} name @param {number} fallback */
function int(name, fallback) {
  const v = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(v) ? v : fallback;
}

function load() {
  const env = str('NODE_ENV', 'development');
  const config = {
    env,
    production: env === 'production',
    port: int('PORT', 8080),
    // Öffentliche Adresse dieses Backends (für Stripe-Rückkehrseiten)
    publicUrl: str('PUBLIC_URL', `http://127.0.0.1:${int('PORT', 8080)}`),
    trustProxy: str('TRUST_PROXY', env === 'production' ? '1' : '0') === '1',
    corsOrigins: (str('CORS_ORIGINS', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: str('LOG_LEVEL', 'info'),

    supabase: {
      url: (str('SUPABASE_URL', '') || '').replace(/\/$/, ''),
      // Öffentlicher Schlüssel (sb_publishable_… oder alter anon-Key): für Auth-Endpunkte
      publishableKey: str('SUPABASE_PUBLISHABLE_KEY', str('SUPABASE_ANON_KEY', '')),
      // Geheimer Schlüssel (sb_secret_… oder alter service_role-Key): nur hier im Backend
      secretKey: str('SUPABASE_SECRET_KEY', str('SUPABASE_SERVICE_ROLE_KEY', '')),
      // Nur für alte Projekte mit HS256-Tokens; neue Projekte prüfen über JWKS
      jwtSecret: str('SUPABASE_JWT_SECRET', ''),
    },

    google: {
      // Desktop-Client («installed»). Secret bleibt hier; die App bekommt nur die Client-ID.
      clientId: str('GOOGLE_CLIENT_ID', ''),
      clientSecret: str('GOOGLE_CLIENT_SECRET', ''),
    },

    openai: {
      apiKey: str('OPENAI_API_KEY', ''),
      baseUrl: (str('OPENAI_BASE_URL', 'https://api.openai.com/v1') || '').replace(/\/$/, ''),
      maxOutputTokens: int('CLOUD_MAX_OUTPUT_TOKENS', 32000),
      defaultOutputTokens: int('CLOUD_DEFAULT_OUTPUT_TOKENS', 4096),
      // Über 272k Eingabe-Tokens rechnet OpenAI teurer ab; Buddy nimmt solche Anfragen nicht an
      maxInputTokensEstimate: int('CLOUD_MAX_INPUT_TOKENS', 250000),
      timeoutMs: int('OPENAI_TIMEOUT_MS', 600000),
    },

    // Diktat (OpenAI-Transkription). Modell muss in model_pricing mit audio_pricing stehen.
    transcribe: {
      model: str('TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe'),
      timeoutMs: int('TRANSCRIBE_TIMEOUT_MS', 30000),
    },

    stripe: {
      secretKey: str('STRIPE_SECRET_KEY', ''),
      webhookSecret: str('STRIPE_WEBHOOK_SECRET', ''),
      apiBase: (str('STRIPE_API_BASE', 'https://api.stripe.com') || '').replace(/\/$/, ''),
      successUrl: str('STRIPE_SUCCESS_URL', 'https://buddy-island.top/kauf/danke'),
      cancelUrl: str('STRIPE_CANCEL_URL', 'https://buddy-island.top/kauf/abgebrochen'),
    },

    limits: {
      bodyBytes: int('MAX_BODY_BYTES', 20 * 1024 * 1024),
    },
  };
  return config;
}

/** Was fehlt für welchen Teil? Für /health und den Start-Log (ohne Werte). */
function readiness(config) {
  return {
    supabase: Boolean(config.supabase.url && config.supabase.secretKey && config.supabase.publishableKey),
    google: Boolean(config.google.clientId && config.google.clientSecret),
    openai: Boolean(config.openai.apiKey),
    stripe: Boolean(config.stripe.secretKey && config.stripe.webhookSecret),
  };
}

module.exports = { load, readiness };
