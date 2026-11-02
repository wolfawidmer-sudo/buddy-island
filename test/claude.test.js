const assert = require('assert');
const { createClient } = require('../src/claude');

function sseResponse(events, status = 200) {
  const text = events.map(([e, d]) => `event: ${e}\r\ndata: ${JSON.stringify(d)}\r\n\r\n`).join('');
  // in kleine Stücke zerteilen, um Puffer-Logik zu testen
  const chunks = text.match(/[\s\S]{1,7}/g).map((c) => new TextEncoder().encode(c));
  const body = new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
  return new Response(body, { status });
}

(async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: { ...init, body: init.body && JSON.parse(init.body) } });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config: Extra inputs are not permitted' } }), { status: 400 });
    }
    return sseResponse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 12 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'geheim' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hoi ' } }],
      ['ping', { type: 'ping' }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Wolf! ü' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  };
  const client = createClient(fetchImpl);
  let out = '';
  const res = await client.streamMessage({ apiKey: 'test-key-ohne-wert', workspaceId: 'wrkspc_1', model: 'claude-sonnet-5-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, effort: 'low', onText: (t) => (out += t) }); // pragma: allowlist secret (Testwert, kein echter Key)
  assert.strictEqual(out, 'Hoi Wolf! ü');
  assert.strictEqual(res.stopReason, 'end_turn');
  assert.strictEqual(res.usage.output_tokens, 5);
  assert.strictEqual(calls.length, 2, 'retry without output_config');
  assert.ok(calls[0].init.body.output_config);
  assert.ok(!calls[1].init.body.output_config);
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer test-key-ohne-wert');
  assert.strictEqual(calls[0].init.headers['anthropic-workspace-id'], 'wrkspc_1');
  assert.ok(!('temperature' in calls[1].init.body));

  // Fehler-Mapping
  const bad = createClient(async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 }));
  await assert.rejects(bad.listModels('k'), /API-Key ist ungültig/);
  const off = createClient(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(off.listModels('k'), /Keine Verbindung/);
  const ws = createClient(async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Please add the anthropic-workspace-id header' } }), { status: 400 }));
  await assert.rejects(ws.streamMessage({ apiKey: 'k', messages: [], onText() {} }), /Workspace-ID/);
  const mid = createClient(async () => sseResponse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]]));
  await assert.rejects(mid.streamMessage({ apiKey: 'k', messages: [], onText() {} }), /überlastet/);
  console.log('alle Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });

// Tool-Aufrufe: Blöcke müssen vollständig zusammengesetzt werden
(async () => {
  const client = createClient(async () => sseResponse([
    ['message_start', { message: { usage: { input_tokens: 3 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Timer…' } }],
    ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Mach ich.' } }],
    ['content_block_stop', { index: 1 }],
    ['content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'set_timer', input: {} } }],
    ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"minutes": 1' } }],
    ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '0, "label": "Pizza"}' } }],
    ['content_block_stop', { index: 2 }],
    ['message_delta', { delta: { stop_reason: 'tool_use' } }],
  ]));
  const res = await client.streamMessage({ apiKey: 'k', messages: [], onText() {} });
  assert.strictEqual(res.stopReason, 'tool_use');
  assert.deepStrictEqual(res.content, [
    { type: 'thinking', thinking: 'Timer…', signature: 'SIG123' },
    { type: 'text', text: 'Mach ich.' },
    { type: 'tool_use', id: 'toolu_1', name: 'set_timer', input: { minutes: 10, label: 'Pizza' } },
  ]);

  const { createTools, formatDuration } = require('../src/tools');
  const events = [];
  const tools = createTools({ onTimersChanged: (l) => events.push(['list', l.length]), onTimerDone: (t) => events.push(['done', t.label]) });
  const r = await tools.run('set_timer', { seconds: 1, label: 'Test' });
  assert.match(r.text, /Timer «Test» \(ID t1\)/);
  assert.match((await tools.run('list_timers')).text, /t1: «Test»/);
  assert.ok((await tools.run('open_website', { url: 'javascript:alert(1)' })).error);
  assert.ok((await tools.run('set_timer', { seconds: 0 })).error);
  await new Promise((ok) => setTimeout(ok, 1200));
  assert.deepStrictEqual(events.at(-1), ['done', 'Test']);
  assert.strictEqual(formatDuration(90000), '1 Min. 30 Sek.');
  assert.strictEqual(tools.describe('set_timer', { minutes: 10, label: 'Pizza' }), 'Timer 10 Min. · Pizza');
  console.log('Tool-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
