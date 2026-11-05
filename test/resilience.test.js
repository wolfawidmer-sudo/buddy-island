// Ausfallsicherheit der KI-Anbindung (Schwerpunkt Gemini): Fehlerarten, Wiederholungen mit
// Backoff, Ausweichmodell bei Überlastung, Stream-Abbrüche, Funktions-IDs, Fähigkeiten pro
// Modell und der unabhängige Verbindungstest.
//
// ALLE Tests hier sind SIMULIERT (test/mock-providers.js spricht das echte Gemini-Protokoll,
// liefert Fehler wie 503 «high demand» aber auf Bestellung). Echte API-Aufrufe macht nur der
// Verbindungstest in der App (Einstellungen › Verbindung testen) mit deinem eigenen Key.
const assert = require('assert');
const { createMock, GOOD_KEY } = require('./mock-providers');
const { createLlm } = require('../src/llm');
const { createGeminiClient, toContents } = require('../src/llm/gemini');
const { runHealth, healthReport, overallStatus } = require('../src/llm/health');
const errors = require('../src/llm/errors');
const fallback = require('../src/llm/fallback');
const learned = require('../src/llm/learned');
const models = require('../src/models');
const { createAgent } = require('../src/agent');
const { createRouter } = require('../src/router');
const { createUsage } = require('../src/usage');
const { createHistory } = require('../src/history');

const ALIASES = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest'];
const KEY = GOOD_KEY.gemini;

// Wartezeiten verkürzen, aber messen, wie lange Buddy warten WOLLTE
const realSetTimeout = global.setTimeout;
let waits = [];
// Zeitlimits (45 s, 90 s, 120 s) zählen nicht als Wartezeit
const fast = () => {
  waits = [];
  global.setTimeout = (fn, ms, ...a) => {
    if (ms >= 45000) return realSetTimeout(fn, ms, ...a);
    if (ms >= 100) waits.push(ms);
    return realSetTimeout(fn, Math.min(ms, 2), ...a);
  };
};
const slow = () => { global.setTimeout = realSetTimeout; };

function registry(mockOpts = {}) {
  const mock = createMock('gemini', { models: ALIASES, ...mockOpts });
  const logs = [];
  const llm = createLlm({ fetchImpl: mock.fetchImpl, scriptDir: '/tmp', getPythonRuntime: async () => null, log: (m) => logs.push(m) });
  return { mock, client: llm.client('gemini'), logs };
}
const genCalls = (mock, model) => mock.state.requests.filter((q) => /:(stream)?[gG]enerateContent/.test(q.path) && (!model || q.path.includes(`/models/${model}:`)));

