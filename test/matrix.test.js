// Globale Test-Matrix der KI-Kommunikation: jeder Anbieter einzeln über die echte gemeinsame
// Schicht (Registry, Adapter, Router, Agent) gegen simulierte Anbieter mit echtem Protokoll.
const assert = require('assert');
const { createMock, GOOD_KEY } = require('./mock-providers');
const { createLlm } = require('../src/llm');
const { runHealth, healthReport } = require('../src/llm/health');
const { createGeminiClient, toContents } = require('../src/llm/gemini');
const { createOpenAiResponsesClient } = require('../src/llm/openai-responses');
const { createOpenAiCompatClient } = require('../src/llm/openai-compat');
const { publicError } = require('../src/llm/errors');
const models = require('../src/models');
const { createAgent } = require('../src/agent');
const { createRouter } = require('../src/router');
const { createUsage } = require('../src/usage');
const { createHistory } = require('../src/history');

const PROVIDERS = ['anthropic', 'openai', 'xai', 'gemini'];
const NAME = { anthropic: 'Claude', openai: 'OpenAI', xai: 'Grok', gemini: 'Gemini' };

// Wartezeiten der Wiederholungen im Test verkürzen
const realSetTimeout = global.setTimeout;
const fast = () => { global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a); };
const slow = () => { global.setTimeout = realSetTimeout; };

function registry(provider, mockOpts) {
  const mock = createMock(provider, mockOpts);
  const logs = [];
  const llm = createLlm({ fetchImpl: mock.fetchImpl, scriptDir: '/tmp', getPythonRuntime: async () => null, log: (m) => logs.push(m) });
  return { mock, llm, client: llm.client(provider), logs };
}

