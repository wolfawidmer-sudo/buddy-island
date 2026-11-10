'use strict';
// Startguthaben: einmal pro Konto, E-Mail und PC; nur HMAC-Werte an die Datenbank
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signToken, json, USER_A, USER_B } = require('./helpers');
const { normalizeEmail } = require('../src/services/welcome');

const DEV1 = 'a'.repeat(64);
const DEV2 = 'b'.repeat(64);

// Nachbau der Datenbankfunktion grant_welcome_credits im Speicher
function fakeDb() {
  const grants = [];
  const calls = [];
  return {
    grants, calls,
    handlers: {
      supabaseRpc: (name, a) => {
        calls.push({ name, a });
        if (name === 'get_wallet') return json(200, { available_credits: '50.000000', subscription_credits: '0', reserved_credits: '0', lifetime_purchased: '0', lifetime_consumed: '0', updated_at: null });
        if (name !== 'grant_welcome_credits') return json(404, {});
        const found = (k, v) => grants.some((g) => g[k] === v);
        if (found('user', a.p_user_id)) return json(200, { granted: false, reason: 'account' });
        if (found('email', a.p_email_hash)) return json(200, { granted: false, reason: 'email' });
        if (found('device', a.p_device_hash)) return json(200, { granted: false, reason: 'device' });
        if (grants.filter((g) => g.ip === a.p_ip_hash).length >= a.p_ip_daily_limit) return json(200, { granted: false, reason: 'ip' });
        grants.push({ user: a.p_user_id, email: a.p_email_hash, device: a.p_device_hash, ip: a.p_ip_hash });
        return json(200, { granted: true, reason: 'granted', amount: a.p_amount });
      },
    },
  };
}

test('E-Mail wird vergleichbar gemacht', () => {
  assert.equal(normalizeEmail(' A.B+buddy@GMail.com '), 'ab@gmail.com');
  assert.equal(normalizeEmail('a.b@googlemail.com'), 'ab@gmail.com');
  assert.equal(normalizeEmail('a.b+x@example.com'), 'a.b@example.com', 'Punkte nur bei Gmail weg');
});

test('Startguthaben: einmal, dann gesperrt für Konto, E-Mail-Variante und PC', async () => {
  const db = fakeDb();
  const app = await startApp({ handlers: db.handlers, config: { welcome: { credits: 50, ipDailyLimit: 3, hashSecret: 'test-secret' } } });
  try {
    const claim = (token, deviceId) => app.call('POST', '/v1/welcome-credits', { token, body: { deviceId } });
    let r = await claim(signToken({ sub: USER_A, email: 'wolf.test@gmail.com' }), DEV1);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.welcome, { granted: true, reason: 'granted', amount: '50' });
    assert.ok(r.data.wallet);

    // dasselbe Konto nochmals
    r = await claim(signToken({ sub: USER_A, email: 'wolf.test@gmail.com' }), DEV2);
    assert.equal(r.data.welcome.reason, 'account');
    // neues Konto, gleiche Gmail mit Punkt/Plus-Variante, anderer PC
    r = await claim(signToken({ sub: USER_B, email: 'wolftest+2@gmail.com' }), DEV2);
    assert.equal(r.data.welcome.reason, 'email');
    // neues Konto, neue E-Mail, gleicher PC
    r = await claim(signToken({ sub: '33333333-3333-4333-8333-333333333333', email: 'andere@example.com' }), DEV1);
    assert.equal(r.data.welcome.reason, 'device');
    assert.equal(db.grants.length, 1);

    // Datenbank bekommt nur Hashes, nie E-Mail oder PC-Kennung im Klartext
    const a = db.calls.find((c) => c.name === 'grant_welcome_credits').a;
    assert.match(a.p_email_hash, /^[a-f0-9]{64}$/);
    assert.match(a.p_device_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(a.p_device_hash, DEV1);
    assert.ok(!JSON.stringify(db.calls).includes('wolf.test'));
    assert.equal(a.p_amount, '50');
  } finally { await app.close(); }
});

test('Startguthaben: ungültige PC-Kennung, ohne Anmeldung, ausgeschaltet', async () => {
  const db = fakeDb();
  let app = await startApp({ handlers: db.handlers, config: { welcome: { credits: 50, hashSecret: 'x' } } });
  try {
    let r = await app.call('POST', '/v1/welcome-credits', { token: signToken(), body: { deviceId: 'kurz' } });
    assert.equal(r.status, 400);
    r = await app.call('POST', '/v1/welcome-credits', { body: { deviceId: DEV1 } });
    assert.equal(r.status, 401);
  } finally { await app.close(); }
  app = await startApp({ handlers: db.handlers, config: { welcome: { credits: 0 } } });
  try {
    const r = await app.call('POST', '/v1/welcome-credits', { token: signToken(), body: { deviceId: DEV1 } });
    assert.equal(r.data.welcome.reason, 'disabled');
    assert.ok(!db.calls.some((c) => c.name === 'grant_welcome_credits'));
  } finally { await app.close(); }
});