function agentFor(client, settings = {}) {
  const events = [];
  const logs = [];
  const usage = createUsage({});
  const agent = createAgent({
    claude: client, getClient: () => client, getProvider: () => 'gemini', log: (m) => logs.push(m),
    router: createRouter({ claude: client, usage }), usage, history: createHistory({}),
    getKey: () => settings.key || KEY, getSettings: () => settings,
    getTools: () => ({
      definitions: [{ name: 'get_number', description: 'Returns a number for a key.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
      run: async (name, input) => ({ text: input.key === 'b' ? '22' : '11' }), describe: () => 'Zahl',
    }),
    getComputer: () => ({ describe: (n) => n, run: async () => [], warmUp() {}, stop() {} }), getFiles: () => null,
    isComputerAvailable: () => false, getAvailableModels: async () => client.listModels(KEY).catch(() => []),
    getGame: () => ({ active: false }), systemPrompt: () => 'Du bist Buddy.',
    askControl: async () => true, askPermission: async () => true, onAuthError: () => {},
  });
  const run = (text) => agent.run({ id: `r${Math.random()}`, messages: [{ role: 'user', content: text }], send: (c, p) => events.push({ c, p }), signal: new AbortController().signal });
  return { events, logs, run };
}
const textOf = (events) => events.filter((e) => e.c === 'chat:delta').map((e) => e.p.text).join('');
const errorOf = (events) => events.find((e) => e.c === 'chat:error')?.p;
const reset = () => { fallback.reset(); learned.clear(); };

(async () => {
  // ---------- 1. Fehlerarten ----------
  {
    const e503 = new errors.ProviderError(503, 'This model is currently experiencing high demand.', 'UNAVAILABLE', 'Gemini');
    assert.strictEqual(e503.category, 'overloaded');
    assert.ok(e503.transient && e503.retryable, '503 ist vorübergehend');
    assert.match(e503.message, /überlastet/);
    assert.match(e503.message, /nicht an deinem Key/, 'Meldung sagt, dass es nicht am Key liegt');
    for (const [status, cat] of [[429, 'rate_limit'], [500, 'server'], [502, 'server'], [504, 'server']]) {
      const e = new errors.ProviderError(status, 'x', '', 'Gemini');
      assert.strictEqual(e.category, cat, `HTTP ${status}`);
      assert.ok(e.transient, `HTTP ${status} vorübergehend`);
    }
    const auth = new errors.ProviderError(400, 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID', 'Gemini');
    assert.strictEqual(auth.category, 'auth');
    assert.ok(!auth.transient && !fallback.canFallback(auth), 'ungültiger Key: kein Ausweichen');
    const model = new errors.ProviderError(404, 'models/x is not found for API version v1beta', 'NOT_FOUND', 'Gemini');
    assert.ok(!model.transient && errors.testStatusOf(model) === 'config');
    const bad = new errors.ProviderError(400, 'Invalid JSON payload received. Unknown name "foo"', 'INVALID_ARGUMENT', 'Gemini');
    assert.strictEqual(bad.category, 'request');
    assert.strictEqual(errors.testStatusOf(bad), 'error', 'ungültige Parameter = Integrationsfehler');
    const quota = new errors.ProviderError(429, 'Your credit balance is too low', '', 'Claude');
    assert.ok(!quota.transient, 'leeres Guthaben: kein Ausweichen');
    assert.strictEqual(errors.testStatusOf(new errors.ProviderError(0, '', '', 'Gemini')), 'unavailable', 'Netzwerk');
    assert.strictEqual(errors.testStatusOf(new errors.ProviderError(400, 'Function calling is not enabled for this model', '', 'Gemini')), 'unsupported');
    // Diagnose ohne Key
    const leak = new errors.ProviderError(503, 'bad key=AIzaSyA1234567890123456789012345 here', '', 'Gemini', { model: 'gemini-flash-latest', apiVersion: 'v1beta' });
    leak.retries = 2;
    const line = errors.diagnosticLine(leak);
    assert.ok(!line.includes('AIzaSy'), 'kein Key im Log');
    assert.match(line, /retries=2/);
    assert.strictEqual(errors.publicError(leak).apiVersion, 'v1beta');
  }

  // ---------- 2. Backoff mit Jitter ----------
  {
    for (let a = 0; a < 6; a += 1) {
      const lo = errors.backoffDelay(a, { random: () => 0 });
      const hi = errors.backoffDelay(a, { random: () => 0.999999 });
      const exp = Math.min(12000, 1000 * 2 ** a);
      assert.ok(lo >= exp / 2 - 1 && hi <= exp + 1 && lo < hi, `Versuch ${a}: ${lo}..${hi}`);
    }
    assert.ok(errors.backoffDelay(10) <= 12000, 'Obergrenze');
    assert.strictEqual(errors.backoffDelay(0, { retryAfterMs: 5000, random: () => 0 }), 5000, 'Retry-After gilt mindestens');
  }

  // ---------- 3. Gemini-Adapter: begrenzte Wiederholungen bei 503 ----------
  fast();
  try {
    reset();
    const mock = createMock('gemini', { models: ALIASES, unavailable: ['gemini-flash-latest'] });
    const g = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: mock.fetchImpl });
    let retries = 0;
    const err = await g.streamMessage({ apiKey: KEY, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, stream: false, onRetry: () => { retries += 1; } }).catch((x) => x);
    assert.strictEqual(err.category, 'overloaded');
    assert.strictEqual(err.status, 503);
    assert.strictEqual(genCalls(mock).length, 4, 'Standard: 1 + 3 Wiederholungen, nie endlos');
    assert.strictEqual(err.retries, 3);
    assert.strictEqual(retries, 3);
    assert.strictEqual(err.apiVersion, 'v1beta');
    assert.ok(waits.length === 3 && waits[0] < waits[2], `wachsende Pausen: ${waits}`);
    assert.ok(waits.every((w) => w <= 20000), 'nie länger als 20 s am Stück');
    // Mit Ausweichmodell nur eine Wiederholung
    const m2 = createMock('gemini', { models: ALIASES, unavailable: ['gemini-flash-latest'] });
    const g2 = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: m2.fetchImpl });
    const e2 = await g2.streamMessage({ apiKey: KEY, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, maxRetries: 1 }).catch((x) => x);
    assert.strictEqual(genCalls(m2).length, 2);
    assert.strictEqual(e2.retries, 1);
    // gemini-flash-lite-latest geht weiterhin
    const ok = await g2.streamMessage({ apiKey: KEY, model: 'gemini-flash-lite-latest', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 10, stream: false });
    assert.strictEqual(ok.content[0].text, 'OK');
    assert.strictEqual(ok.model, 'gemini-flash-lite-latest', 'Ergebnis nennt das benutzte Modell');
  } finally { slow(); }

  // ---------- 4. 429 mit RetryInfo und QuotaFailure ----------
  fast();
  try {
    const perMinute = createMock('gemini', { models: ALIASES, quota429: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', retryDelay: '3s', failOnce: { quota429: 1 } });
    const g = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: perMinute.fetchImpl });
    const r = await g.streamMessage({ apiKey: KEY, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 10, stream: false });
    assert.strictEqual(r.content[0].text, 'OK', 'Minutenlimit: nach Pause erholt');
    assert.strictEqual(r.retries, 1);
    assert.ok(waits[0] >= 3000, `wartet die von Google verlangten 3 s (${waits[0]})`);

    const perDay = createMock('gemini', { models: ALIASES, quota429: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', retryDelay: '50000s' });
    const gd = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: perDay.fetchImpl });
    const e = await gd.streamMessage({ apiKey: KEY, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }).catch((x) => x);
    assert.strictEqual(e.category, 'rate_limit', 'Tageslimit pro Modell ist kein leeres Guthaben');
    assert.strictEqual(e.type, 'rate_limit_day');
    assert.match(e.message, /Tageslimit/);
    assert.strictEqual(genCalls(perDay).length, 1, 'Tageslimit: kein sinnloses Warten');
    assert.ok(fallback.canFallback(e), 'anderes Modell hat eigenes Limit');

    const longWait = createMock('gemini', { models: ALIASES, quota429: 'GenerateRequestsPerMinutePerProjectPerModel', retryDelay: '45s' });
    const gl = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: longWait.fetchImpl });
    await gl.streamMessage({ apiKey: KEY, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }).catch((x) => x);
    assert.strictEqual(genCalls(longWait).length, 1, 'verlangte Pause > 20 s: nicht blockieren');
  } finally { slow(); }

  // ---------- 5. Streaming: Abbruch, Fehler mitten im Stream, Reihenfolge ----------
  {
    const cut = createMock('gemini', { models: ALIASES, truncate: true });
    const g = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: cut.fetchImpl });
    const e = await g.streamMessage({ apiKey: KEY, model: 'gemini-flash-lite-latest', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 }).catch((x) => x);
    assert.ok(e instanceof errors.ProviderError, 'abgerissener Stream ist keine fertige Antwort');
    assert.strictEqual(e.type, 'stream_incomplete');
    assert.strictEqual(e.status, 0, 'Agent startet die Runde neu');
    assert.strictEqual(e.stage, 'stream');
    assert.match(e.message, /mitten in der Antwort/);

    const mid = createMock('gemini', { models: ALIASES, midStream: ['gemini-flash-lite-latest'] });
    const gm = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: mid.fetchImpl });
    let seen = '';
    const e2 = await gm.streamMessage({ apiKey: KEY, model: 'gemini-flash-lite-latest', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, onText: (x) => { seen += x; } }).catch((x) => x);
    assert.strictEqual(e2.category, 'overloaded');
    assert.strictEqual(e2.stage, 'stream');
    assert.ok(seen.length > 0, 'es kam schon Text an (wird im Agenten zurückgenommen)');

    const okMock = createMock('gemini', { models: ALIASES });
    const go = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: okMock.fetchImpl });
    let pieces = [];
    const r = await go.streamMessage({ apiKey: KEY, model: 'gemini-flash-lite-latest', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, onText: (x) => pieces.push(x) });
    assert.ok(pieces.length > 1, 'mehrere Stücke');
    assert.strictEqual(pieces.join(''), r.content[0].text, 'Stücke in richtiger Reihenfolge ergeben die Antwort');

    // Abbruch durch den Nutzer
    const ctl = new AbortController();
    const hang = createMock('gemini', { models: ALIASES, hang: true });
    const gh = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: hang.fetchImpl });
    const p = gh.streamMessage({ apiKey: KEY, model: 'gemini-flash-lite-latest', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, signal: ctl.signal }).catch((x) => x);
    ctl.abort();
    assert.strictEqual((await p).name, 'AbortError', 'Abbrechen ist kein Fehler');
  }

  // ---------- 6. Denkstufe bei Aliassen, Funktions-IDs ----------
  {
    reset();
    const { mock, client } = registry();
    await client.listModels(KEY);
    await client.streamMessage({ apiKey: KEY, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, stream: false });
    assert.strictEqual(genCalls(mock)[0].body.generationConfig.thinkingConfig?.thinkingLevel, 'low', 'Alias bekommt thinkingLevel (sonst denkt Gemini 3 auf «high»)');
    assert.strictEqual(models.capabilities('gemini-flash-latest').reasoning, true, 'aus der Modellliste: thinking');

    reset();
    const old = registry({ noThinkingLevel: ['gemini-flash-latest'] });
    const r = await old.client.streamMessage({ apiKey: KEY, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, stream: false });
    assert.strictEqual(r.content[0].text, 'OK', 'Alias auf älterer Version: ohne thinkingLevel weiter');
    assert.strictEqual(learned.get('gemini', 'gemini-flash-latest', 'noThinkingLevel'), true, 'nur einmal ausprobieren');

    const conv = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {}, meta: { provider: 'gemini', callId: 'fc_9', thoughtSignature: 's' } }, { type: 'tool_use', id: 't2', name: 'a', input: {}, meta: { provider: 'gemini', callId: 'fc_10' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1' }, { type: 'tool_result', tool_use_id: 't2', content: '2' }] },
    ];
    const c = toContents(conv, { vision: true });
    assert.deepStrictEqual(c[2].parts.map((p) => p.functionResponse.id), ['fc_9', 'fc_10'], 'Antworten nennen die Aufruf-ID');

    // Ganze Werkzeug-Runde mit IDs, sequenziell und parallel
    const ids = registry({ callIds: true });
    const h = await runHealth({ client: ids.client, providerId: 'gemini', apiKey: KEY, models: ['gemini-flash-latest'] });
    assert.ok(['tools', 'parallel'].every((id) => h.steps.find((s) => s.id === id).status === 'ok'), `IDs passen: ${JSON.stringify(h.steps.map((s) => [s.id, s.status, s.error?.message]))}`);
  }

  // ---------- 7. Ausweichkandidaten (dynamisch aus der Modellliste) ----------
  {
    reset();
    const list = ALIASES.map((id) => ({ id }));
    assert.deepStrictEqual(fallback.candidates({ providerId: 'gemini', failed: 'gemini-flash-latest', available: list }), ['gemini-flash-lite-latest', 'gemini-pro-latest'], 'Flash → Flash-Lite, dann Pro');
    assert.deepStrictEqual(fallback.candidates({ providerId: 'gemini', failed: 'gemini-pro-latest', available: list }), ['gemini-flash-latest', 'gemini-flash-lite-latest']);
    assert.deepStrictEqual(fallback.candidates({ providerId: 'gemini', failed: 'gemini-flash-latest', available: list, maxTier: 'sonnet' }), ['gemini-flash-lite-latest'], 'Budget: nicht teurer');
    assert.deepStrictEqual(fallback.candidates({ providerId: 'gemini', failed: 'gemini-flash-latest', available: list, preferred: ['gemini-pro-latest'] })[0], 'gemini-pro-latest', 'Einstellung zuerst');
    assert.deepStrictEqual(fallback.candidates({ providerId: 'gemini', failed: 'gemini-flash-latest', available: [] }), [], 'ohne Modellliste keine Behauptung');
    assert.deepStrictEqual(fallback.candidates({ providerId: 'gemini', failed: 'gemini-flash-latest', available: list, needComputer: true }), [], 'PC-Steuerung gibt es nur bei Claude');
    learned.set('gemini', 'gemini-flash-lite-latest', 'unavailable', true);
    assert.deepStrictEqual(fallback.candidates({ providerId: 'gemini', failed: 'gemini-flash-latest', available: list }), ['gemini-pro-latest'], 'abgeschaltete Modelle nie');
    reset();
    assert.strictEqual(fallback.retriesFor({ providerId: 'gemini', model: 'x', hasFallback: false }), undefined);
    assert.strictEqual(fallback.retriesFor({ providerId: 'gemini', model: 'x', hasFallback: true }), 1);
    fallback.markBusy('gemini', 'x');
    assert.strictEqual(fallback.retriesFor({ providerId: 'gemini', model: 'x', hasFallback: true }), 0, 'nach Störung: sofort ausweichen');
    assert.ok(!fallback.isBusy('gemini', 'x', Date.now() + fallback.COOLDOWN_MS + 1), 'Abkühlzeit läuft ab');
    // Andere Anbieter: Claude Sonnet überlastet → Haiku
    assert.deepStrictEqual(fallback.candidates({ providerId: 'anthropic', failed: 'claude-sonnet-5-5', available: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] })[0], 'claude-haiku-5-5');
  }

  // ---------- 8. Agent: Ausweichmodell bei 503 (das gemeldete Fehlerbild) ----------
  fast();
  try {
    reset();
    const settings = { autoModel: false, model: 'gemini-flash-latest', effort: 'auto', confirmControl: false, permissions: {} };
    const { mock, client } = registry({ unavailable: ['gemini-flash-latest'] });
    const a = agentFor(client, settings);
    await a.run('Wie geht es dir?');
    assert.ok(!errorOf(a.events), `Antwort statt Fehler: ${errorOf(a.events)?.message}`);
    assert.match(textOf(a.events), /Hallo/);
    const notice = a.events.find((e) => e.c === 'chat:notice' && /Flash-Lite/.test(e.p.text));
    assert.ok(notice, 'Wechsel wird offen gesagt (nicht still)');
    assert.match(notice.p.text, /überlastet/);
    assert.match(notice.p.text, /Modellwahl bleibt/);
    const route = a.events.find((e) => e.c === 'agent:route' && e.p.fallbackFrom);
    assert.strictEqual(route.p.fallbackFrom, 'gemini-flash-latest');
    assert.strictEqual(route.p.model, 'gemini-flash-lite-latest', 'App erfährt das tatsächlich benutzte Modell');
    assert.strictEqual(settings.model, 'gemini-flash-latest', 'Einstellung bleibt unverändert');
    assert.strictEqual(genCalls(mock, 'gemini-flash-latest').length, 2, 'gewähltes Modell: 1 Versuch + 1 Wiederholung');
    assert.ok(a.logs.some((l) => /Ausweichmodell: gemini-flash-latest overloaded \(503, 1 Wiederholungen\)/.test(l)), 'Diagnose im Protokoll');

    // Nächste Nachricht: gewähltes Modell wieder zuerst, aber ohne langes Warten
    const before = genCalls(mock, 'gemini-flash-latest').length;
    const b = agentFor(client, settings);
    await b.run('Und jetzt?');
    assert.ok(!errorOf(b.events));
    assert.strictEqual(genCalls(mock, 'gemini-flash-latest').length - before, 1, 'nach Störung: ein Versuch, dann gleich ausweichen');

    // Ausschalten: klare Fehlermeldung, kein anderes Modell
    reset();
    const off = registry({ unavailable: ['gemini-flash-latest'] });
    const c = agentFor(off.client, { ...settings, modelFallback: false });
    await c.run('Wie geht es dir?');
    const e = errorOf(c.events);
    assert.ok(e && e.error.category === 'overloaded', `Fehler gemeldet: ${e?.message}`);
    assert.match(e.message, /überlastet/);
    assert.ok(genCalls(off.mock).every((q) => q.path.includes('gemini-flash-latest')), 'ausgeschaltet: nur das gewählte Modell');

    // Ungültiger Key: nie ausweichen
    reset();
    const keyBad = registry({ unavailable: ['gemini-flash-latest'] });
    const d = agentFor(keyBad.client, { ...settings, key: 'AIza-falsch' }); // pragma: allowlist secret
    await d.run('hi');
    assert.strictEqual(errorOf(d.events)?.error.category, 'auth');
    assert.ok(!d.events.some((x) => x.c === 'chat:notice' && /antwortet diesmal/.test(x.p.text)), 'kein Ausweichen bei falschem Key');

    // Alles überlastet: begrenzte Versuche, dann ehrliche Meldung
    reset();
    const all = registry({ unavailable: ALIASES });
    const f = agentFor(all.client, settings);
    await f.run('hi');
    assert.strictEqual(errorOf(f.events)?.error.category, 'overloaded');
    assert.ok(genCalls(all.mock).length <= 2 + fallback.MAX_FALLBACKS * 2, `keine endlosen Versuche (${genCalls(all.mock).length})`);

    // Automatische Modellwahl: auch dort ausweichen
    reset();
    const auto = registry({ unavailable: ['gemini-flash-latest', 'gemini-flash-lite-latest'] });
    const g = agentFor(auto.client, { autoModel: true, effort: 'auto', confirmControl: false, permissions: {} });
    await g.run('Call get_number twice in parallel, once with key "a" and once with key "b". Then reply with both numbers.');
    assert.ok(!errorOf(g.events), `Automatik: ${errorOf(g.events)?.message}`);
    assert.match(textOf(g.events), /11, 22/, 'Werkzeug-Schleife läuft mit dem Ausweichmodell weiter');
    const after = genCalls(auto.mock).map((q) => q.path.split('/models/')[1].split(':')[0]);
    const firstPro = after.indexOf('gemini-pro-latest');
    assert.ok(firstPro >= 0 && after.slice(firstPro).every((m) => m === 'gemini-pro-latest'), `nach dem Wechsel bleibt die Aufgabe beim Ausweichmodell (${after})`);

    // Andere Anbieter (Claude 529, OpenAI 503): gleiches Verhalten, keine Regression
    for (const [pid, busyModel, alt] of [['anthropic', 'claude-sonnet-5-5', 'Haiku'], ['openai', 'gpt-6.1-terra', 'GPT-6 Luna']]) {
      reset();
      const mock = createMock(pid, { busy: [busyModel] });
      const llm = createLlm({ fetchImpl: mock.fetchImpl, scriptDir: '/tmp', getPythonRuntime: async () => null, log: () => {} });
      const client = llm.client(pid);
      const events = [];
      const usage = createUsage({});
      const ag = createAgent({
        claude: client, getClient: () => client, getProvider: () => pid, log: () => {},
        router: createRouter({ claude: client, usage }), usage, history: createHistory({}),
        getKey: () => GOOD_KEY[pid], getSettings: () => ({ autoModel: false, model: busyModel, effort: 'auto', confirmControl: false, permissions: {} }),
        getTools: () => ({ definitions: [], run: async () => ({ text: '' }), describe: () => '' }),
        getComputer: () => ({ describe: (n) => n, run: async () => [], warmUp() {}, stop() {} }), getFiles: () => null,
        isComputerAvailable: () => false, getAvailableModels: async () => client.listModels(GOOD_KEY[pid]).catch(() => []),
        getGame: () => ({ active: false }), systemPrompt: () => 'Du bist Buddy.', askControl: async () => true, askPermission: async () => true, onAuthError: () => {},
      });
      await ag.run({ id: 'x', messages: [{ role: 'user', content: 'Wie geht es dir?' }], send: (c, p) => events.push({ c, p }), signal: new AbortController().signal });
      assert.ok(!errorOf(events), `${pid}: ${errorOf(events)?.message}`);
      assert.ok(events.some((e) => e.c === 'chat:notice' && e.p.text.includes(alt)), `${pid}: Ausweichen auf ${alt} wird gesagt`);
      assert.ok(mock.state.busyHits <= 2, `${pid}: nicht lange gewartet (${mock.state.busyHits} Versuche)`);
    }
  } finally { slow(); }

  // ---------- 9. Agent: Fehler mitten im Stream beschädigt die Unterhaltung nicht ----------
  fast();
  try {
    reset();
    const { client } = registry({ midStream: ['gemini-flash-latest'] });
    const a = agentFor(client, { autoModel: false, model: 'gemini-flash-latest', effort: 'auto', confirmControl: false, permissions: {} });
    await a.run('Wie geht es dir?');
    assert.ok(!errorOf(a.events), `${errorOf(a.events)?.message}`);
    const rewind = a.events.find((e) => e.c === 'chat:rewind');
    assert.ok(rewind && rewind.p.chars > 0, 'angefangener Text wird zurückgenommen');
    const deltas = a.events.filter((e) => e.c === 'chat:delta' || e.c === 'chat:rewind');
    let shown = '';
    for (const e of deltas) shown = e.c === 'chat:rewind' ? shown.slice(0, shown.length - e.p.chars) : shown + e.p.text;
    assert.strictEqual(shown, 'Hallo! Wie kann ich helfen?', 'sichtbar bleibt genau eine vollständige Antwort');
  } finally { slow(); }

  // ---------- 10. Verbindungstest: unabhängige Schritte, Status, Ausweichmodell ----------
  fast();
  try {
    reset();
    const { client } = registry({ unavailable: ['gemini-flash-latest'] });
    const logs = [];
    const r = await runHealth({ client, providerId: 'gemini', apiKey: KEY, models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], log: (l) => logs.push(l) });
    const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
    assert.strictEqual(by['basic:gemini-flash-latest'].status, 'unavailable', '503 = temporär nicht verfügbar');
    assert.strictEqual(by['basic:gemini-flash-latest'].diag.retries, 1, 'Wiederholungen werden gezählt');
    assert.strictEqual(by['basic:gemini-flash-latest'].diag.httpStatus, 503);
    assert.strictEqual(by['basic:gemini-flash-lite-latest'].status, 'ok');
    assert.strictEqual(by.fallback.status, 'ok', 'Ausweichmodell bereit');
    for (const id of ['stream', 'history', 'tools', 'parallel', 'json']) {
      assert.strictEqual(by[id].status, 'ok', `${id} trotzdem geprüft: ${by[id].error?.message || by[id].note}`);
    }
    assert.strictEqual(by.stream.fallbackModel, 'gemini-flash-lite-latest', 'mit dem funktionierenden Modell geprüft');
    assert.strictEqual(r.status, 'limited', 'Gesamt: eingeschränkt, nicht «Fehler»');
    const report = healthReport([{ ...r, providerName: 'Google Gemini' }]);
    assert.match(report, /## Google Gemini: Eingeschränkt/);
    assert.match(report, /Temporär nicht verfügbar/);
    assert.match(report, /Ausweichmodell gemini-flash-lite-latest/);
    assert.match(report, /API v1beta/);
    assert.ok(!report.includes(KEY) && !logs.join('\n').includes(KEY), 'kein Key in Bericht und Log');
    assert.ok(logs.some((l) => /provider=gemini model=gemini-flash-latest api=v1beta typ=generate dauer=\d+ms http=503 fehler=overloaded\/UNAVAILABLE retries=1 ausweich=- status=unavailable erfolg=false/.test(l)), `Logzeile: ${logs[2]}`);

    // Alles gut → «Funktioniert»
    reset();
    const good = registry();
    const r2 = await runHealth({ client: good.client, providerId: 'gemini', apiKey: KEY, models: ['gemini-flash-latest', 'gemini-flash-lite-latest'] });
    assert.strictEqual(r2.status, 'ok', JSON.stringify(r2.steps.filter((s) => s.status !== 'ok').map((s) => [s.id, s.status])));
    assert.ok(!r2.steps.some((s) => s.id === 'fallback'), 'Ausweich-Schritt nur bei Störung');

    // Falscher Key → Konfigurationsfehler, kein sinnloses Weitertesten
    const bad = registry();
    const r3 = await runHealth({ client: bad.client, providerId: 'gemini', apiKey: 'AIza-falsch', models: ['gemini-flash-latest'] }); // pragma: allowlist secret
    assert.strictEqual(r3.status, 'config');
    assert.strictEqual(bad.mock.state.requests.length, 1, 'nur die Modellliste');

    // Integrationsfehler im Streaming: die anderen Schritte laufen trotzdem
    const real = registry().client;
    const broken = {
      ...real,
      streamMessage: async (req) => {
        if (req.stream !== false) throw new errors.ProviderError(400, 'Invalid JSON payload received. Unknown name "x"', 'INVALID_ARGUMENT', 'Gemini', { model: req.model });
        return real.streamMessage(req);
      },
    };
    const r4 = await runHealth({ client: broken, providerId: 'gemini', apiKey: KEY, models: ['gemini-flash-latest'] });
    const s4 = Object.fromEntries(r4.steps.map((s) => [s.id, s.status]));
    assert.strictEqual(s4.stream, 'error', 'Streaming: Fehler in der Integration');
    assert.strictEqual(s4.history, 'ok', 'Verlauf trotzdem geprüft');
    assert.strictEqual(s4.tools, 'ok', 'Werkzeuge trotzdem geprüft');
    assert.strictEqual(r4.status, 'limited');

    // Modell ohne Werkzeuge: «nicht unterstützt», nicht «defekt»
    const plain = {
      provider: 'huggingface', listModels: async () => [],
      json: async () => { throw new Error('nicht gebraucht'); },
      streamMessage: async (req) => { req.onText?.('O'); req.onText?.('K'); return { stopReason: 'end_turn', usage: {}, content: [{ type: 'text', text: req.messages.some((m) => /APFEL/.test(String(m.content))) ? 'APFEL' : 'OK' }] }; },
    };
    const r5 = await runHealth({ client: plain, providerId: 'huggingface', apiKey: 'lokal', models: ['hf:Qwen/Qwen2.5-0.5B-Instruct'] });
    const s5 = Object.fromEntries(r5.steps.map((s) => [s.id, s.status]));
    assert.strictEqual(s5.tools, 'unsupported');
    assert.strictEqual(s5.parallel, 'unsupported');
    assert.strictEqual(r5.status, 'ok', 'lokales Modell ohne Werkzeuge funktioniert');
    assert.strictEqual(overallStatus([{ id: 'a', label: '', ok: false, status: 'unavailable' }]), 'unavailable');
  } finally { slow(); }

  // ---------- 11. Fähigkeiten pro Modell, nicht pro Anbieter ----------
  {
    const c = models.capabilities('claude-sonnet-5-5');
    assert.ok(c.chat && c.streaming && c.history && c.tools && c.parallelTools && c.structured && c.json && c.vision && c.reasoning && c.computerUse);
    const g4 = models.capabilities('gpt-4o');
    assert.ok(g4.tools && !g4.reasoning && !g4.computerUse, 'GPT-4o denkt nicht');
    assert.ok(models.capabilities('gpt-6.1-sol').reasoning && models.capabilities('grok-4.3').reasoning, 'GPT-6 und Grok 4.3 denken');
    const hf = models.capabilities('hf:Qwen/Qwen2.5-1.5B-Instruct');
    assert.ok(hf.chat && hf.streaming && hf.history && !hf.tools && !hf.parallelTools && !hf.vision && !hf.structured);
    models.rememberMeta('gemini', 'gemini-9-nothink', { thinking: false });
    assert.strictEqual(models.capabilities('gemini-9-nothink').reasoning, false, 'Metadaten aus der Modellliste gehen vor');
  }

  console.log('Ausfall-Tests ok (simuliert: 503-Ausweichmodell, 429, Backoff, Stream-Abbruch, Funktions-IDs, Verbindungstest, Fähigkeiten)');
})().catch((e) => { slow(); console.error(e); process.exit(1); });