/** Agent wie in main.js, aber mit simulierten Anbietern */
function agentFor(provider, client, settings = {}, extra = {}) {
  const events = [];
  const authErrors = [];
  const usage = createUsage({});
  const agent = createAgent({
    claude: client, getClient: () => client, getProvider: () => provider,
    router: createRouter({ claude: client, usage }), usage, history: createHistory({}),
    getKey: () => extra.key || GOOD_KEY[provider], getSettings: () => ({ autoModel: true, effort: 'auto', confirmControl: false, permissions: {}, ...settings }),
    getTools: () => ({
      definitions: [{ name: 'get_number', description: 'Returns a number for a key.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
      run: async (name, input) => { toolRuns.push(input.key); return { text: input.key === 'b' ? '22' : '11' }; }, describe: () => 'Zahl',
    }),
    getComputer: () => ({ describe: (n) => n, run: async () => [], warmUp() {}, stop() {} }), getFiles: () => null,
    isComputerAvailable: () => false, getAvailableModels: async (pid) => (await client.listModels(GOOD_KEY[pid] || 'x').catch(() => [])),
    getGame: () => ({ active: false }),
    systemPrompt: (withComputer, opts) => `Du bist Buddy.${opts?.extra || ''}`, // wie main.js: Zusatz (Regeln, Gedächtnis) vor der Uhrzeit
    askControl: async () => true, askPermission: async () => true,
    onAuthError: (pid) => authErrors.push(pid),
    getMemoryContext: extra.memory ? (text) => extra.memory.context(text) : undefined,
  });
  const run = (messages) => agent.run({ id: `r${Math.random()}`, messages: typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages, send: (c, p) => events.push({ c, p }), signal: new AbortController().signal });
  return { events, authErrors, run };
}
const toolRuns = [];
const textOf = (events) => events.filter((e) => e.c === 'chat:delta').map((e) => e.p.text).join('');
const errorOf = (events) => events.find((e) => e.c === 'chat:error')?.p;

(async () => {
  for (const provider of PROVIDERS) {
    const key = GOOD_KEY[provider];
    const tiers = models.resolveTiers(await registry(provider).client.listModels(key), provider);
    const main = tiers.sonnet;
    assert.ok(main, `${provider}: Modell für «sonnet» gefunden`);

    // 1.–8. Verbindungstest: einfache Antwort ohne Streaming, Streaming, Verlauf, Werkzeuge mit
    // Fortsetzung, parallele Werkzeuge, strukturierte Antwort. Für jedes benutzte Modell.
    {
      const { client } = registry(provider);
      const ids = [...new Set([main, tiers.haiku].filter(Boolean))];
      const r = await runHealth({ client, providerId: provider, apiKey: key, models: ids });
      const failed = r.steps.filter((s) => s.ok !== true);
      assert.deepStrictEqual(failed.map((s) => `${s.id}: ${s.error?.message || s.note}`), [], `${provider}: alle Stufen ok`);
      assert.ok(r.steps.find((s) => s.id === 'parallel').note.includes('2'), `${provider}: zwei parallele Aufrufe`);
      assert.ok(!/good/.test(healthReport([r])), 'Bericht enthält keinen Key');
    }

    // Gemini 3: Signaturen müssen sequenziell und parallel zurückkommen
    if (provider === 'gemini') {
      const { client, mock } = registry('gemini');
      const r = await runHealth({ client, providerId: 'gemini', apiKey: key, models: ['gemini-3-flash'] });
      assert.ok(r.ok, `gemini-3: ${r.steps.filter((s) => !s.ok).map((s) => s.error?.message || s.note).join('; ')}`);
      const cont = mock.state.requests.filter((q) => q.body?.contents?.some((c) => c.parts.some((p) => p.functionResponse)));
      assert.ok(cont.length >= 2, 'Fortsetzungen wurden geschickt');
      for (const q of cont) {
        const callTurn = q.body.contents.find((c) => c.parts.some((p) => p.functionCall));
        assert.match(callTurn.parts[0].thoughtSignature, /^gsig_/, 'erste Funktion trägt die echte Signatur');
        assert.ok(callTurn.parts.slice(1).every((p) => !p.thoughtSignature), 'weitere parallele Aufrufe ohne Signatur');
        assert.ok(!JSON.stringify(q.body).includes('"meta"'), 'keine internen Felder an Gemini');
      }
      // Aufrufe aus einem anderen Anbieter (ohne Signatur) werden mit dem erlaubten Ersatzwert markiert
      const foreign = toContents([
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_number', input: { key: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '11' }] },
      ], { vision: true });
      assert.strictEqual(foreign[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
      assert.deepStrictEqual(foreign[2].parts[0].functionResponse, { name: 'get_number', response: { result: '11' } });
    }

    // 9. Agent: «hi» mit automatischer Modellwahl (Router, Werkzeuge an, Streaming)
    {
      const { client } = registry(provider);
      const a = agentFor(provider, client);
      await a.run('hi');
      assert.ok(!errorOf(a.events), `${provider}: «hi» ohne Fehler: ${errorOf(a.events)?.message}`);
      assert.match(textOf(a.events), /Hallo/, `${provider}: Antwort kommt an`);
      assert.ok(a.events.some((e) => e.c === 'chat:done'));
    }

    // 10. Manuelle Modellwahl
    {
      const { client, mock } = registry(provider);
      const manual = tiers.haiku || main;
      const a = agentFor(provider, client, { autoModel: false, model: manual });
      await a.run('Wie geht es dir?');
      assert.ok(!errorOf(a.events), `${provider}: manuell ohne Fehler`);
      const used = mock.state.requests.filter((q) => q.body?.model || /:(stream)?[gG]enerateContent/.test(q.path)).map((q) => q.body?.model || decodeURIComponent(q.path.split('/models/')[1].split(':')[0]));
      assert.ok(used.every((m) => m === manual), `${provider}: nur das gewählte Modell (${used})`);
    }

    // 11. Werkzeug-Schleife über den Agenten (sequenziell und parallel), dann Folgefrage mit Verlauf
    {
      const { client } = registry(provider);
      const a = agentFor(provider, client);
      await a.run('Call get_number twice in parallel, once with key "a" and once with key "b". Then reply with both numbers.');
      assert.ok(!errorOf(a.events), `${provider}: Werkzeug-Schleife: ${errorOf(a.events)?.message}`);
      assert.match(textOf(a.events), /11, 22/, `${provider}: Ergebnisse beider Aufrufe`);
      // Neue Unterhaltung nach «Neustart»: frische Registry, Verlauf nur als Text
      const fresh = registry(provider);
      const b = agentFor(provider, fresh.client);
      await b.run([{ role: 'user', content: 'Remember the codeword APFEL.' }, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'What is the codeword?' }]);
      assert.match(textOf(b.events), /APFEL/, `${provider}: Verlauf nach Neustart`);
    }

    // 12. Ungültiger Key: richtige Kategorie, richtiger Anbieter, nur dessen Key wird gesperrt
    {
      const { client } = registry(provider);
      const a = agentFor(provider, client, {}, { key: 'falsch' });
      await a.run('hi');
      const e = errorOf(a.events);
      assert.ok(e, `${provider}: Fehler gemeldet`);
      assert.strictEqual(e.error.category, 'auth', `${provider}: Kategorie auth (${e.error.category}: ${e.message})`);
      assert.strictEqual(e.error.providerId, provider);
      assert.match(e.message, new RegExp(NAME[provider]), `${provider}: Meldung nennt den richtigen Anbieter: ${e.message}`);
      assert.deepStrictEqual(a.authErrors, [provider], 'nur dieser Anbieter');
      assert.ok(!JSON.stringify(e).includes('falsch'), 'Key steht nicht in der Fehlermeldung');
    }

    // 13. Unbekanntes Modell
    {
      const { client } = registry(provider);
      const err = await client.streamMessage({ apiKey: key, model: 'gibt-es-nicht-9', messages: [{ role: 'user', content: 'hi' }], maxTokens: 20 }).catch((x) => x);
      assert.strictEqual(err.category, 'model', `${provider}: unbekanntes Modell (${err.category}: ${err.message})`);
      assert.strictEqual(err.model, 'gibt-es-nicht-9');
      assert.strictEqual(publicError(err).provider, NAME[provider]);
    }

    // 14. Rate-Limit und Netzwerkfehler einmal, dann Erfolg (mit Wiederholung)
    fast();
    try {
      for (const failOnce of [{ rate: 1 }, { network: 1 }]) {
        const { client } = registry(provider, { failOnce });
        let retries = 0;
        const r = await client.streamMessage({ apiKey: key, model: main, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, onRetry: () => { retries += 1; } });
        assert.strictEqual(r.content.find((b) => b.type === 'text').text, 'OK', `${provider}: nach ${Object.keys(failOnce)[0]} erholt`);
        assert.strictEqual(retries, 1);
      }
    } finally {
      slow();
    }
  }

  // ---------- Anbieter-spezifisch ----------

  // OpenAI ohne verifizierte Organisation: Streaming gesperrt → automatisch ohne Streaming
  {
    const { client, mock } = registry('openai', { verifyStream: true });
    let streamed = '';
    const r = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6.1-terra', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, onText: (x) => { streamed += x; } });
    assert.strictEqual(r.content[0].text, 'OK');
    assert.strictEqual(streamed, 'OK', 'Text kommt trotzdem in der Oberfläche an');
    assert.deepStrictEqual(mock.state.requests.filter((q) => q.body).map((q) => q.body.stream), [true, false]);
    assert.ok(mock.state.requests.every((q) => !q.body || q.path.endsWith('/responses')), 'OpenAI läuft über die Responses API');
    assert.ok(mock.state.requests.every((q) => !q.body || ('max_output_tokens' in q.body && q.body.store === false)), 'max_output_tokens, nichts gespeichert');
  }

  // Zeitüberschreitung: richtig eingeordnet, mit Anbieter und Stufe
  {
    const g = createGeminiClient({ provider: models.PROVIDERS.gemini, fetchImpl: createMock('gemini', { hang: true }).fetchImpl, connectTimeoutMs: 30 });
    fast();
    const err = await g.streamMessage({ apiKey: GOOD_KEY.gemini, model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }).catch((x) => x);
    slow();
    assert.strictEqual(err.category, 'timeout');
    assert.strictEqual(err.stage, 'connect');
    assert.match(err.message, /Gemini/);
    const o = createOpenAiResponsesClient({ provider: models.PROVIDERS.openai, fetchImpl: createMock('openai', { hang: true }).fetchImpl, connectTimeoutMs: 30 });
    fast();
    const err2 = await o.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }).catch((x) => x);
    slow();
    assert.strictEqual(err2.category, 'timeout');
    assert.match(err2.message, /OpenAI/, 'eine OpenAI-Störung heisst nie «Gemini»');
  }

  // Ein Anbieter mit Fehler bremst die anderen nicht: Gemini mit falschem Key, OpenAI läuft weiter
  {
    const gem = registry('gemini');
    const oa = registry('openai');
    const bad = await gem.client.streamMessage({ apiKey: 'AIza-falsch', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], maxTokens: 20 }).catch((x) => x); // pragma: allowlist secret
    assert.strictEqual(bad.category, 'auth');
    assert.strictEqual(bad.provider, 'Gemini');
    const ok = await oa.client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 20 });
    assert.strictEqual(ok.content[0].text, 'OK');
    assert.ok(gem.logs.some((l) => /provider=gemini .*category=auth/.test(l)), 'Diagnose im Protokoll');
    assert.ok(!gem.logs.join('').includes('AIza-falsch'), 'kein Key im Protokoll');
  }

  // Anbieterwechsel: Blöcke mit Gemini-Metadaten gehen sauber an Claude (ohne «meta»)
  {
    const { client, mock } = registry('anthropic');
    const r = await client.streamMessage({
      apiKey: GOOD_KEY.anthropic, model: 'claude-haiku-5-5', maxTokens: 50,
      messages: [
        { role: 'user', content: 'Reply with OK.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Gern.', meta: { provider: 'gemini', thoughtSignature: 'x' } }] },
        { role: 'user', content: 'Reply with OK.' },
      ],
    });
    assert.strictEqual(r.content[0].text, 'OK');
    assert.ok(!JSON.stringify(mock.state.requests[0].body).includes('"meta"'));
  }

  // Wechsel zwischen Anbietern im Agenten: gleicher Text-Verlauf, jeder Anbieter mit eigenem Protokoll
  {
    const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hallo! Wie kann ich helfen?' }, { role: 'user', content: 'Remember the codeword APFEL.' }, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'What is the codeword?' }];
    for (const provider of PROVIDERS) {
      const { client } = registry(provider);
      const a = agentFor(provider, client);
      await a.run(history);
      assert.match(textOf(a.events), /APFEL/, `${provider}: Verlauf nach Wechsel`);
    }
  }

  // Gedächtnis im Agenten: nur passende Einträge gehen an die KI
  {
    const { createMemory } = require('../src/memory');
    const os = require('os'); const fs = require('fs'); const path = require('path');
    const memFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-')), 'm.json');
    const mem = createMemory({ file: memFile });
    mem.setUserText('Merk dir, dass ich Tee mag'); mem.add('Mag Tee lieber als Kaffee');
    const { client, mock } = registry('gemini');
    const a = agentFor('gemini', client, {}, { memory: mem });
    await a.run('Soll ich Tee oder Kaffee trinken?');
    const sys = mock.state.requests.filter((q) => q.body?.systemInstruction).map((q) => q.body.systemInstruction.parts[0].text);
    assert.ok(sys.some((x) => /Mag Tee lieber als Kaffee/.test(x)), 'passender Eintrag im System-Prompt');
    const m2 = registry('gemini');
    const b = agentFor('gemini', m2.client, {}, { memory: mem });
    await b.run('Stell einen Timer auf 5 Minuten');
    assert.ok(m2.mock.state.requests.every((q) => !JSON.stringify(q.body || {}).includes('Mag Tee')), 'unpassender Eintrag bleibt draussen');
  }

  // Zwei identische Aufrufe in einer Antwort: nur einmal ausgeführt, Fortsetzung bleibt gültig
  for (const provider of ['anthropic', 'openai', 'gemini']) {
    toolRuns.length = 0;
    const { client } = registry(provider);
    const a = agentFor(provider, client);
    await a.run('Call get_number identical twice with key "a".');
    assert.ok(!errorOf(a.events), `${provider}: doppelter Aufruf ohne Fehler: ${errorOf(a.events)?.message}`);
    assert.deepStrictEqual(toolRuns, ['a'], `${provider}: nur einmal ausgeführt`);
  }

  // ---------- Modellverfügbarkeit ----------
  // Abgeschaltetes Modell (in der Liste, aber 404): Automatik nimmt einmal ein Ersatzmodell und sagt es
  {
    const { client, mock } = registry('openai', { retired: ['gpt-6-luna'] });
    const a = agentFor('openai', client);
    await a.run('hi');
    assert.ok(!errorOf(a.events), `Ersatzmodell statt Fehler: ${errorOf(a.events)?.message}`);
    assert.match(textOf(a.events), /Hallo/);
    const notice = a.events.find((e) => e.c === 'chat:notice' && /nicht verfügbar/.test(e.p.text));
    assert.ok(notice, 'Wechsel wird offen gesagt');
    const used = mock.state.requests.filter((q) => q.body?.model).map((q) => q.body.model);
    assert.ok(used.includes('gpt-6-luna') && used[used.length - 1] !== 'gpt-6-luna', `danach anderes Modell (${used})`);
  }
  // Gemini «high demand» (503) auf dem Hauptmodell: Test zeigt «Eingeschränkt» (Hauptmodell temporär nicht
  // verfügbar) und testet mit dem anderen Modell weiter; im Chat weicht Buddy nach einem kurzen Versuch aus und sagt es offen
  {
    require('../src/llm/learned').clear();
    const list = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'];
    const { client } = registry('gemini', { models: list, busy: ['gemini-flash-latest'] });
    const r = await runHealth({ client, providerId: 'gemini', apiKey: GOOD_KEY.gemini, models: ['gemini-flash-latest', 'gemini-flash-lite-latest'] });
    const first = r.steps.find((x) => x.id === 'basic:gemini-flash-latest');
    assert.ok(r.ok && r.warnings === 1 && first.temporary && first.error.category === 'overloaded', `Test mit Hinweis: ${healthReport([r])}`);
    assert.ok(r.steps.filter((x) => ['stream', 'history', 'tools'].includes(x.id)).every((x) => x.ok && x.model === 'gemini-flash-lite-latest'), 'weiter mit Flash-Lite');
    assert.strictEqual(r.status, 'limited');
    assert.ok(/: Eingeschränkt/.test(healthReport([r])) && /^⏳ .*Temporär nicht verfügbar/m.test(healthReport([r])), 'Bericht markiert den Hinweis');
    require('../src/llm/learned').clear();
    const reg = registry('gemini', { models: list, busy: ['gemini-flash-latest'] });
    const a = agentFor('gemini', reg.client);
    const started = Date.now();
    await a.run('Erklär mir kurz, was ein Router ist, mit zwei Beispielen.');
    assert.ok(!errorOf(a.events), `kein Fehler: ${errorOf(a.events)?.message}`);
    const notice = a.events.find((e) => e.c === 'chat:notice' && /überlastet/.test(e.p.text));
    const used = reg.mock.state.requests.filter((q) => /:(stream)?[gG]enerateContent/.test(q.path)).map((q) => q.path.split('/models/')[1].split(':')[0]);
    assert.ok(used[used.length - 1] !== 'gemini-flash-latest', `am Ende anderes Modell (${used})`);
    assert.ok((reg.mock.state.busyHits || 0) <= 3, `nicht lange auf das überlastete Modell gewartet (${reg.mock.state.busyHits} Versuche)`);
    if (used.includes('gemini-flash-latest')) assert.ok(notice, 'Ausweichen wird offen gesagt');
    // Danach (innerhalb weniger Minuten) wählt Buddy das überlastete Modell gar nicht erst.
    // (Hat der Router oben gleich Flash-Lite gewählt, kam die Überlastung noch nicht vor: einmal direkt fragen.)
    if (!used.includes('gemini-flash-latest')) {
      await reg.client.streamMessage({ apiKey: GOOD_KEY.gemini, model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, stream: false, onRetry: (n, err) => { throw err; } }).catch(() => {});
    }
    const tiers = models.resolveTiers(list.map((id) => ({ id })), 'gemini');
    assert.ok(tiers.sonnet !== 'gemini-flash-latest', `überlastetes Modell wird kurz gemieden (${JSON.stringify(tiers)})`);
    require('../src/llm/learned').clear();
    void started;
  }
  // Manuell gewähltes, nicht verfügbares Modell: kein stiller Ersatz, klare Meldung mit dem Namen
  {
    const { client, mock } = registry('gemini', { retired: ['gemini-2.5-pro'] });
    const a = agentFor('gemini', client, { autoModel: false, model: 'gemini-2.5-pro' });
    await a.run('hi');
    const e = errorOf(a.events);
    assert.ok(e && /gemini-2\.5-pro/.test(e.message) && e.error.category === 'model', `klare Meldung: ${e?.message}`);
    const used = mock.state.requests.filter((q) => /:(stream)?[gG]enerateContent/.test(q.path)).map((q) => q.path.split('/models/')[1].split(':')[0]);
    assert.ok(used.every((m) => m === 'gemini-2.5-pro'), `kein anderes Modell benutzt (${used})`);
  }
  // Liste ohne die eingebauten Namen (z. B. neue Generation): Stufen kommen aus der echten Liste
  {
    const { client, mock } = registry('xai', { models: ['grok-5', 'grok-5-mini'] });
    const a = agentFor('xai', client);
    await a.run('hi');
    assert.ok(!errorOf(a.events), `neue Modellnamen: ${errorOf(a.events)?.message}`);
    const used = mock.state.requests.filter((q) => q.body?.model).map((q) => q.body.model);
    assert.ok(used.length && used.every((m) => ['grok-5', 'grok-5-mini'].includes(m)), `nur echte Modelle (${used})`);
  }
  // Fehlerarten werden nicht als «Modell fehlt» gemeldet
  {
    const { classify } = require('../src/llm/errors');
    assert.strictEqual(classify(401, 'invalid key'), 'auth');
    assert.strictEqual(classify(403, 'forbidden'), 'permission');
    assert.strictEqual(classify(429, 'slow down'), 'rate_limit');
    assert.strictEqual(classify(502, 'bad gateway'), 'server');
    assert.strictEqual(classify(0, ''), 'network');
    assert.strictEqual(classify(404, 'Not Found'), 'endpoint');
  }

  console.log('Matrix-Tests ok (Claude, OpenAI, Grok, Gemini: Basis, Streaming, Verlauf, Werkzeuge, Router, Fehler, Wiederholung, Wechsel)');
})().catch((e) => { slow(); console.error(e); process.exit(1); });
