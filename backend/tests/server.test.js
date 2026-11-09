'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signToken, json } = require('./helpers');
const { createLogger, redact } = require('../src/lib/logger');
const { check } = require('../src/middleware/validation');
const { rateLimit } = require('../src/middleware/rate-limit');

test.describe('Server-Grundlagen', () => {
  let app;
  test.before(async () => {
    app = await startApp({ handlers: { supabaseRpc: () => json(200, null) } });
  });
  test.after(() => app.close());

  test('Health zeigt nur, was eingerichtet ist (keine Werte)', async () => {
    const r = await app.call('GET', '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.configured, { supabase: true, google: true, openai: true, stripe: true });
    assert.ok(!/sk-|whsec|GOCSPX|sb_secret/.test(r.text));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('x-request-id'));
  });

  test('404, 405, ungültiges JSON, falscher Content-Type, zu grosser Body', async () => {
    assert.equal((await app.call('GET', '/gibts-nicht')).status, 404);
    assert.equal((await app.call('DELETE', '/health')).status, 405);
    assert.equal((await app.call('POST', '/v1/auth/login', { raw: '{kaputt', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await app.call('POST', '/v1/auth/login', { raw: 'email=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    const big = await app.call('POST', '/v1/auth/login', { raw: JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413);
  });

  test('Interner Fehler: 500 ohne Details nach aussen, Log ohne Secrets', async () => {
    const r = await app.call('GET', '/v1/wallet', { token: signToken() });
    assert.equal(r.status, 500);
    assert.equal(r.data.error.message, 'Interner Fehler');
    assert.ok(!r.text.includes('TypeError') && !r.text.includes('available_credits'));
  });

  test('CORS nur für erlaubte Herkunft', async () => {
    const ok = await app.call('OPTIONS', '/v1/credit-packages', { headers: { origin: 'https://buddy-island.top' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://buddy-island.top');
    const evil = await app.call('OPTIONS', '/v1/credit-packages', { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });
});

test.describe('Produktivmodus', () => {
  test('ohne HTTPS (hinter Proxy) abgelehnt, HSTS gesetzt', async () => {
    const app = await startApp({ config: { production: true, trustProxy: true }, handlers: { supabaseSelect: () => json(200, []) } });
    try {
      const plain = await app.call('GET', '/health', { headers: { 'x-forwarded-proto': 'http' } });
      assert.equal(plain.status, 400);
      assert.equal(plain.data.error.code, 'https_required');
      const secure = await app.call('GET', '/health', { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(secure.status, 200);
      assert.match(secure.headers.get('strict-transport-security'), /max-age/);
    } finally { await app.close(); }
  });
});

test.describe('Bausteine', () => {
  test('Logger entfernt Secrets aus Feldern und Texten', () => {
    const lines = [];
    const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    log.info('Aufruf mit Bearer abc.def.ghi', { password: 'geheim', refreshToken: 'x', note: 'key sk-proj-ABCDEFGHIJKLMNOP und whsec_ABCDEFGHIJKL und GOCSPX-abcdefghijklmn', nested: { client_secret: 'y' } });
    const text = lines.join('\n');
    for (const s of ['geheim', 'sk-proj-ABCDEFGHIJKLMNOP', 'whsec_ABCDEFGHIJKL', 'GOCSPX-abcdefghijklmn', 'abc.def.ghi']) assert.ok(!text.includes(s), s);
    assert.equal(redact({ requestId: 'r1' }).requestId, 'r1');
  });

  test('Validierung: strikt, Typen, E-Mail, UUID', () => {
    assert.throws(() => check({ a: { type: 'string' } }, { a: 'x', b: 1 }), /Unbekannte Felder/);
    assert.throws(() => check({ a: { type: 'integer' } }, { a: 1.5 }), /ganze Zahl/);
    assert.throws(() => check({ e: { type: 'string', email: true } }, { e: 'kein-mail' }), /E-Mail/);
    assert.throws(() => check({ id: { type: 'string', uuid: true } }, { id: '1; drop table' }), /ID/);
    assert.deepEqual(check({ a: { type: 'string', required: true } }, { a: '  x ' }), { a: 'x' });
  });

  test('Rate-Limit füllt sich mit der Zeit wieder', () => {
    let t = 0;
    const rl = rateLimit({ name: 't', capacity: 2, refillPerSec: 1, key: () => 'k', now: () => t });
    const res = { setHeader: () => {} };
    rl({}, res); rl({}, res);
    assert.throws(() => rl({}, res), /Zu viele/);
    t = 1500;
    rl({}, res);
  });
});
