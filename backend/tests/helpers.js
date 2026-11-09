'use strict';
// Test-Hilfen: echter HTTP-Server mit Attrappen für Supabase, Google, OpenAI und Stripe.
// Es werden keine echten Dienste aufgerufen.

const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const SUPABASE_URL = 'https://test-project.supabase.co';
const OPENAI_BASE = 'https://api.openai.test/v1';
const STRIPE_BASE = 'https://api.stripe.test';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function testConfig(over = {}) {
  return {
    env: 'test', production: false, port: 0, publicUrl: 'http://127.0.0.1', trustProxy: false, corsOrigins: ['https://buddy-island.top'], logLevel: 'error',
    supabase: { url: SUPABASE_URL, publishableKey: 'sb_publishable_testtesttest', secretKey: 'sb_secret_testtesttesttest', jwtSecret: '' },
    google: { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'GOCSPX-testsecretvalue123' },
    openai: { apiKey: 'sk-test-openai-key-000000', baseUrl: OPENAI_BASE, maxOutputTokens: 32000, defaultOutputTokens: 4096, maxInputTokensEstimate: 250000, timeoutMs: 10000 },
    stripe: { secretKey: 'sk_test_stripekey000000', webhookSecret: 'whsec_testsecret000000', apiBase: STRIPE_BASE, successUrl: 'https://buddy-island.top/kauf/danke', cancelUrl: 'https://buddy-island.top/kauf/abgebrochen' },
    limits: { bodyBytes: 1024 * 1024 },
    ...over,
  };
}

// ---- Schlüssel und Tokens wie bei Supabase (ES256 + JWKS) ----
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };

function signToken(claims = {}, { key = privateKey, kid = KID, alg = 'ES256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, kid, typ: 'JWT' };
  const payload = { iss: `${SUPABASE_URL}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: USER_A, email: 'a@example.com', iat: now, exp: now + 3600, ...claims };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  if (alg === 'none') return `${data}.`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * Attrappe für fetch. handlers: { supabaseRpc(name, args), supabaseSelect(table, query), supabaseAuth(path, body, headers), google(form), openai(body, init), stripe(method, path, form) }
 */
function createFakeFetch(handlers = {}) {
  const calls = [];
  const fakeFetch = async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = init.body;
    calls.push({ url, method: init.method || 'GET', headers, body: typeof body === 'string' ? body : body?.toString?.() });
    if (url === `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) return json(200, { keys: [jwk] });
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
      const name = url.split('/').pop();
      return handlers.supabaseRpc ? handlers.supabaseRpc(name, JSON.parse(body || '{}'), headers) : json(404, { message: 'not found' });
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const [table, query] = url.slice(`${SUPABASE_URL}/rest/v1/`.length).split('?');
      return handlers.supabaseSelect ? handlers.supabaseSelect(table, decodeURIComponent(query || ''), init.method || 'GET', body && JSON.parse(body), headers) : json(200, []);
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) {
      return handlers.supabaseAuth ? handlers.supabaseAuth(url.slice(`${SUPABASE_URL}/auth/v1`.length), body ? JSON.parse(body) : {}, headers, init.method || 'POST') : json(500, {});
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      return handlers.google ? handlers.google(new URLSearchParams(String(body))) : json(400, { error: 'invalid_grant' });
    }
    if (url.startsWith(OPENAI_BASE)) {
      return handlers.openai ? handlers.openai(JSON.parse(body || '{}'), init, url) : json(500, {});
    }
    if (url.startsWith(STRIPE_BASE)) {
      return handlers.stripe ? handlers.stripe(init.method || 'GET', url.slice(STRIPE_BASE.length), new URLSearchParams(String(body || '')), headers) : json(500, {});
    }
    throw new Error(`Unerwarteter Aufruf: ${url}`);
  };
  return { fetch: fakeFetch, calls };
}

/** Server mit Attrappen starten */
async function startApp({ handlers = {}, config = {}, logs = [] } = {}) {
  const fake = createFakeFetch(handlers);
  const logger = {
    debug: () => {}, info: (m, f) => logs.push({ level: 'info', m, f }), warn: (m, f) => logs.push({ level: 'warn', m, f }), error: (m, f) => logs.push({ level: 'error', m, f }),
  };
  const app = createApp({ config: testConfig(config), logger, fetchImpl: fake.fetch });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const call = async (method, path, { body, token, headers = {}, raw } = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers, text };
  };
  return { base, call, calls: fake.calls, logs, app, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

module.exports = { startApp, signToken, testConfig, json, createFakeFetch, SUPABASE_URL, OPENAI_BASE, STRIPE_BASE, USER_A, USER_B, privateKey };
