// Tests gegen langsame Antworten: Smalltalk ohne Dispatcher, Zeitlimit für den Dispatcher,
// Denkstufe für Gemini 3 (ohne Angabe denkt Gemini 3 auf «high» und braucht lange).
const assert = require('assert');
const { createRouter, DISPATCH_TIMEOUT_MS } = require('../src/router');
const { createUsage } = require('../src/usage');
const { createGeminiClient, thinkingLevelFor } = require('../src/llm/gemini');
const models = require('../src/models');

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
  const res = await gemini.streamMessage({ apiKey: 'AIza-test', model: 'gemini-3.1-flash-lite', system: 'S', messages: [{ role: 'user', content: 'Hallo!' }], maxTokens: 4096, effort: 'low', stream: false });
  assert.strictEqual(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.strictEqual(bodies[1].generationConfig.thinkingConfig.thinkingLevel, 'low', 'Ausweichstufe statt «high»');
  assert.strictEqual(res.content[0].text, 'Mir geht es gut!');

  // Gemini 2.5 Flash bei «low»: weiterhin thinkingBudget 0, kein thinkingLevel
  await gemini.streamMessage({ apiKey: 'AIza-test', model: 'gemini-2.5-flash', system: 'S', messages: [{ role: 'user', content: 'Hallo!' }], maxTokens: 4096, effort: 'low', stream: false });
  assert.deepStrictEqual(bodies[bodies.length - 1].generationConfig.thinkingConfig, { thinkingBudget: 0 });

  console.log('Tempo-Tests ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
