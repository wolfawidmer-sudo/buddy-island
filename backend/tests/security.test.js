'use strict';
// Sicherheitsregeln (claude/sicherheitsregeln.md im Projekt): Client-IP, Prototype Pollution,
// Passwortlänge in Bytes, Unicode-Normalisierung, JWT-Schlüsseltyp.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { clientIp } = require('../src/lib/http');
const { check } = require('../src/middleware/validation');
const { normalizeEmail } = require('../src/services/welcome');
const { createTokenVerifier } = require('../src/middleware/authentication');

const fakeReq = (headers, remoteAddress = '10.0.0.5') => ({ headers, socket: { remoteAddress } });

test('clientIp: ohne TRUST_PROXY zählt nur die Socket-Adresse', () => {
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '1.2.3.4' }), false), '10.0.0.5');
});

test('clientIp: hinter dem Proxy erster gültiger Eintrag', () => {
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '203.0.113.7, 100.64.0.1' }), true), '203.0.113.7');
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '2001:db8::1' }), true), '2001:db8::1');
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': '::ffff:198.51.100.2' }), true), '198.51.100.2');
});

test('clientIp: kein gültiges Format → X-Real-IP, sonst Socket', () => {
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': 'hallo welt', 'x-real-ip': '198.51.100.9' }), true), '198.51.100.9');
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': 'x'.repeat(500) }), true), '10.0.0.5');
  assert.equal(clientIp(fakeReq({}), true), '10.0.0.5');
});

test('Validierung: __proto__/constructor zählen nicht als bekannte Felder', () => {
  const schema = { name: { type: 'string' } };
  assert.throws(() => check(schema, JSON.parse('{"name":"a","constructor":{"x":1}}')), /Unbekannte Felder: constructor/);
  assert.throws(() => check(schema, JSON.parse('{"name":"a","__proto__":{"admin":true}}')), /Unbekannte Felder: __proto__/);
  assert.equal(/** @type {any} */ ({}).admin, undefined);
});

test('Validierung: maxBytes zählt UTF-8-Bytes, nicht Zeichen', () => {
  const schema = { p: { type: 'string', maxBytes: 72, trim: false } };
  assert.doesNotThrow(() => check(schema, { p: 'a'.repeat(72) }));
  assert.throws(() => check(schema, { p: 'ä'.repeat(37) }), /höchstens 72 Bytes/); // 37 Zeichen, 74 Bytes
});

test('Startguthaben: Vollbreiten-Zeichen ergeben dieselbe E-Mail', () => {
  assert.equal(normalizeEmail('ＡＢＣ@gmail.com'), normalizeEmail('abc@gmail.com'));
  assert.equal(normalizeEmail('A.B+x@GoogleMail.com'), 'ab@gmail.com');
});

test('JWT: RS256-Header mit EC-Schlüssel (ohne alg im JWK) wird abgelehnt', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' }; // bewusst ohne «alg»
  const fetchImpl = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const v = createTokenVerifier({ supabaseUrl: 'https://x.supabase.co', fetchImpl: /** @type {any} */ (fetchImpl) });
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = enc({ sub: '00000000-0000-4000-8000-000000000000', exp: Math.floor(Date.now() / 1000) + 60, iss: 'https://x.supabase.co/auth/v1', aud: 'authenticated', role: 'authenticated' });
  const sign = (alg) => {
    const data = `${enc({ alg, kid: 'k1' })}.${payload}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${data}.${sig}`;
  };
  assert.ok(await v.verify(sign('ES256')));
  await assert.rejects(v.verify(sign('RS256')), /Ungültige Anmeldung/);
});
