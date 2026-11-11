'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, signToken, json } = require('./helpers');
const { estimateInputTokens } = require('../src/services/billing');
const { usageOf } = require('../src/services/openai');

/** Supabase-Attrappe mit einfacher Wallet im Speicher (Credits als ganze Millionstel, kein float) */
function fakeLedger({ available = 10_000000n } = {}) {
  const state = { available, reserved: 0n, reservations: new Map(), settled: [], released: [] };
  const fmt = (v) => `${v / 1000000n}.${String(v % 1000000n).padStart(6, '0')}`;
  const parse = (s) => { const [a, b = ''] = String(s).split('.'); return BigInt(a) * 1000000n + BigInt((b + '000000').slice(0, 6)); };
  return {
    state,
    fmt,
    handlers: {
      supabaseSelect: (table) => (table === 'model_pricing' ? json(200, [{ model_id: 'gpt-test' }]) : json(200, [])),
      supabaseRpc: (name, a) => {
        if (name === 'billing_quote') {
          // Testpreis: 1 BC je 1000 Tokens (Eingabe + Ausgabe)
          const credits = BigInt(a.p_input_tokens + a.p_output_tokens) * 1000n;
          return json(200, [{ provider_cost: '0', markup_amount: '0', total_cost: '0', credits: fmt(credits) }]);
        }
        if (name === 'reserve_credits') {
          const amt = parse(a.p_amount);
          if (state.available < amt) return json(400, { message: 'insufficient_credits', code: 'P0001' });
          state.available -= amt; state.reserved += amt;
          state.reservations.set(a.p_request_id, amt);
          return json(200, [{ reservation_id: 'r1', amount: fmt(amt), available_credits: fmt(state.available), reserved_credits: fmt(state.reserved), status: 'active' }]);
        }
        if (name === 'settle_reservation') {
          const amt = state.reservations.get(a.p_request_id) || 0n;
          const charge = BigInt(a.p_input_tokens + a.p_output_tokens) * 1000n;
          state.available += amt - charge; state.reserved -= amt; state.reservations.delete(a.p_request_id);
          state.settled.push(a);
          return json(200, { credits_charged: fmt(charge), status: 'settled' });
        }
        if (name === 'release_reservation') {
          const amt = state.reservations.get(a.p_request_id) || 0n;
          state.available += amt; state.reserved -= amt; state.reservations.delete(a.p_request_id);
          state.released.push(a);
          return json(200, [{ available_credits: fmt(state.available), reserved_credits: fmt(state.reserved), status: 'released' }]);
        }
        return json(404, { message: 'unknown' });
      },
    },
  };
}

const okResponse = { id: 'resp_1', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hallo' }] }], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300 } };

function sseStream(events, { delayMs = 0, breakAfter = Infinity } = {}) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= events.length || i >= breakAfter) { controller.close(); return; }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(new TextEncoder().encode(`event: ${events[i].type}\ndata: ${JSON.stringify(events[i])}\n\n`));
      i += 1;
    },
  });
}

