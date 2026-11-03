// Tests für die Multi-Provider-Schicht: OpenAI-kompatibler Adapter (OpenAI, Grok, Gemini),
// Fähigkeiten, Agent mit Anbietern ohne Computer Use oder ohne Werkzeuge, Router, Hardware-Empfehlung, Sprache.
const assert = require('assert');
const models = require('../src/models');
const { createOpenAiCompatClient, toChatMessages, toChatTools } = require('../src/llm/openai-compat');
const { toPlainMessages } = require('../src/llm/huggingface');
const { createAgent } = require('../src/agent');
const { createRouter } = require('../src/router');
const { createUsage } = require('../src/usage');
const { createHistory } = require('../src/history');
const { recommend } = require('../src/system-specs');
const i18n = require('../src/i18n');

function sse(chunks, status = 200) {
  const text = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
  const parts = text.match(/[\s\S]{1,11}/g).map((x) => new TextEncoder().encode(x));
  return new Response(new ReadableStream({ start(ctl) { parts.forEach((p) => ctl.enqueue(p)); ctl.close(); } }), { status });
}

(async () => {
  // ---------- Fähigkeiten ----------
  assert.strictEqual(models.capabilities('claude-sonnet-5-5').computerUse, true);
  assert.strictEqual(models.capabilities('gpt-4o').computerUse, false);
  assert.strictEqual(models.capabilities('gpt-4o').vision, true);
  assert.strictEqual(models.capabilities('hf:Qwen/Qwen2.5-1.5B-Instruct').tools, false);
  assert.strictEqual(models.capabilities('hf:Qwen/Qwen2.5-1.5B-Instruct').vision, false);
  assert.strictEqual(models.providerOf('grok-4.6'), 'xai');
  assert.strictEqual(models.providerOf('gemini-3.6-flash'), 'gemini');
  assert.strictEqual(models.costOf('hf:x/y', { input_tokens: 1e6, output_tokens: 1e6 }), 0, 'lokal kostet nichts');
  assert.ok(models.info('gpt-4o').priceEstimated, 'Fremdpreise sind als Schätzung markiert');

  // ---------- Übersetzung der Nachrichten ----------
  const conv = [
    { role: 'user', content: 'Mach ein Foto' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'Moment' }, { type: 'tool_use', id: 'c1', name: 'list_files', input: { folder: 'Desktop' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: '3 Dateien' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }] }, { type: 'text', text: '[Hinweis]' }] },
  ];
  let msgs = toChatMessages(conv, 'Sys', { vision: true });
  assert.deepStrictEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.strictEqual(msgs[2].content, 'Moment', 'Denk-Blöcke fallen weg');
  assert.deepStrictEqual(msgs[2].tool_calls[0], { id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"folder":"Desktop"}' } });
  assert.strictEqual(msgs[3].tool_call_id, 'c1');
  assert.match(msgs[4].content[1].image_url.url, /^data:image\/jpeg;base64,QUJD$/, 'Bild nach dem Werkzeug-Ergebnis');
  msgs = toChatMessages(conv, '', { vision: false });
  assert.ok(!JSON.stringify(msgs).includes('image_url'), 'ohne Bildverarbeitung keine Bilder');
  assert.match(JSON.stringify(msgs), /Bild weggelassen/);
  const tl = toChatTools([{ name: 'a', description: 'd', input_schema: { type: 'object' } }, { type: 'computer_toolset_20260801' }]);
  assert.strictEqual(tl.tools.length, 1);
  assert.strictEqual(tl.dropped, true, 'Computer Use gibt es nur bei Claude');
  const plain = toPlainMessages(conv, 'Sys');
  assert.deepStrictEqual(plain.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(plain[3].content, /3 Dateien/);

  // ---------- Streaming mit Werkzeug-Aufruf ----------
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }] }));
    if (calls.filter((c) => c.url.endsWith('/chat/completions')).length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Invalid parameter: response_format json_schema not supported', type: 'invalid_request_error' } }), { status: 400 });
    }
    return sse([
      { choices: [{ delta: { role: 'assistant', content: 'Ich ' } }] },
      { choices: [{ delta: { content: 'schaue.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_', arguments: '{"fol' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'files', arguments: 'der":"Desktop"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } } },
      '[DONE]',
    ]);
  };
  const gemini = createOpenAiCompatClient({ provider: models.PROVIDERS.gemini, fetchImpl });
  const list = await gemini.listModels('AIza-test');
  assert.deepStrictEqual(list.map((m) => m.id), ['gemini-2.5-flash', 'text-embedding-004'], 'Präfix models/ entfernt');
  let out = '';
  const res = await gemini.streamMessage({
    apiKey: 'AIza-test', model: 'gemini-2.5-flash', system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, // pragma: allowlist secret
    tools: [{ name: 'list_files', description: '', input_schema: { type: 'object' } }, { type: 'computer_toolset_20260801' }],
    format: { type: 'object' }, onText: (x) => { out += x; },
  });
  assert.strictEqual(out, 'Ich schaue.');
  assert.strictEqual(res.stopReason, 'tool_use');
  assert.deepStrictEqual(res.content[1], { type: 'tool_use', id: 'call_1', name: 'list_files', input: { folder: 'Desktop' } });
  assert.deepStrictEqual(res.usage, { input_tokens: 200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 });
  assert.strictEqual(res.droppedComputer, true);
  const chatCalls = calls.filter((c) => c.url.endsWith('/chat/completions'));
  assert.ok(chatCalls[0].body.response_format && !chatCalls[1].body.response_format, 'ohne response_format nochmals');
  assert.strictEqual(chatCalls[1].body.max_tokens, 500, 'Gemini bekommt max_tokens');
  assert.ok(chatCalls[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/openai/'));
  assert.strictEqual(chatCalls[0].auth, 'Bearer AIza-test');

  // OpenAI: max_completion_tokens, reasoning_effort nur bei Modellen, die es kennen
  const oaCalls = [];
  const openai = createOpenAiCompatClient({ provider: models.PROVIDERS.openai, fetchImpl: async (url, init) => { oaCalls.push(JSON.parse(init.body)); return sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']); } });
  await openai.streamMessage({ apiKey: 'sk-x', model: 'gpt-5', messages: [{ role: 'user', content: 'x' }], maxTokens: 100, effort: 'high' }); // pragma: allowlist secret
  await openai.streamMessage({ apiKey: 'sk-x', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], maxTokens: 100, effort: 'high' }); // pragma: allowlist secret
  assert.strictEqual(oaCalls[0].max_completion_tokens, 100);
  assert.strictEqual(oaCalls[0].reasoning_effort, 'high');
  assert.ok(!('reasoning_effort' in oaCalls[1]));

  // Fehler sind verständlich und nennen den Anbieter
  const bad = createOpenAiCompatClient({ provider: models.PROVIDERS.xai, fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }), { status: 401 }) });
  await assert.rejects(bad.streamMessage({ apiKey: 'xai-x', model: 'grok-4.6', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), /API-Key ist ungültig/); // pragma: allowlist secret
  let n529 = 0;
  const busy = createOpenAiCompatClient({ provider: models.PROVIDERS.xai, fetchImpl: async () => { n529 += 1; return new Response('{}', { status: 503 }); } });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 3), ...a);
  await assert.rejects(busy.streamMessage({ apiKey: 'xai-x', model: 'grok-4.6', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), /Grok/); // pragma: allowlist secret
  global.setTimeout = realSetTimeout;
  assert.strictEqual(n529, 4, 'drei kontrollierte Wiederholungen');

  // ---------- Agent mit anderen Anbietern ----------
  function scripted(steps) {
    const seen = [];
    return {
      seen,
      json: async () => ({ data: { komplexitaet: 'einfach', reasoning: 'niedrig', schritte: 1, faehigkeiten: ['wissen'], risiko: 'niedrig', risiken: [], tokens: 100, modell: 'haiku', aufwand: 'low', begruendung: 'Einfach' }, usage: {} }),
      streamMessage: async (req) => {
        seen.push({ model: req.model, tools: (req.tools || []).map((x) => x.name || x.type), system: req.system });
        const step = steps[seen.length - 1];
        for (const b of step) if (b.type === 'text') req.onText(b.text);
        return { stopReason: step.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: step };
      },
    };
  }
  function agentFor(provider, client, available) {
    const events = [];
    const agent = createAgent({
      claude: client, getClient: () => client, getProvider: () => provider,
      router: createRouter({ claude: client, usage: createUsage({}) }), usage: createUsage({}), history: createHistory({}),
      getKey: () => 'k', getSettings: () => ({ autoModel: true, effort: 'auto', confirmControl: false, permissions: {} }),
      getTools: () => ({ definitions: [{ name: 'set_timer', description: '', input_schema: { type: 'object', properties: {} } }], run: async () => ({ text: 'ok' }), describe: () => 'Timer' }),
      getComputer: () => ({ describe: (n) => n, run: async () => [], warmUp() {}, stop() {} }), getFiles: () => null,
      isComputerAvailable: () => true, getAvailableModels: async () => available, getGame: () => ({ active: false }),
      systemPrompt: (withComputer, opts) => `withComputer=${withComputer} tools=${opts?.tools}`,
      askControl: async () => true, askPermission: async () => true,
    });
    return { events, run: (text) => agent.run({ id: 'p1', messages: [{ role: 'user', content: text }], send: (c, p) => events.push({ c, p }), signal: new AbortController().signal }) };
  }

  // OpenAI: Werkzeuge ja, PC-Steuerung nein, Hinweis bei Bildschirm-Wunsch
  let client = scripted([[{ type: 'text', text: 'Das kann ich hier nicht.' }]]);
  let a = agentFor('openai', client, [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }]);
  await a.run('Klick bitte auf den Speichern-Knopf');
  assert.strictEqual(client.seen[0].model, 'gpt-4o-mini', 'günstigstes OpenAI-Modell');
  assert.ok(client.seen[0].tools.includes('set_timer'));
  assert.ok(!client.seen[0].tools.includes('computer_toolset_20260801'), 'kein Computer-Use-Toolset an OpenAI');
  assert.match(client.seen[0].system, /withComputer=false/);
  assert.match(a.events.find((e) => e.c === 'chat:notice').p.text, /nur mit Claude/);

  // Lokales Modell: keine Werkzeuge, kein Router-Aufruf, Hinweis zur Bildverarbeitung
  client = scripted([[{ type: 'text', text: 'Hallo!' }]]);
  let routerCalls = 0;
  const origJson = client.json;
  client.json = async (...x) => { routerCalls += 1; return origJson(...x); };
  a = agentFor('huggingface', client, [{ id: 'hf:Qwen/Qwen2.5-1.5B-Instruct' }]);
  await a.run('Mach einen Screenshot und erkläre mir das Fenster bitte genau');
  assert.strictEqual(client.seen[0].model, 'hf:Qwen/Qwen2.5-1.5B-Instruct');
  assert.deepStrictEqual(client.seen[0].tools, [], 'lokal ohne Werkzeuge');
  assert.match(client.seen[0].system, /tools=false/);
  assert.strictEqual(routerCalls, 0);
  assert.match(a.events.find((e) => e.c === 'chat:notice').p.text, /keine Bildschirmfotos/);
  assert.strictEqual(a.events.find((e) => e.c === 'chat:done').p.usage.cost, 0);

  // Claude bleibt wie bisher (Computer Use möglich)
  client = scripted([[{ type: 'text', text: 'Ok' }]]);
  a = agentFor('anthropic', client, []);
  await a.run('Hoi');
  assert.match(client.seen[0].system, /withComputer=true/);
  assert.ok(!a.events.some((e) => e.c === 'chat:notice'));

  // ---------- Hardware-Empfehlung ----------
  const laptop = recommend({ ramGB: 16, threads: 12, cuda: false, cudaVramGB: null, gpus: [] });
  assert.strictEqual(laptop.fastest.id, 'Qwen/Qwen2.5-0.5B-Instruct');
  assert.strictEqual(laptop.best.device, 'Prozessor');
  const gamer = recommend({ ramGB: 32, threads: 16, cuda: true, cudaVramGB: 12, gpus: [{ vendor: 'nvidia' }] });
  assert.strictEqual(gamer.best.device, 'Grafikkarte');
  assert.ok(gamer.best.needGB <= 12 * 0.9);
  const weakGpu = recommend({ ramGB: 16, threads: 8, cuda: true, cudaVramGB: 6, gpus: [{ vendor: 'nvidia' }] });
  assert.strictEqual(weakGpu.best.device, 'Grafikkarte', 'GPU vor langsamer CPU');
  const noCuda = recommend({ ramGB: 16, threads: 8, cuda: false, cudaVramGB: null, gpus: [{ vendor: 'nvidia', name: 'RTX 3060' }] });
  assert.match(noCuda.summary, /CUDA/);

  // ---------- Sprache ----------
  assert.strictEqual(i18n.detect(['de-CH', 'en-US']), 'de');
  assert.strictEqual(i18n.detect(['fr-CH']), 'fr');
  assert.strictEqual(i18n.detect(['it-IT']), 'en');
  assert.strictEqual(i18n.detect(['ja-JP']), 'en', 'unbekannt → Englisch');
  i18n.setLanguage('de');

  console.log('Anbieter-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
