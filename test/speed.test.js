// Tests gegen langsame Antworten: Smalltalk ohne Dispatcher, Zeitlimit für den Dispatcher,
// Denkstufe für Gemini 3 (ohne Angabe denkt Gemini 3 auf «high» und braucht lange).
const assert = require('assert');
const { createRouter, DISPATCH_TIMEOUT_MS } = require('../src/router');
const { createUsage } = require('../src/usage');
const { createGeminiClient, thinkingLevelFor } = require('../src/llm/gemini');
const models = require('../src/models');
const { createClient } = require('../src/claude');
const { createOpenAiCompatClient } = require('../src/llm/openai-compat');
const learned = require('../src/llm/learned');

const tiers = { haiku: 'gemini-3.1-flash-lite', sonnet: 'gemini-3-flash', opus: 'gemini-3.1-pro' };

(async () => {
  const usage = createUsage({});
  const auto = { autoModel: true, effort: 'auto' };

  // 1) Begrüssung mit Smalltalk: Regel, kein Dispatcher-Aufruf
  let calls = 0;
  const client = { json: async () => { calls += 1; throw new Error('darf nicht aufgerufen werden'); } };
  const router = createRouter({ claude: client, usage });
  for (const text of ['Hallo! Wie geht es dir heute?', 'na, alles gut?', 'Hi Buddy, wie gehts dir?', 'How are you today?']) {
    const d = await router.route({ text, tiers, settings: auto, apiKey: 'k', client, providerId: 'gemini' });
    assert.strictEqual(d.source, 'regel', text);
    assert.strictEqual(d.effort, 'low', `${text}: Gemini 3 bekommt eine Denkstufe`);
  }
  assert.strictEqual(calls, 0, 'kein Dispatcher für Smalltalk');

  // Aufträge gehen weiterhin an den Dispatcher
  const fast = { json: async () => { calls += 1; return { data: null, usage: {} }; } };
  await createRouter({ claude: fast, usage, log: () => {} }).route({ text: 'Hallo, sortier meine Downloads nach Datum', tiers, settings: auto, apiKey: 'k', client: fast, providerId: 'gemini' });
  assert.strictEqual(calls, 1, 'Auftrag fragt den Dispatcher');

  // 2) Hängender Dispatcher: nach dem Zeitlimit entscheidet die Regel
  const hang = { json: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('abgebrochen'), { name: 'AbortError' })))) };
  const logs = [];
  const t0 = Date.now();
  const d = await createRouter({ claude: hang, usage, log: (m) => logs.push(m) }).route({ text: 'Kannst du mir bei etwas mit meinen Fotos helfen?', tiers, settings: auto, apiKey: 'k', client: hang, providerId: 'gemini' });
  const took = Date.now() - t0;
  assert.strictEqual(d.source, 'standard');
  assert.ok(took >= DISPATCH_TIMEOUT_MS - 50 && took < DISPATCH_TIMEOUT_MS + 1500, `Zeitlimit greift (${took} ms)`);
  assert.ok(logs.some((l) => /langsamer/.test(l)));

  // Abbruch durch den Nutzer bleibt ein Abbruch
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(createRouter({ claude: hang, usage }).route({ text: 'Kannst du mir bei etwas mit meinen Fotos helfen?', tiers, settings: auto, apiKey: 'k', client: hang, providerId: 'gemini', signal: ctl.signal }), { name: 'AbortError' });

  // 3) Gemini-3-Modelle kennen Denkstufen, 2.5 nicht
  assert.deepStrictEqual(models.info('gemini-3.1-flash-lite').efforts, ['low', 'medium', 'high']);
  assert.deepStrictEqual(models.info('gemini-2.5-flash').efforts, []);
  assert.strictEqual(thinkingLevelFor('gemini-3.1-flash-lite', 'low'), 'minimal');
  assert.strictEqual(thinkingLevelFor('gemini-3.1-pro', 'low'), 'low');
  assert.strictEqual(thinkingLevelFor('gemini-3.1-flash-lite', null), 'low');
  assert.strictEqual(thinkingLevelFor('gemini-3.1-flash-lite', 'high'), 'high');

  // 4) Die Anfrage enthält thinkingLevel; lehnt das Modell «minimal» ab, folgt «low»
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (bodies.length === 1) { // erster Versuch: «minimal» abgelehnt
      return new Response(JSON.stringify({ error: { code: 400, message: 'thinking_level minimal is not supported for this model', status: 'INVALID_ARGUMENT' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Mir geht es gut!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
  };
  const gemini = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl });
  const res = await gemini.streamMessage({ apiKey: 'AIza-test', model: 'gemini-3.1-flash-lite', system: 'S', messages: [{ role: 'user', content: 'Hallo!' }], maxTokens: 4096, effort: 'low', stream: false }); // pragma: allowlist secret
  assert.strictEqual(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.strictEqual(bodies[1].generationConfig.thinkingConfig.thinkingLevel, 'low', 'Ausweichstufe statt «high»');
  assert.strictEqual(res.content[0].text, 'Mir geht es gut!');

  // Gemini 2.5 Flash bei «low»: weiterhin thinkingBudget 0, kein thinkingLevel
  await gemini.streamMessage({ apiKey: 'AIza-test', model: 'gemini-2.5-flash', system: 'S', messages: [{ role: 'user', content: 'Hallo!' }], maxTokens: 4096, effort: 'low', stream: false });
  assert.deepStrictEqual(bodies[bodies.length - 1].generationConfig.thinkingConfig, { thinkingBudget: 0 });

  // Gemini merkt sich, dass «minimal» nicht geht: nächste Anfrage direkt mit «low»
  const before = bodies.length;
  await gemini.streamMessage({ apiKey: 'AIza-test', model: 'gemini-3.1-flash-lite', system: 'S', messages: [{ role: 'user', content: 'Hallo!' }], maxTokens: 4096, effort: 'low', stream: false });
  assert.strictEqual(bodies.length, before + 1, 'kein zweiter Fehlversuch');
  assert.strictEqual(bodies[bodies.length - 1].generationConfig.thinkingConfig.thinkingLevel, 'low');

  // 5) Manuell gewähltes Modell mit Aufwand «Auto»: Smalltalk low, sonst medium (nie die Anbieter-Vorgabe «high»)
  const manual = { autoModel: false, model: 'gemini-3.1-flash-lite', effort: 'auto' };
  const r1 = await createRouter({ claude: client, usage }).route({ text: 'Hallo! Wie geht es dir heute?', tiers, settings: manual, apiKey: 'k', client, providerId: 'gemini' });
  assert.strictEqual(r1.effort, 'low');
  const r2 = await createRouter({ claude: client, usage }).route({ text: 'Schreib mir ein Gedicht über Bern', tiers, settings: manual, apiKey: 'k', client, providerId: 'gemini' });
  assert.strictEqual(r2.effort, 'medium');

  // 6) Claude: bei «low» denkt Haiku nicht, Sonnet nur zwischen Werkzeugen, Opus unverändert
  const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const okStream = () => sse([
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hoi!' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
  const cBodies = [];
  let rejectThinking = false;
  const claude = createClient(async (url, init) => {
    const body = JSON.parse(init.body);
    cBodies.push(body);
    if (rejectThinking && body.thinking) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type: disabled is not supported for this model' } }), { status: 400 });
    return okStream();
  });
  const ask = (model, effort) => claude.streamMessage({ apiKey: 'sk-ant-x', model, system: 'S', messages: [{ role: 'user', content: 'Hallo!' }], maxTokens: 4096, effort, onText: () => {} }); // pragma: allowlist secret
  await ask('claude-haiku-5-5', 'low');
  assert.deepStrictEqual(cBodies.at(-1).thinking, { type: 'disabled' });
  assert.strictEqual(cBodies.at(-1).output_config.effort, 'low');
  await ask('claude-sonnet-5-5', 'low');
  assert.deepStrictEqual(cBodies.at(-1).thinking, { type: 'between_tools' });
  await ask('claude-opus-5-5', 'low');
  assert.strictEqual(cBodies.at(-1).thinking, undefined, 'Opus: Denken nicht abschaltbar');
  await ask('claude-haiku-5-5', 'medium');
  assert.strictEqual(cBodies.at(-1).thinking, undefined, 'nur bei low');
  rejectThinking = true;
  const nBefore = cBodies.length;
  await ask('claude-sonnet-5-5', 'low');
  assert.strictEqual(cBodies.length, nBefore + 2, 'ein Fehlversuch, dann ohne thinking');
  assert.strictEqual(cBodies.at(-1).thinking, undefined);
  await ask('claude-sonnet-5-5', 'low');
  assert.strictEqual(cBodies.length, nBefore + 3, 'gemerkt: kein zweiter Fehlversuch');

  // 7) OpenAI-Denkmodelle: bei «low» die schnellste erlaubte Stufe, Ablehnung wird gemerkt
  learned.clear();
  const oBodies = [];
  const oaSse = () => new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }), 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  const openai = createOpenAiCompatClient({ provider: models.PROVIDERS.openai, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    oBodies.push(body);
    if (body.reasoning_effort === 'minimal') {
      return new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'none', 'low', 'medium', and 'high'.", type: 'invalid_request_error', param: 'reasoning_effort' } }), { status: 400 });
    }
    return oaSse();
  } });
  const oAsk = (model, effort) => openai.streamMessage({ apiKey: 'sk-x', model, system: 'S', messages: [{ role: 'user', content: 'Hallo!' }], maxTokens: 4096, effort, onText: () => {} }); // pragma: allowlist secret
  await oAsk('gpt-5.4-mini', 'low');
  assert.strictEqual(oBodies[0].reasoning_effort, 'minimal');
  assert.strictEqual(oBodies[1].reasoning_effort, 'none', 'schnellste erlaubte Stufe aus der Fehlermeldung');
  await oAsk('gpt-5.4-mini', 'low');
  assert.strictEqual(oBodies.length, 3);
  assert.strictEqual(oBodies[2].reasoning_effort, 'none', 'gemerkt');
  await oAsk('gpt-5.4-mini', null);
  assert.strictEqual(oBodies.at(-1).reasoning_effort, 'low', 'ohne Aufwand: low statt Standard medium');
  await oAsk('gpt-4.1', 'low');
  assert.strictEqual(oBodies.at(-1).reasoning_effort, undefined, 'Nicht-Denkmodell: kein reasoning_effort');
  learned.clear();

  console.log('Tempo-Tests ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
