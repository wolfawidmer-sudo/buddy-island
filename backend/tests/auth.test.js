'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, signToken, json, USER_A, USER_B } = require('./helpers');

const walletRow = { available_credits: '12.500000', reserved_credits: '0.000000', lifetime_purchased: '20.000000', lifetime_consumed: '7.500000', updated_at: '2026-11-09T08:00:00Z' };
const session = (over = {}) => ({ access_token: 'eyJaccess.token.value', refresh_token: 'refresh-token-value-1', expires_in: 3600, expires_at: 1900000000, user: { id: USER_A, email: 'a@example.com', app_metadata: { provider: 'email' } }, ...over });

test.describe('Authentifizierungs-Middleware', () => {
  let app;
  const seen = [];
  test.before(async () => {
    app = await startApp({
      handlers: {
        supabaseRpc: (name, args) => { seen.push({ name, args }); return json(200, walletRow); },
        supabaseSelect: (table, query) => { seen.push({ table, query }); return json(200, [{ id: USER_A, display_name: 'A', avatar_url: null, created_at: 'x' }]); },
      },
    });
  });
  test.after(() => app.close());

  test('ohne Token → 401', async () => {
    const r = await app.call('GET', '/v1/me');
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'unauthorized');
  });

  test('gültiges Token → Profil und Guthaben, Nutzer-ID nur aus dem Token', async () => {
    seen.length = 0;
    const r = await app.call('GET', `/v1/me?user_id=${USER_B}`, { token: signToken() });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.id, USER_A);
    assert.equal(r.data.wallet.available, '12.500000');
    assert.ok(seen.every((s) => !JSON.stringify(s).includes(USER_B)));
    assert.ok(seen.some((s) => s.args?.p_user_id === USER_A));
  });

  test('falsche Signatur → 401', async () => {
    const { privateKey: other } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const r = await app.call('GET', '/v1/me', { token: signToken({}, { key: other }) });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'invalid_token');
  });

  test('abgelaufenes Token → 401 token_expired', async () => {
    const r = await app.call('GET', '/v1/me', { token: signToken({ exp: Math.floor(Date.now() / 1000) - 60 }) });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'token_expired');
  });

  test('alg none, fremder Aussteller, falsche Rolle, unbekannter Schlüssel → 401', async () => {
    for (const token of [
      signToken({}, { alg: 'none' }),
      signToken({ iss: 'https://evil.supabase.co/auth/v1' }),
      signToken({ role: 'service_role' }),
      signToken({ aud: 'other' }),
      signToken({}, { kid: 'unknown' }),
      signToken({ sub: 'not-a-uuid' }),
      'abc.def',
    ]) {
      const r = await app.call('GET', '/v1/wallet', { token });
      assert.equal(r.status, 401, token);
    }
  });

  test('HS256 ohne konfiguriertes Secret wird abgelehnt (kein Algorithmus-Wechsel)', async () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iss: 'https://test-project.supabase.co/auth/v1', aud: 'authenticated', role: 'authenticated', sub: USER_A, exp: Math.floor(Date.now() / 1000) + 600 })}`;
    const sig = crypto.createHmac('sha256', 'guess').update(data).digest('base64url');
    const r = await app.call('GET', '/v1/wallet', { token: `${data}.${sig}` });
    assert.equal(r.status, 401);
  });
});

test.describe('E-Mail-Anmeldung', () => {
  let app;
  const authCalls = [];
  test.before(async () => {
    app = await startApp({
      handlers: {
        supabaseAuth: (path, body, headers, method) => {
          authCalls.push({ path, body, headers, method });
          if (path === '/signup') return body.email === 'taken@example.com' ? json(422, { error_code: 'user_already_exists', msg: 'User already registered' }) : json(200, { id: USER_A, email: body.email });
          if (path === '/token?grant_type=password') return body.password === 'richtig-123' ? json(200, session()) : json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          if (path === '/token?grant_type=refresh_token') return body.refresh_token === 'refresh-token-value-1' ? json(200, session({ refresh_token: 'refresh-token-value-2' })) : json(400, { error_code: 'refresh_token_not_found' });
          if (path === '/verify') return body.token === '123456' ? json(200, session()) : json(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
          if (path === '/recover') return json(200, {});
          if (path === '/user') return json(200, { id: USER_A });
          if (path === '/resend') return json(200, {});
          if (path.startsWith('/logout')) return new Response(null, { status: 204 });
          return json(404, {});
        },
      },
    });
  });
  test.after(() => app.close());
  test.beforeEach(() => app.app.resetLimits());

  test('Registrierung mit Bestätigung → 202, ohne Sitzung', async () => {
    const r = await app.call('POST', '/v1/auth/signup', { body: { email: 'neu@example.com', password: 'langes-passwort', displayName: 'Neu' } });
    assert.equal(r.status, 202);
    assert.equal(r.data.confirmationRequired, true);
    assert.equal(authCalls.at(-1).body.data.full_name, 'Neu');
    assert.equal(authCalls.at(-1).headers.apikey, 'sb_publishable_testtesttest');
  });

  test('Registrierung: vorhandenes Konto → 409, zu kurzes Passwort → 400', async () => {
    assert.equal((await app.call('POST', '/v1/auth/signup', { body: { email: 'taken@example.com', password: 'langes-passwort' } })).status, 409);
    const short = await app.call('POST', '/v1/auth/signup', { body: { email: 'x@example.com', password: 'kurz' } });
    assert.equal(short.status, 400);
  });

  test('Anmeldung → Sitzung; falsches Passwort → 401', async () => {
    const ok = await app.call('POST', '/v1/auth/login', { body: { email: 'a@example.com', password: 'richtig-123' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.session.refreshToken, 'refresh-token-value-1');
    assert.equal(ok.data.session.user.id, USER_A);
    const bad = await app.call('POST', '/v1/auth/login', { body: { email: 'a@example.com', password: 'falsch-123' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error.code, 'invalid_credentials');
  });

  test('Sitzung erneuern; ungültiger Refresh-Token → 401 session_expired', async () => {
    const ok = await app.call('POST', '/v1/auth/refresh', { body: { refreshToken: 'refresh-token-value-1' } });
    assert.equal(ok.data.session.refreshToken, 'refresh-token-value-2');
    const bad = await app.call('POST', '/v1/auth/refresh', { body: { refreshToken: 'refresh-token-unknown' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error.code, 'session_expired');
  });

  test('E-Mail bestätigen mit Code', async () => {
    assert.equal((await app.call('POST', '/v1/auth/verify-email', { body: { email: 'a@example.com', code: '123456' } })).status, 200);
    const bad = await app.call('POST', '/v1/auth/verify-email', { body: { email: 'a@example.com', code: '000000' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'invalid_code');
  });

  test('Passwort-Reset: Anfrage verrät nichts, Bestätigung setzt neues Passwort', async () => {
    const r = await app.call('POST', '/v1/auth/password-reset', { body: { email: 'gibts-nicht@example.com' } });
    assert.equal(r.status, 202);
    const c = await app.call('POST', '/v1/auth/password-reset/confirm', { body: { email: 'a@example.com', code: '123456', password: 'neues-passwort-1' } });
    assert.equal(c.status, 200);
    const put = authCalls.find((x) => x.path === '/user');
    assert.equal(put.method, 'PUT');
    assert.equal(put.body.password, 'neues-passwort-1');
    assert.match(put.headers.authorization, /^Bearer eyJ/);
  });

  test('Abmelden braucht Token', async () => {
    assert.equal((await app.call('POST', '/v1/auth/logout')).status, 401);
    assert.equal((await app.call('POST', '/v1/auth/logout', { token: signToken() })).status, 200);
  });

  test('Rate-Limit: nach 10 Versuchen 429 mit Retry-After', async () => {
    let last;
    for (let i = 0; i < 11; i += 1) last = await app.call('POST', '/v1/auth/login', { body: { email: 'a@example.com', password: 'falsch-123' } });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });
});

test.describe('Google-Anmeldung (Desktop-Client, PKCE, Backend-Code-Tausch)', () => {
  let app;
  const googleCalls = [];
  const supabaseCalls = [];
  const nonce = crypto.randomBytes(32).toString('base64url');
  const hashed = crypto.createHash('sha256').update(nonce).digest('hex');
  const idToken = (claims) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'test-client.apps.googleusercontent.com', sub: '123', email: 'g@example.com', email_verified: true, nonce: hashed, ...claims })).toString('base64url')}.sig`;
  let nextIdToken = idToken({});

  test.before(async () => {
    app = await startApp({
      handlers: {
        google: (form) => { googleCalls.push(Object.fromEntries(form)); return form.get('code') === 'bad-code-0000' ? json(400, { error: 'invalid_grant' }) : json(200, { id_token: nextIdToken, access_token: 'ya29.google-access' }); },
        supabaseAuth: (path, body) => { supabaseCalls.push({ path, body }); return json(200, session({ user: { id: USER_A, email: 'g@example.com', app_metadata: { provider: 'google' } } })); },
      },
    });
  });
  test.after(() => app.close());
  test.beforeEach(() => { app.app.resetLimits(); nextIdToken = idToken({}); });

  const req = (over = {}) => ({ code: `4/0AX-code-${crypto.randomBytes(6).toString('hex')}`, codeVerifier: crypto.randomBytes(40).toString('base64url'), redirectUri: 'http://127.0.0.1:53682/callback', nonce, ...over });

  test('Konfiguration gibt nur die öffentliche Client-ID, nie das Secret', async () => {
    const r = await app.call('GET', '/v1/auth/google/config');
    assert.equal(r.data.clientId, 'test-client.apps.googleusercontent.com');
    assert.ok(!r.text.includes('GOCSPX'));
  });

  test('Erfolg: Code-Tausch mit PKCE und Secret bei Google, Roh-nonce an Supabase', async () => {
    const body = req();
    const r = await app.call('POST', '/v1/auth/google', { body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.session.user.provider, 'google');
    const g = googleCalls.at(-1);
    assert.equal(g.code_verifier, body.codeVerifier);
    assert.equal(g.redirect_uri, body.redirectUri);
    assert.equal(g.client_secret, 'GOCSPX-testsecretvalue123');
    const s = supabaseCalls.at(-1);
    assert.equal(s.path, '/token?grant_type=id_token');
    assert.equal(s.body.provider, 'google');
    assert.equal(s.body.nonce, nonce);
    assert.ok(!r.text.includes('GOCSPX') && !r.text.includes('ya29'));
  });

  test('Rückkehr-Adresse muss Loopback 127.0.0.1 mit /callback sein', async () => {
    for (const redirectUri of ['http://localhost:53682/callback', 'https://evil.example/callback', 'http://127.0.0.1:80/callback', 'http://127.0.0.1:53682/other', 'buddy://callback']) {
      const r = await app.call('POST', '/v1/auth/google', { body: req({ redirectUri }) });
      assert.equal(r.status, 400, redirectUri);
    }
  });

  test('Wiederholter Code wird abgelehnt (Replay)', async () => {
    const body = req();
    assert.equal((await app.call('POST', '/v1/auth/google', { body })).status, 200);
    const again = await app.call('POST', '/v1/auth/google', { body });
    assert.equal(again.status, 401);
    assert.equal(again.data.error.code, 'code_replayed');
  });

  test('Falsche nonce, fremde Audience oder unbestätigte E-Mail → abgelehnt, keine Supabase-Sitzung', async () => {
    const before = supabaseCalls.length;
    nextIdToken = idToken({ nonce: 'anders' });
    assert.equal((await app.call('POST', '/v1/auth/google', { body: req() })).status, 401);
    nextIdToken = idToken({ aud: 'other-client' });
    assert.equal((await app.call('POST', '/v1/auth/google', { body: req() })).status, 401);
    nextIdToken = idToken({ email_verified: false });
    assert.equal((await app.call('POST', '/v1/auth/google', { body: req() })).status, 401);
    assert.equal(supabaseCalls.length, before);
  });

  test('Google lehnt Code ab → 401, kurzer PKCE-Verifier → 400', async () => {
    assert.equal((await app.call('POST', '/v1/auth/google', { body: req({ code: 'bad-code-0000' }) })).status, 401);
    assert.equal((await app.call('POST', '/v1/auth/google', { body: req({ codeVerifier: 'kurz' }) })).status, 400);
  });

  test('Fehlermeldungen und Logs enthalten keine Codes oder Secrets', async () => {
    await app.call('POST', '/v1/auth/google', { body: req({ code: 'bad-code-0000' }) });
    const text = JSON.stringify(app.logs);
    assert.ok(!text.includes('GOCSPX'));
    assert.ok(!text.includes('bad-code-0000'));
  });
});
