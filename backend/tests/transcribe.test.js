'use strict';
// Diktat (POST /v1/cloud/audio/transcriptions) mit simulierter OpenAI-Antwort. Keine echten Aufrufe.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signToken, json } = require('./helpers');
const { parseWav, transcriptionUsage } = require('../src/services/transcribe');

/** WAV wie aus der App: 16 kHz, 16 Bit, mono */
function wav(seconds, { rate = 16000, channels = 1, bits = 16 } = {}) {
  const data = Buffer.alloc(Math.round(seconds * rate) * channels * (bits / 8));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Supabase-Attrappe: Preis 1 BC je 1000 Text-Tokens + 1 BC je 100 Audio-Tokens + 1 BC je Sekunde */
function ledger({ available = 100_000000n, pricedModel = 'gpt-4o-mini-transcribe' } = {}) {
  const st = { available, reservations: new Map(), settled: [], released: [], labels: [] };
  const fmt = (v) => `${v / 1000000n}.${String(v % 1000000n).padStart(6, '0')}`;
  const parse = (s) => { const [a, b = ''] = String(s).split('.'); return BigInt(a) * 1000000n + BigInt((b + '000000').slice(0, 6)); };
  const cost = (a) => BigInt(a.p_input_tokens + a.p_output_tokens) * 1000n
    + BigInt(a.p_audio?.input_tokens || 0) * 10000n + BigInt(Math.ceil(a.p_audio?.transcription_seconds || 0)) * 1000000n;
  return {
    st,
    fmt,
    handlers: {
      supabaseSelect: (table, query, method, body) => {
        if (table === 'model_pricing') return json(200, [{ model_id: pricedModel }]);
        if (table === 'wallet_transactions' && method === 'PATCH') { st.labels.push({ query, body }); return json(200, []); }
        return json(200, []);
      },
      supabaseRpc: (name, a) => {
        if (name === 'billing_quote') return json(200, [{ provider_cost: '0', markup_amount: '0', total_cost: '0', credits: fmt(cost(a)) }]);
        if (name === 'reserve_credits') {
          const amt = parse(a.p_amount);
          if (st.available < amt) return json(400, { message: 'insufficient_credits', code: 'P0001' });
          st.available -= amt; st.reservations.set(a.p_request_id, amt);
          return json(200, [{ reservation_id: 'r1', amount: fmt(amt), available_credits: fmt(st.available), reserved_credits: '0', status: 'active' }]);
        }
        if (name === 'settle_reservation') {
          const amt = st.reservations.get(a.p_request_id) || 0n; const c = cost(a);
          st.available += amt - c; st.reservations.delete(a.p_request_id); st.settled.push(a);
          return json(200, { credits_charged: fmt(c), status: 'settled' });
        }
        if (name === 'release_reservation') {
          st.available += st.reservations.get(a.p_request_id) || 0n; st.reservations.delete(a.p_request_id); st.released.push(a);
          return json(200, [{}]);
        }
        return json(404, {});
      },
    },
  };
}

const okBody = { text: ' Stell einen Timer auf zehn Minuten. ', usage: { type: 'tokens', input_tokens: 120, input_token_details: { text_tokens: 0, audio_tokens: 120 }, output_tokens: 12, total_tokens: 132 } };

test.describe('Diktat über Buddy Cloud', () => {
  test('WAV → OpenAI (multipart, Server-Key, Sprache) → Text; Abrechnung nach echter Nutzung, Eintrag «Diktat»', async () => {
    const l = ledger();
    let sent;
    const app = await startApp({ handlers: { ...l.handlers, openai: (form, init, url) => { sent = { form, auth: init.headers.authorization, url }; return json(200, okBody); } } });
    try {
      const r = await app.call('POST', '/v1/cloud/audio/transcriptions', { token: signToken(), body: { audio: wav(2.5).toString('base64'), language: 'de' } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.text, 'Stell einen Timer auf zehn Minuten.');
      assert.equal(r.data.seconds, 2.5);
      assert.match(sent.url, /\/audio\/transcriptions$/);
      assert.equal(sent.auth, 'Bearer sk-test-openai-key-000000');
      assert.ok(sent.form instanceof FormData);
      assert.equal(sent.form.get('model'), 'gpt-4o-mini-transcribe');
      assert.equal(sent.form.get('language'), 'de');
      assert.equal(sent.form.get('response_format'), 'json');
      assert.equal(sent.form.get('file').size, 44 + 2.5 * 16000 * 2);
      // Abrechnung: nur Tokens (keine Sekunden zusätzlich), Reservierung aufgelöst
      assert.deepEqual(l.st.settled[0].p_audio, { input_tokens: 120 });
      assert.equal(l.st.settled[0].p_output_tokens, 12);
      assert.equal(l.st.settled[0].p_input_tokens, 0);
      assert.equal(r.data.creditsCharged, '1.212000');
      assert.equal(l.st.reservations.size, 0);
      assert.equal(l.fmt(l.st.available), '98.788000');
      assert.equal(l.st.labels[0].body.description, 'Diktat');
      assert.match(l.st.labels[0].query, /transaction_type=eq\.usage/);
    } finally { await app.close(); }
  });

  test('Nutzung nach Sekunden (whisper-Format) oder ohne Angabe: nach Aufnahmelänge', () => {
    assert.deepEqual(transcriptionUsage({ type: 'duration', seconds: 4.04 }, 4), { inputTokens: 0, cachedTokens: 0, outputTokens: 0, audio: { transcription_seconds: 4.1 } });
    assert.deepEqual(transcriptionUsage(undefined, 2.5).audio, { transcription_seconds: 2.5 });
  });

  test('zu wenig Guthaben → 402, OpenAI wird nicht aufgerufen', async () => {
    const l = ledger({ available: 1000n });
    let called = false;
    const app = await startApp({ handlers: { ...l.handlers, openai: () => { called = true; return json(200, okBody); } } });
    try {
      const r = await app.call('POST', '/v1/cloud/audio/transcriptions', { token: signToken(), body: { audio: wav(1).toString('base64') } });
      assert.equal(r.status, 402);
      assert.equal(r.data.error.code, 'insufficient_credits');
      assert.equal(called, false);
    } finally { await app.close(); }
  });

  test('Limits und Prüfung: zu lang, zu kurz, falsches Format, fremde Felder, Sprache, ohne Anmeldung', async () => {
    const l = ledger();
    let calls = 0;
    const app = await startApp({ handlers: { ...l.handlers, openai: () => { calls += 1; return json(200, okBody); } } });
    try {
      const t = signToken();
      const post = (body, token = t) => app.call('POST', '/v1/cloud/audio/transcriptions', { token, body });
      assert.equal((await post({ audio: wav(32).toString('base64') })).status, 413);
      assert.equal((await post({ audio: wav(0.1).toString('base64') })).status, 400);
      assert.equal((await post({ audio: wav(1, { rate: 44100 }).toString('base64') })).status, 400);
      assert.equal((await post({ audio: wav(1, { channels: 2 }).toString('base64') })).status, 400);
      assert.equal((await post({ audio: 'kein base64 !!' })).status, 400);
      assert.equal((await post({ audio: Buffer.from('hallo').toString('base64') })).status, 400);
      assert.equal((await post({ audio: wav(1).toString('base64'), model: 'gpt-4o-transcribe' })).status, 400);
      assert.equal((await post({ audio: wav(1).toString('base64'), language: 'deutsch!' })).status, 400);
      assert.equal((await post({})).status, 400);
      assert.equal((await post({ audio: wav(1).toString('base64') }, null)).status, 401);
      assert.equal(calls, 0);
      assert.equal(l.st.reservations.size, 0);
    } finally { await app.close(); }
  });

  test('OpenAI-Fehler → Reservierung freigegeben; 401 von OpenAI nie als 401 an die App', async () => {
    const l = ledger();
    const app = await startApp({ handlers: { ...l.handlers, openai: () => json(401, { error: { message: 'Incorrect API key provided: sk-abc', code: 'invalid_api_key' } }) } });
    try {
      const r = await app.call('POST', '/v1/cloud/audio/transcriptions', { token: signToken(), body: { audio: wav(1).toString('base64') } });
      assert.equal(r.status, 502);
      assert.ok(!r.text.includes('sk-'));
      assert.equal(l.st.released[0].p_status, 'failed');
      assert.equal(l.st.reservations.size, 0);
      assert.equal(l.fmt(l.st.available), '100.000000');
    } finally { await app.close(); }
  });

  test('OpenAI nicht erreichbar → 503, freigegeben; Modell ohne Preis → 503 not_configured', async () => {
    const l = ledger();
    const app = await startApp({ handlers: { ...l.handlers, openai: () => { throw new TypeError('fetch failed'); } } });
    try {
      const r = await app.call('POST', '/v1/cloud/audio/transcriptions', { token: signToken(), body: { audio: wav(1).toString('base64') } });
      assert.equal(r.status, 503);
      assert.equal(l.st.reservations.size, 0);
    } finally { await app.close(); }
    const l2 = ledger({ pricedModel: 'gpt-test' });
    const app2 = await startApp({ handlers: { ...l2.handlers, openai: () => json(200, okBody) } });
    try {
      const r = await app2.call('POST', '/v1/cloud/audio/transcriptions', { token: signToken(), body: { audio: wav(1).toString('base64') } });
      assert.equal(r.status, 503);
      assert.equal(r.data.error.code, 'not_configured');
    } finally { await app2.close(); }
  });

  test('parseWav: Länge aus dem Kopf', () => {
    assert.equal(parseWav(wav(3)).seconds, 3);
    assert.throws(() => parseWav(Buffer.alloc(10)));
  });
});
