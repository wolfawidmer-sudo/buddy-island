// Anmeldung und API-Stand aller Anbieter: Key-Prüfung ohne Präfix-Zwang, Fehlerdeutung,
// OpenAI Responses API (Streaming, Werkzeuge, Denk-Items, Fehler), Gemini-Keys alt/neu,
// Anthropic-Header, Migration. Nur simulierte Anbieter, keine echten Keys, keine Kosten.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const auth = require('../src/llm/auth');
const models = require('../src/models');
const errors = require('../src/llm/errors');
const learned = require('../src/llm/learned');
const { createLlm } = require('../src/llm');
const { createClient } = require('../src/claude');
const { createOpenAiResponsesClient, toResponsesInput, effortCandidates } = require('../src/llm/openai-responses');
const { createGeminiClient } = require('../src/llm/gemini');
const { createMock, GOOD_KEY } = require('./mock-providers');

const registry = (provider, opts) => {
  const mock = createMock(provider, opts);
  const logs = [];
  const llm = createLlm({ fetchImpl: mock.fetchImpl, scriptDir: '/tmp', getPythonRuntime: async () => null, log: (m) => logs.push(m) });
  return { mock, client: llm.client(provider), logs };
};
const GET_NUMBER = [{ name: 'get_number', description: 'Zahl holen', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];

(async () => {
  // ---------- 1. Key-Format: kein Präfix-Zwang, nur Offensichtliches ----------
  const fake = (p, n = 40) => p + 'x'.repeat(n); // pragma: allowlist secret
  // Neue und alte Gemini-Formate werden beide angenommen (der Anbieter entscheidet)
  assert.strictEqual(auth.checkFormat('gemini', fake('AQ.Ab')).ok, true, 'Gemini Auth Key (AQ.) angenommen');
  const old = auth.checkFormat('gemini', fake('AIza'));
  assert.ok(old.ok && /September 2026/.test(old.notice), 'alter Standard-Key: angenommen, aber mit Hinweis');
  // Unbekannte zukünftige Formate werden nicht abgelehnt
  for (const pid of ['anthropic', 'openai', 'xai', 'gemini']) assert.strictEqual(auth.checkFormat(pid, fake('neuesformat_')).ok, true, `${pid}: unbekanntes Format nicht abgelehnt`);
  // Eindeutig falscher Anbieter
  const wrong = auth.checkFormat('openai', fake('sk-ant-api03-'));
  assert.ok(!wrong.ok && wrong.code === 'wrong_provider' && /Claude/.test(wrong.error));
  assert.strictEqual(auth.checkFormat('anthropic', fake('AQ.Ab')).code, 'wrong_provider');
  assert.strictEqual(auth.checkFormat('gemini', fake('xai-')).code, 'wrong_provider');
  // «sk-» allein ist kein Beweis (OpenAI-Keys haben mehrere Formen)
  assert.strictEqual(auth.checkFormat('xai', fake('sk-')).ok, true);
  assert.strictEqual(auth.checkFormat('anthropicAdmin', fake('sk-ant-api03-')).ok, true, 'persönlicher Key für Admin-Nutzung erlaubt');
  // Offensichtliches
  assert.strictEqual(auth.checkFormat('openai', '').code, 'empty');
  assert.strictEqual(auth.checkFormat('openai', 'sk-abc def ghi jkl mno pqr').code, 'whitespace');
  assert.strictEqual(auth.checkFormat('openai', 'sk-kurz').code, 'short');
  assert.strictEqual(auth.checkFormat('openai', fake('sk-', 600)).code, 'long');
  // Häufige Kopierfehler werden bereinigt, nicht abgelehnt
  assert.strictEqual(auth.checkFormat('openai', `  "${fake('sk-proj-')}"\n`).key, fake('sk-proj-'));
  assert.strictEqual(auth.checkFormat('openai', `Bearer ${fake('sk-proj-')}`).key, fake('sk-proj-'));

  // ---------- 2. Fehlerdeutung: ungültig, Rechte, Netz, Rate-Limit, Guthaben ----------
  const E = (status, raw, type) => new errors.ProviderError(status, raw, type, 'X');
  assert.strictEqual(auth.explain('openai', 'k', E(401, 'Incorrect API key', 'invalid_api_key')).code, 'invalid_key');
  assert.strictEqual(auth.explain('openai', 'k', E(403, 'forbidden', '')).code, 'permission');
  assert.strictEqual(auth.explain('openai', 'k', E(0, '', '')).code, 'network');
  assert.strictEqual(auth.explain('openai', 'k', E(429, 'Rate limit reached', '')).code, 'rate_limit');
  assert.strictEqual(auth.explain('openai', 'k', E(429, 'You exceeded your current quota', 'insufficient_quota')).code, 'quota');
  const retired = auth.explain('gemini', fake('AIza'), E(400, 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'));
  assert.ok(retired.code === 'retired_key' && retired.reauth && /AI Studio/.test(retired.message), 'abgeschalteter Gemini-Key: klare Anleitung');
  assert.strictEqual(auth.explain('gemini', fake('AQ.Ab'), E(400, 'API key not valid.', 'API_KEY_INVALID')).code, 'invalid_key', 'neuer Key ungültig: normale Meldung');

  // Keys nie in Protokoll oder Meldung, auch neue Formate
  const leak = errors.redact(`bad ${fake('AQ.Ab', 30)} and ${fake('sk-svcacct-')} x-goog-api-key: geheim`);
  assert.ok(!/AQ\.Ab|svcacct|geheim/.test(leak), leak);

  // Oberfläche: Anleitung pro Anbieter, Abo ≠ API-Zugang, Vertex AI klar abgegrenzt
  for (const pid of ['anthropic', 'openai', 'xai', 'gemini']) {
    const s = auth.publicSpec(pid);
    assert.ok(s.url.startsWith('https://') && s.help && s.placeholder && /API/.test(s.notIncluded), `${pid}: vollständige Anleitung`);
    assert.ok(!/sk-|AIza|xai-/.test(s.placeholder), `${pid}: kein Präfix-Beispiel im Feld`);
  }
  assert.match(auth.publicSpec('gemini').help, /Vertex AI/);

  // Keine Präfix-Regeln mehr in Registry, Oberfläche und Hauptprozess
  for (const p of Object.values(models.PROVIDERS)) assert.ok(!('keyPrefix' in p) && !('keyHint' in p), `${p.id}: kein keyPrefix`);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(!/startsWith\(provider\.keyPrefix\)|startsWith\(spec\.prefix\)|\^hf_\[/.test(main), 'kein Präfix-Zwang im Hauptprozess');
  assert.ok(/authSpecs\.checkFormat\(provider\.id, key\)/.test(main) && /authSpecs\.explain\(/.test(main));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.ok(!/placeholder="(sk-|AIza|xai-|hf_)/.test(html), 'keine alten Platzhalter');

  // ---------- 3. Anthropic: Bearer-Header und aktuelle API-Version ----------
  {
    const seen = [];
    const c = createClient(async (url, init) => { seen.push(init.headers); return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"stop"}}', { status: 400 }); });
    await c.streamMessage({ apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }).catch(() => {});
    assert.strictEqual(seen[0].authorization, 'Bearer sk-ant-test');
    assert.strictEqual(seen[0]['anthropic-version'], '2026-10-21');
    assert.ok(!('x-api-key' in seen[0]), 'kein doppelter Key-Header');
  }

  // ---------- 4. Gemini: Key nur im Header, beide Formate, alter Key mit klarer Meldung ----------
  {
    const { client, mock } = registry('gemini');
    const list = await client.listModels(GOOD_KEY.gemini);
    assert.ok(list.length > 0);
    assert.ok(mock.state.requests.every((q) => q.headers['x-goog-api-key'] && !/[?&]key=/.test(q.url)), 'Key im Header x-goog-api-key, nie in der URL');
    const err = await client.listModels(fake('AIza')).catch((x) => x);
    assert.ok(err.reauth && /September 2026/.test(err.message), `alter Key: Anleitung statt «abgelehnt» (${err.message})`);
    const bad = await client.listModels(fake('AQ.Ab')).catch((x) => x);
    assert.ok(bad.category === 'auth' && !/September/.test(bad.message));
  }

  // ---------- 5. OpenAI Responses API ----------
  assert.deepStrictEqual(effortCandidates('low', models.info('gpt-6-luna')), ['none', 'minimal', 'low']);
  assert.deepStrictEqual(effortCandidates('low', models.info('gpt-6.1-sol')), ['minimal', 'low'], 'Sol kennt «none» nicht');
  assert.deepStrictEqual(effortCandidates('max', models.info('gpt-6.1-sol')), ['max', 'xhigh', 'high']);
  assert.strictEqual(models.PROVIDERS.openai.kind, 'openai-responses');
  assert.strictEqual(models.PROVIDERS.xai.kind, 'openai', 'xAI bleibt bei Chat Completions');

  // Streaming, Instruktionen, Nutzung mit Cache
  {
    learned.clear();
    const { client, mock } = registry('openai');
    let streamed = '';
    const r = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6.1-terra', system: 'Du bist Buddy.', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 100, effort: 'medium', onText: (x) => { streamed += x; } });
    assert.strictEqual(streamed, 'OK');
    assert.strictEqual(r.stopReason, 'end_turn');
    assert.deepStrictEqual(r.usage, { input_tokens: 20, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 });
    const body = mock.state.requests.find((q) => q.body).body;
    assert.strictEqual(body.instructions, 'Du bist Buddy.', 'Systemtext als instructions, nicht im Verlauf');
    assert.ok(body.input.every((i) => i.role !== 'system' && i.role !== 'developer'));
    assert.deepStrictEqual(body.reasoning, { effort: 'medium' });
    assert.strictEqual(body.store, false);
  }
  // Werkzeuge mit Denken: Aufruf → Ergebnis → Fortsetzung mit unverändertem Denk-Item
  {
    learned.clear();
    const { client, mock } = registry('openai');
    const first = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Call get_number twice in parallel.' }], tools: GET_NUMBER, maxTokens: 500, effort: 'high' });
    assert.strictEqual(first.stopReason, 'tool_use');
    const calls = first.content.filter((b) => b.type === 'tool_use');
    assert.strictEqual(calls.length, 2, 'parallele Aufrufe');
    assert.ok(calls[0].meta.reasoning?.[0]?.encrypted_content, 'Denk-Item am ersten Aufruf gespeichert');
    assert.ok(calls.every((c) => c.meta.callId && c.id === c.meta.callId));
    const firstBody = mock.state.requests.find((q) => q.body).body;
    assert.deepStrictEqual(firstBody.include, ['reasoning.encrypted_content']);
    assert.ok(firstBody.tools.every((t) => t.type === 'function' && t.name && !t.function), 'flache Function-Tools');
    const history = [
      { role: 'user', content: 'Call get_number twice in parallel.' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: String(11 * (i + 1)) })) },
    ];
    const second = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6.1-sol', messages: history, tools: GET_NUMBER, maxTokens: 500, effort: 'high' });
    assert.match(second.content[0].text, /11, 22/, 'Fortsetzung akzeptiert');
    const input = mock.state.requests.filter((q) => q.body).pop().body.input;
    assert.deepStrictEqual(input.map((i) => i.type || i.role), ['user', 'reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
    assert.ok(!('status' in input[1]), 'nur Eingabefelder des Denk-Items');
    // Ohne Denk-Item lehnt der Simulator die Fortsetzung ab (prüft, dass Buddy es mitschickt)
    const stripped = history.map((m) => (m.role === 'assistant' ? { ...m, content: m.content.map((b) => ({ ...b, meta: { provider: 'openai', callId: b.meta.callId } })) } : m));
    const err = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6.1-sol', messages: stripped, tools: GET_NUMBER, maxTokens: 500, effort: 'high' }).catch((x) => x);
    assert.strictEqual(err.category, 'request');
  }
  // Ohne Streaming und strukturierte Antwort (Router)
  {
    const { client, mock } = registry('openai');
    const r = await client.json({ apiKey: GOOD_KEY.openai, model: 'gpt-6-luna', prompt: 'x', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
    assert.deepStrictEqual(r.data, { ok: true });
    const body = mock.state.requests.find((q) => q.body).body;
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.text.format.type, 'json_schema');
  }
  // Nicht unterstützte Denkstufe: Buddy lernt die erlaubte und merkt sie sich
  {
    learned.clear();
    const { client, mock } = registry('openai');
    const info = models.info('gpt-6.1-sol');
    const saved = info.reasoningNone;
    info.reasoningNone = true; // so tun, als wüsste Buddy es nicht
    const r = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, effort: 'low' });
    info.reasoningNone = saved;
    assert.strictEqual(r.content[0].text, 'OK');
    const efforts = mock.state.requests.filter((q) => q.body).map((q) => q.body.reasoning?.effort);
    assert.deepStrictEqual(efforts, ['none', 'low'], `springt direkt auf die schnellste erlaubte Stufe (${efforts})`);
  }
  // Modell ohne Denken (älteres GPT-4o): reasoning fällt weg, Anfrage klappt
  {
    learned.clear();
    const { client, mock } = registry('openai');
    const info = models.info('gpt-4o');
    const r = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-4o', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, effort: 'high' });
    assert.strictEqual(r.content[0].text, 'OK');
    assert.ok(!info.effortParam || mock.state.requests.filter((q) => q.body).pop().body.reasoning === undefined);
  }
  // Abgerissener Stream ist kein fertiges Ergebnis
  {
    const { client } = registry('openai', { truncate: true, failOnce: { truncate: 1 } });
    const err = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, maxRetries: 0 }).catch((x) => x);
    assert.ok(err instanceof Error && err.category === 'network', `abgebrochen erkannt (${err.category})`);
  }
  // Rate-Limit: kurze Wiederholung, dann Erfolg; falscher Key: klar als Anmeldefehler
  {
    const { client } = registry('openai', { failOnce: { rate: 1 } });
    const r = await client.streamMessage({ apiKey: GOOD_KEY.openai, model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50 });
    assert.strictEqual(r.content[0].text, 'OK');
    const bad = await registry('openai').client.listModels('sk-falsch-aber-lang-genug').catch((x) => x);
    assert.strictEqual(bad.category, 'auth');
    assert.match(bad.message, /OpenAI/);
  }
  // Bilder in Werkzeug-Ergebnissen landen als input_image in einer Nutzer-Nachricht danach
  {
    const input = toResponsesInput([
      { role: 'user', content: 'Schau' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'shot', input: {}, meta: { provider: 'openai', callId: 'call_1' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] },
    ], { vision: true });
    assert.deepStrictEqual(input.slice(2).map((i) => i.type || i.role), ['function_call_output', 'user']);
    assert.strictEqual(input[3].content[0].image_url, 'data:image/png;base64,AAAA');
  }
  // Ein Wechsel von einem anderen Anbieter: Claude-Aufrufe werden ohne fremde Metadaten übernommen
  {
    const input = toResponsesInput([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_number', input: { key: 'a' }, meta: { provider: 'gemini', thoughtSignature: 'g' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '11' }] },
    ], { vision: true });
    assert.deepStrictEqual(input.map((i) => i.type || i.role), ['user', 'function_call', 'function_call_output']);
    assert.strictEqual(input[1].call_id, input[2].call_id);
  }

  // ---------- 6. xAI: Grok 4.3+ mit reasoning_effort über Chat Completions ----------
  {
    const { client, mock } = registry('xai');
    const r = await client.streamMessage({ apiKey: GOOD_KEY.xai, model: 'grok-4.7', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 50, effort: 'high' });
    assert.strictEqual(r.content[0].text, 'OK');
    const body = mock.state.requests.find((q) => q.body).body;
    assert.strictEqual(body.reasoning_effort, 'high');
    assert.ok(mock.state.requests.every((q) => q.path.endsWith('/chat/completions') || q.path.endsWith('/models')));
  }

  // ---------- 7. Modellkatalog: aktuell, nichts Abgekündigtes als Standard ----------
  const defaults = models.CATALOG.map((m) => m.id);
  for (const id of Object.keys(models.DEPRECATED)) assert.ok(!defaults.includes(id), `${id} ist kein Standardmodell mehr`);
  assert.deepStrictEqual(models.resolveTiers([], 'openai'), { haiku: 'gpt-6-luna', sonnet: 'gpt-6.1-terra', opus: 'gpt-6.1-sol' });
  assert.deepStrictEqual(models.resolveTiers([], 'xai'), { haiku: 'grok-4.3', sonnet: 'grok-4.6', opus: 'grok-4.7' });
  // Mit Modellliste des Keys: nur verfügbare Modelle
  assert.strictEqual(models.resolveTiers(['gpt-4o', 'gpt-6-luna'], 'openai').haiku, 'gpt-6-luna');
  // Fähigkeiten pro Modell
  assert.ok(models.capabilities('gpt-6-luna').reasoning && models.capabilities('gpt-6-luna').tools);
  assert.ok(!models.capabilities('gpt-6-luna').computerUse);

  // ---------- 8. Migration: Keys bleiben, nur alte Standardmodelle werden ersetzt ----------
  assert.ok(/SETTINGS_VERSION = 6/.test(main));
  assert.ok(/savedVersion < 6 && settings\.autoModel !== false && models\.OLD_DEFAULTS\.has\(settings\.model\)/.test(main), 'nur nicht selbst gewählte Modelle');
  assert.ok(/modelNotice: settings\.autoModel === false && models\.DEPRECATED\[settings\.model\]/.test(main), 'manuelles Modell: nur Hinweis');
  assert.ok(models.OLD_DEFAULTS.has('gpt-4o-mini') && !models.OLD_DEFAULTS.has('gpt-6-luna'));

  console.log('Anmelde- und API-Tests ok (Key-Formate, Fehlerdeutung, Anthropic, Gemini, OpenAI Responses, xAI, Katalog, Migration)');
})().catch((err) => { console.error(err); process.exit(1); });
