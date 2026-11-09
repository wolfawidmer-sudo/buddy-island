// Tests für Buddy Cloud in der App: Google-Anmeldung (Loopback, PKCE, state, nonce),
// Sitzung (speichern, wiederherstellen, erneuern, Ablauf, offline), Anbieter «Buddy Cloud».
// Alles mit Attrappen, keine echten Dienste.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { authorize } = require('../src/cloud/google-oauth');
const { createCloudAccount } = require('../src/cloud/account');
const cloudConfig = require('../src/cloud/config');
const models = require('../src/models');
const { createOpenAiResponsesClient } = require('../src/llm/openai-responses');

const get = (url) => new Promise((resolve) => {
  http.get(url, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', () => resolve({ status: 0, body: '' }));
});

async function testGoogle() {
  // Erfolg: richtige Parameter, falscher state wird ignoriert, nur EIN Rückruf zählt
  let opened = '';
  const flow = authorize({ clientId: 'abc.apps.googleusercontent.com', openExternal: (u) => { opened = u; } });
  while (!opened) await new Promise((r) => setTimeout(r, 5));
  const u = new URL(opened);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = u.searchParams;
  assert.equal(p.get('client_id'), 'abc.apps.googleusercontent.com');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('response_type'), 'code');
  assert.match(p.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok(p.get('state').length >= 43);
  assert.match(p.get('nonce'), /^[0-9a-f]{64}$/);
  assert.equal(p.get('client_secret'), null);
  const cb = p.get('redirect_uri');

  assert.equal((await get(`${cb.replace('/callback', '/other')}?code=x&state=${p.get('state')}`)).status, 404);
  assert.equal((await get(`${cb}?code=evil&state=falsch`)).status, 400);
  const ok = await get(`${cb}?code=4/0good-code&state=${encodeURIComponent(p.get('state'))}`);
  assert.equal(ok.status, 200);
  assert.ok(!ok.body.includes('4/0good-code'));
  const result = await flow;
  assert.equal(result.code, '4/0good-code');
  assert.equal(result.redirectUri, cb);
  // PKCE und nonce passen zusammen
  assert.equal(crypto.createHash('sha256').update(result.codeVerifier).digest('base64url'), p.get('code_challenge'));
  assert.equal(crypto.createHash('sha256').update(result.nonce).digest('hex'), p.get('nonce'));
  assert.ok(result.codeVerifier.length >= 43 && result.codeVerifier.length <= 128);
  // Danach ist der Server zu (kein zweiter Rückruf, kein Replay)
  assert.equal((await get(`${cb}?code=again&state=${encodeURIComponent(p.get('state'))}`)).status, 0);

  // Nutzer bricht bei Google ab
  opened = '';
  const denied = assert.rejects(authorize({ clientId: 'abc.apps.googleusercontent.com', openExternal: (x) => { opened = x; } }), /google_cancelled/);
  while (!opened) await new Promise((r) => setTimeout(r, 5));
  const p2 = new URL(opened).searchParams;
  await get(`${p2.get('redirect_uri')}?error=access_denied&state=${encodeURIComponent(p2.get('state'))}`);
  await denied;

  // Zeitlimit und Abbruch aus der App
  await assert.rejects(authorize({ clientId: 'abc.apps.googleusercontent.com', openExternal: () => {}, timeoutMs: 50 }), /google_timeout/);
  const ac = new AbortController();
  const aborted = authorize({ clientId: 'abc.apps.googleusercontent.com', openExternal: () => {}, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(aborted, /google_cancelled/);
  // Ungültige Client-ID
  await assert.rejects(authorize({ clientId: '', openExternal: () => {} }), /google_not_configured/);
}

function fakeBackend(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace('https://api.test', '');
    calls.push({ path, method: init.method, auth: init.headers?.authorization || null, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${init.method || 'GET'} ${path.split('?')[0]}`];
    if (handler === 'offline') throw new TypeError('fetch failed');
    if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), { status: 404 });
    const [status, body] = await handler(calls.at(-1));
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

const sessionFor = (n, expiresAt) => ({ accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt, user: { id: 'u1', email: 'a@example.com', provider: 'email' } });

async function testAccount() {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const me = [200, { profile: { displayName: 'Anna' }, wallet: { available: '12.500000', reserved: '0.000000', lifetimeConsumed: '1.000000' } }];

  // Anmelden: Sitzung verschlüsselt gespeichert (über storage), Oberfläche sieht keine Tokens
  let stored = null;
  const storage = { load: () => stored, save: (s) => { stored = s; } };
  const b1 = fakeBackend({
    'POST /v1/auth/login': () => [200, { session: sessionFor(1, nowSec() + 3600) }],
    'GET /v1/me': () => me,
  });
  const states = [];
  const acc = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b1.fetchImpl, storage, openExternal: () => {}, onChange: (s) => states.push(s) });
  const st = await acc.login({ email: 'a@example.com', password: 'x' });
  assert.equal(st.signedIn, true);
  assert.equal(st.wallet.available, '12.500000');
  assert.equal(stored.refreshToken, 'refresh-1');
  assert.equal(acc.accessToken(), 'access-1');
  for (const s of [st, ...states]) assert.ok(!JSON.stringify(s).includes('access-1') && !JSON.stringify(s).includes('refresh-1'));
  assert.equal(b1.calls.find((c) => c.path === '/v1/me').auth, 'Bearer access-1');

  // Neustart: gespeicherte Sitzung wird wiederhergestellt
  const acc2 = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b1.fetchImpl, storage, openExternal: () => {} });
  await acc2.restore();
  assert.equal(acc2.publicState().signedIn, true);
  assert.equal(acc2.publicState().displayName, 'Anna');

  // Bald abgelaufen: genau EINE Erneuerung, auch bei mehreren gleichzeitigen Anfragen
  stored = sessionFor(2, nowSec() + 30);
  let refreshes = 0;
  const b2 = fakeBackend({
    'POST /v1/auth/refresh': async (c) => { refreshes += 1; assert.equal(c.body.refreshToken, 'refresh-2'); await new Promise((r) => setTimeout(r, 20)); return [200, { session: sessionFor(3, nowSec() + 3600) }]; },
    'GET /v1/me': () => me,
    'GET /v1/wallet': () => [200, { wallet: me[1].wallet }],
  });
  const acc3 = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b2.fetchImpl, storage, openExternal: () => {} });
  await acc3.restore();
  await Promise.all([acc3.ensureFresh(), acc3.ensureFresh(), acc3.refreshWallet()]);
  assert.equal(refreshes, 1);
  assert.equal(acc3.accessToken(), 'access-3');
  assert.equal(stored.refreshToken, 'refresh-3');

  // Refresh-Token abgelaufen: Sitzung weg, klare Meldung, gespeicherte Sitzung gelöscht
  stored = sessionFor(4, nowSec() + 10);
  const b3 = fakeBackend({ 'POST /v1/auth/refresh': () => [401, { error: { code: 'session_expired', message: 'abgelaufen' } }], 'GET /v1/me': () => me });
  const acc4 = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b3.fetchImpl, storage, openExternal: () => {} });
  await acc4.restore();
  assert.equal(acc4.publicState().signedIn, false);
  assert.equal(acc4.publicState().status, 'expired');
  assert.match(acc4.publicState().error, /abgelaufen/);
  assert.equal(stored, null);
  assert.equal(acc4.accessToken(), null);

  // Backend offline beim Start: Sitzung bleibt, Status «offline», nichts wirft
  stored = sessionFor(5, nowSec() + 3600);
  const b4 = fakeBackend({ 'GET /v1/me': 'offline', 'GET /v1/usage': 'offline', 'GET /v1/purchases': 'offline', 'GET /v1/wallet/transactions': 'offline' });
  const acc5 = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b4.fetchImpl, storage, openExternal: () => {} });
  await acc5.restore();
  assert.equal(acc5.publicState().status, 'offline');
  assert.equal(acc5.publicState().signedIn, true);
  assert.equal(stored.accessToken, 'access-5');
  await assert.rejects(acc5.history(), (e) => e.code === 'offline' && /Lokale KI/.test(e.message));

  // 401 bei einer Anfrage: einmal erneuern, dann nochmals versuchen
  stored = sessionFor(6, nowSec() + 3600);
  let meCalls = 0;
  const b5 = fakeBackend({
    'GET /v1/me': (c) => { meCalls += 1; return c.auth === 'Bearer access-7' ? me : [401, { error: { code: 'invalid_token', message: 'x' } }]; },
    'POST /v1/auth/refresh': () => [200, { session: sessionFor(7, nowSec() + 3600) }],
  });
  const acc6 = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b5.fetchImpl, storage, openExternal: () => {} });
  await acc6.restore();
  assert.equal(meCalls, 2);
  assert.equal(acc6.accessToken(), 'access-7');

  // Kauf: nur Stripe-Checkout wird geöffnet; Abmelden klappt auch offline
  let openedUrl = '';
  const b6 = fakeBackend({
    'POST /v1/purchases/checkout': () => [201, { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1', amountChf: '10.00', credits: '1000.000000' }],
    'POST /v1/auth/logout': 'offline',
  });
  const acc7 = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b6.fetchImpl, storage, openExternal: (u) => { openedUrl = u; } });
  stored = sessionFor(8, nowSec() + 3600);
  await acc7.restore().catch(() => {});
  const bought = await acc7.buy('44444444-4444-4444-8444-444444444444');
  assert.equal(openedUrl, 'https://checkout.stripe.com/c/pay/cs_1');
  assert.equal(bought.credits, '1000.000000');
  const b7 = fakeBackend({ 'POST /v1/purchases/checkout': () => [201, { checkoutUrl: 'https://evil.example/pay' }] });
  const acc8 = createCloudAccount({ apiUrl: () => 'https://api.test', fetchImpl: b7.fetchImpl, storage, openExternal: () => { throw new Error('darf nicht öffnen'); } });
  await acc8.restore().catch(() => {});
  await assert.rejects(acc8.buy('x'), (e) => e.code === 'bad_checkout');
  await acc7.logout();
  assert.equal(acc7.publicState().signedIn, false);
  assert.equal(stored, null);

  // Nicht eingerichtet (keine Backend-Adresse): klare Meldung, kein Netzwerk
  const acc9 = createCloudAccount({ apiUrl: () => '', fetchImpl: () => { throw new Error('kein Netz erwartet'); }, storage: { load: () => null, save: () => {} }, openExternal: () => {} });
  assert.equal(acc9.configured(), false);
  await assert.rejects(acc9.login({ email: 'a', password: 'b' }), (e) => e.code === 'not_configured');
}

async function testProvider() {
  // Adresse: nur https oder lokale Entwicklung
  assert.equal(cloudConfig.clean('https://api.buddy-island.top/'), 'https://api.buddy-island.top');
  assert.equal(cloudConfig.clean('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(cloudConfig.clean('http://api.buddy-island.top'), '');
  assert.equal(cloudConfig.clean('javascript:alert(1)'), '');

  // Modelle: eigener Anbieter, keine Verwechslung mit eigenem OpenAI-Key
  assert.equal(models.providerOf('cloud:gpt-6-luna'), 'buddy');
  assert.equal(models.providerOf('gpt-6-luna'), 'openai');
  const i = models.info('cloud:gpt-6.1-sol');
  assert.equal(i.tier, 'opus');
  assert.equal(i.caps.tools, true);
  assert.equal(i.caps.vision, true);
  assert.equal(models.costOf('cloud:gpt-6.1-sol', { input_tokens: 1e6, output_tokens: 1e6 }), 0); // abgerechnet wird auf dem Server
  assert.deepEqual(models.resolveTiers(['cloud:gpt-6-luna', 'cloud:gpt-6.1-terra', 'cloud:gpt-6.1-sol', 'gpt-6-luna'], 'buddy'), { haiku: 'cloud:gpt-6-luna', sonnet: 'cloud:gpt-6.1-terra', opus: 'cloud:gpt-6.1-sol' });

  // Adapter: gleicher OpenAI-Adapter, Präfix wird vor dem Senden entfernt, Token als Bearer
  process.env.BUDDY_CLOUD_URL = 'http://127.0.0.1:9';
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    sent.push({ url, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-6-luna' }] }), { status: 200 });
    if (sent.at(-1).body?.input?.[0]?.content?.[0]?.text === 'arm') {
      return new Response(JSON.stringify({ error: { message: 'Nicht genug Buddy Credits.', code: 'insufficient_credits' } }), { status: 402 });
    }
    return new Response(JSON.stringify({ id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hallo' }] }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  };
  const client = createOpenAiResponsesClient({ provider: models.PROVIDERS.buddy, fetchImpl });
  const list = await client.listModels('access-token');
  assert.deepEqual(list.map((m) => m.id), ['cloud:gpt-6-luna']);
  assert.equal(sent[0].url, 'http://127.0.0.1:9/v1/cloud/models');
  const res = await client.streamMessage({ apiKey: 'access-token', model: 'cloud:gpt-6-luna', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 100, stream: false });
  assert.equal(sent[1].url, 'http://127.0.0.1:9/v1/cloud/responses');
  assert.equal(sent[1].body.model, 'gpt-6-luna');
  assert.equal(sent[1].auth, 'Bearer access-token');
  assert.equal(res.content.find((b) => b.type === 'text').text, 'Hallo');
  // Zu wenig Guthaben: verständliche Meldung, kein «API-Key abgelehnt»
  await assert.rejects(
    client.streamMessage({ apiKey: 'access-token', model: 'cloud:gpt-6-luna', messages: [{ role: 'user', content: 'arm' }], maxTokens: 100, stream: false }),
    (e) => /Buddy Credits/.test(e.message) && e.category === 'quota',
  );
  delete process.env.BUDDY_CLOUD_URL;
  // Ohne Adresse: Modell-Liste meldet «nicht eingerichtet», statt irgendwohin zu senden
  await assert.rejects(client.listModels('x'), (e) => e.category !== 'auth');

  // Lokale KI bleibt unberührt
  assert.equal(models.providerOf('local:qwen3.5:4b'), 'local');
  assert.equal(models.PROVIDERS.local.needsKey, false);
}

(async () => {
  await testGoogle();
  await testAccount();
  await testProvider();
  console.log('Cloud-Tests ok (Google-Loopback mit PKCE/state/nonce, Sitzung speichern/erneuern/ablaufen/offline, Kauf, Anbieter Buddy Cloud, lokale KI unberührt)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