test.describe('OpenAI-Gateway', () => {
  test('ohne Streaming: reserviert, ruft OpenAI mit Server-Key, rechnet echte Nutzung ab', async () => {
    const ledger = fakeLedger();
    let sent;
    const app = await startApp({ handlers: { ...ledger.handlers, openai: (body, init) => { sent = { body, auth: init.headers.authorization }; return json(200, okResponse); } } });
    try {
      const r = await app.call('POST', '/v1/cloud/responses', { token: signToken(), body: { model: 'gpt-test', input: 'Hallo Buddy', max_output_tokens: 1000, store: false } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.output[0].content[0].text, 'Hallo');
      assert.equal(sent.auth, 'Bearer sk-test-openai-key-000000');
      assert.equal(sent.body.store, false);
      assert.equal(sent.body.max_output_tokens, 1000);
      assert.match(sent.body.safety_identifier, /^[0-9a-f]{32}$/);
      assert.deepEqual(ledger.state.settled[0], { p_request_id: ledger.state.settled[0].p_request_id, p_input_tokens: 1200, p_cached_tokens: 200, p_output_tokens: 300, p_audio: null });
      assert.equal(r.headers.get('x-buddy-credits-charged'), '1.500000');
      assert.equal(ledger.state.reserved, 0n);
      assert.equal(ledger.fmt(ledger.state.available), '8.500000');
    } finally { await app.close(); }
  });

  test('zu wenig Guthaben → 402 insufficient_credits, OpenAI wird nicht aufgerufen', async () => {
    const ledger = fakeLedger({ available: 100n });
    let called = false;
    const app = await startApp({ handlers: { ...ledger.handlers, openai: () => { called = true; return json(200, okResponse); } } });
    try {
      const r = await app.call('POST', '/v1/cloud/responses', { token: signToken(), body: { model: 'gpt-test', input: 'Hallo' } });
      assert.equal(r.status, 402);
      assert.equal(r.data.error.code, 'insufficient_credits');
      assert.equal(called, false);
    } finally { await app.close(); }
  });

  test('Prüfung: unbekanntes Modell, store:true, fremde Felder, ohne Anmeldung', async () => {
    const ledger = fakeLedger();
    const app = await startApp({ handlers: { ...ledger.handlers, openai: () => json(200, okResponse) } });
    try {
      const t = signToken();
      assert.equal((await app.call('POST', '/v1/cloud/responses', { token: t, body: { model: 'gpt-anders', input: 'x' } })).data.error.code, 'model_not_available');
      assert.equal((await app.call('POST', '/v1/cloud/responses', { token: t, body: { model: 'gpt-test', input: 'x', store: true } })).status, 400);
      const extra = await app.call('POST', '/v1/cloud/responses', { token: t, body: { model: 'gpt-test', input: 'x', user: 'someone-else' } });
      assert.equal(extra.status, 400);
      assert.match(extra.data.error.message, /Unbekannte Felder: user/);
      assert.equal((await app.call('POST', '/v1/cloud/responses', { token: t, body: { model: 'gpt-test', input: 'x', include: ['file_search_call.results'] } })).status, 400);
      assert.equal((await app.call('POST', '/v1/cloud/responses', { body: { model: 'gpt-test', input: 'x' } })).status, 401);
      assert.equal(ledger.state.reservations.size, 0);
    } finally { await app.close(); }
  });

  test('OpenAI 401 (unser Key) → 502, nie 401 an die App; Reservierung freigegeben', async () => {
    const ledger = fakeLedger();
    const app = await startApp({ handlers: { ...ledger.handlers, openai: () => json(401, { error: { message: 'Incorrect API key provided: sk-abc…', code: 'invalid_api_key' } }) } });
    try {
      const r = await app.call('POST', '/v1/cloud/responses', { token: signToken(), body: { model: 'gpt-test', input: 'x' } });
      assert.equal(r.status, 502);
      assert.equal(r.data.error.code, 'upstream_auth');
      assert.ok(!r.text.includes('sk-'));
      assert.equal(ledger.state.released[0].p_status, 'failed');
      assert.equal(ledger.fmt(ledger.state.available), '10.000000');
    } finally { await app.close(); }
  });

  test('OpenAI 400 wird mit Meldung weitergegeben (für die Ausweich-Logik des Adapters)', async () => {
    const ledger = fakeLedger();
    const app = await startApp({ handlers: { ...ledger.handlers, openai: () => json(400, { error: { message: "Unsupported value: 'reasoning.effort' does not support 'max'", code: 'unsupported_value' } }) } });
    try {
      const r = await app.call('POST', '/v1/cloud/responses', { token: signToken(), body: { model: 'gpt-test', input: 'x', reasoning: { effort: 'max' } } });
      assert.equal(r.status, 400);
      assert.match(r.data.error.message, /reasoning\.effort/);
      assert.equal(ledger.state.reserved, 0n);
    } finally { await app.close(); }
  });

  test('Streaming: Ereignisse unverändert durchgereicht, danach abgerechnet und buddy.billing angehängt', async () => {
    const ledger = fakeLedger();
    const events = [
      { type: 'response.created', response: { id: 'resp_2' } },
      { type: 'response.output_text.delta', delta: 'Hal' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.function_call_arguments.delta', delta: '{"a":1}' },
      { type: 'response.completed', response: { ...okResponse, id: 'resp_2' } },
    ];
    const app = await startApp({ handlers: { ...ledger.handlers, openai: () => new Response(sseStream(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }) } });
    try {
      const r = await app.call('POST', '/v1/cloud/responses', { token: signToken(), body: { model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }], stream: true, tools: [{ type: 'function', name: 'timer', parameters: {} }] } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/event-stream/);
      for (const e of events) assert.ok(r.text.includes(JSON.stringify(e)), e.type);
      assert.match(r.text, /event: buddy\.billing\ndata: \{"type":"buddy\.billing".*"credits_charged":"1\.500000"/);
      assert.equal(ledger.state.settled.length, 1);
      assert.equal(ledger.state.reserved, 0n);
    } finally { await app.close(); }
  });

  test('Streaming abgerissen ohne Nutzungsangabe → Schätzung abgerechnet; ohne Ausgabe → freigegeben', async () => {
    const ledger = fakeLedger();
    let withText = true;
    const app = await startApp({
      handlers: {
        ...ledger.handlers,
        openai: () => new Response(sseStream(withText ? [{ type: 'response.output_text.delta', delta: 'x'.repeat(300) }] : [{ type: 'response.created', response: {} }]), { status: 200 }),
      },
    });
    try {
      await app.call('POST', '/v1/cloud/responses', { token: signToken(), body: { model: 'gpt-test', input: 'abc', stream: true } });
      assert.equal(ledger.state.settled.length, 1);
      assert.equal(ledger.state.settled[0].p_output_tokens, 100);
      withText = false;
      await app.call('POST', '/v1/cloud/responses', { token: signToken(), body: { model: 'gpt-test', input: 'abc', stream: true } });
      assert.equal(ledger.state.released.length, 1);
      assert.equal(ledger.state.reserved, 0n);
    } finally { await app.close(); }
  });

  test('Abbruch durch die App während des Streams: OpenAI-Anfrage abgebrochen, nichts bleibt reserviert', async () => {
    const ledger = fakeLedger();
    let upstreamAborted = false;
    const app = await startApp({
      handlers: {
        ...ledger.handlers,
        openai: (_b, init) => {
          init.signal.addEventListener('abort', () => { upstreamAborted = true; });
          const events = Array.from({ length: 50 }, () => ({ type: 'response.output_text.delta', delta: 'abcdef' }));
          return new Response(sseStream(events, { delayMs: 20 }), { status: 200 });
        },
      },
    });
    try {
      const controller = new AbortController();
      const r = await fetch(`${app.base}/v1/cloud/responses`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken()}` }, body: JSON.stringify({ model: 'gpt-test', input: 'abc', stream: true }) });
      const reader = r.body.getReader();
      await reader.read();
      controller.abort();
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(upstreamAborted, true);
      assert.equal(ledger.state.reserved, 0n);
      assert.equal(ledger.state.settled.length + ledger.state.released.length, 1);
    } finally { await app.close(); }
  });

  test('Modell-Liste im OpenAI-Format', async () => {
    const ledger = fakeLedger();
    const app = await startApp({ handlers: ledger.handlers });
    try {
      const r = await app.call('GET', '/v1/cloud/models', { token: signToken() });
      assert.deepEqual(r.data, { object: 'list', data: [{ id: 'gpt-test', object: 'model', owned_by: 'buddy-island' }] });
    } finally { await app.close(); }
  });

  test('Echtzeit: ehrlich «noch nicht verfügbar» (501); Diktat ist da (tests/transcribe.test.js)', async () => {
    const app = await startApp({});
    try {
      assert.equal((await app.call('POST', '/v1/cloud/audio/transcriptions', { token: signToken(), body: {} })).status, 400);
      assert.equal((await app.call('POST', '/v1/cloud/realtime/sessions', { token: signToken(), body: {} })).status, 501);
    } finally { await app.close(); }
  });
});

test.describe('Nutzung und Schätzung', () => {
  test('usageOf liest Responses-Nutzung, gecachte Tokens nie mehr als Eingabe', () => {
    assert.deepEqual(usageOf(okResponse), { inputTokens: 1200, cachedTokens: 200, outputTokens: 300 });
    assert.deepEqual(usageOf({ usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 99 }, output_tokens: 1 } }), { inputTokens: 10, cachedTokens: 10, outputTokens: 1 });
    assert.equal(usageOf({}), null);
  });

  test('Eingabe-Schätzung: Bilder als Pauschale, nicht nach Base64-Länge', () => {
    const big = 'A'.repeat(3_000_000);
    const withImage = estimateInputTokens({ input: [{ type: 'input_image', image_url: `data:image/png;base64,${big}` }] });
    assert.ok(withImage < 3000, String(withImage));
    const text = estimateInputTokens({ input: 'x'.repeat(3000) });
    assert.ok(text >= 1000);
  });
});
