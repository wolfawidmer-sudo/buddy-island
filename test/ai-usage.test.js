// Tests für das KI-Nutzungs-Dashboard mit nachgebauten Protokollen
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAiUsage, matchPrograms, windowLabel } = require('../src/ai-usage');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-usage-'));
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  // Claude Code: eine Sitzung mit doppelt protokollierter Antwort (Streaming) und einem Fehler
  const proj = path.join(home, '.claude', 'projects', 'C--Users-Wolf-buddy');
  fs.mkdirSync(proj, { recursive: true });
  const cc = [
    { type: 'user', timestamp: iso(now - 20 * 60e3), cwd: 'C:\\Users\\Wolf\\buddy', sessionId: 's1', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', timestamp: iso(now - 19 * 60e3), cwd: 'C:\\Users\\Wolf\\buddy', sessionId: 's1', message: { role: 'user', content: 'Fix den Login-Bug in app.js' } },
    { type: 'assistant', timestamp: iso(now - 18 * 60e3), message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
    { type: 'assistant', timestamp: iso(now - 18 * 60e3), message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }], usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
    { type: 'user', timestamp: iso(now - 17 * 60e3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'nope' }] } },
    { type: 'assistant', timestamp: iso(now - 16 * 60e3), message: { id: 'm2', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Edit', input: {} }, { type: 'text', text: 'ok' }], usage: { input_tokens: 20, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 } } },
    'kaputte Zeile {',
  ];
  fs.writeFileSync(path.join(proj, 's1.jsonl'), cc.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'));
  // Alte Sitzung (älter als 7 Tage) wird ignoriert
  const old = path.join(proj, 'alt.jsonl');
  fs.writeFileSync(old, JSON.stringify({ type: 'user', timestamp: iso(now - 30 * 864e5), message: { content: 'alt' } }));
  fs.utimesSync(old, new Date(now - 30 * 864e5), new Date(now - 30 * 864e5));

  // Codex: Sitzung mit Token-Ständen und Rate-Limits
  const d = new Date(now);
  const cdir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(cdir, { recursive: true });
  const resets = Math.floor((now + 2 * 3600e3) / 1000);
  const cx = [
    { timestamp: iso(now - 10 * 60e3), type: 'session_meta', payload: { id: 'c1', cwd: '/home/wolf/web', timestamp: iso(now - 10 * 60e3) } },
    { timestamp: iso(now - 10 * 60e3), type: 'turn_context', payload: { model: 'gpt-5.1-codex' } },
    { timestamp: iso(now - 10 * 60e3), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
    { timestamp: iso(now - 9 * 60e3), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bau eine Kontaktseite' }] } },
    { timestamp: iso(now - 8 * 60e3), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{}' } },
    { timestamp: iso(now - 8 * 60e3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 400, total_tokens: 5400 } }, rate_limits: { primary: { used_percent: 34.5, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: resets + 86400 } } } },
    { timestamp: iso(now - 7 * 60e3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9000, cached_input_tokens: 6000, output_tokens: 900, total_tokens: 9900 } }, rate_limits: { primary: { used_percent: 36, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 13, window_minutes: 10080, resets_at: resets + 86400 } } } },
  ];
  fs.writeFileSync(path.join(cdir, 'rollout-1.jsonl'), cx.map((x) => JSON.stringify(x)).join('\n'));

  const secrets = {};
  const requested = [];
  const usage = createAiUsage({
    home,
    env: {},
    getSecret: (n) => secrets[n] || null,
    fetchJson: async (url, headers) => {
      requested.push({ url, headers });
      if (url.includes('usage_report')) return { data: [{ starting_at: iso(now - 864e5), results: [{ uncached_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }] }, { starting_at: iso(now - 3600e3), results: [{ uncached_input_tokens: 2000, cache_read_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100 }, output_tokens: 300 }] }] };
      if (url.includes('cost_report')) return { data: [{ starting_at: iso(now), results: [{ amount: '1234.5', currency: 'USD' }] }] };
      throw new Error('unbekannt');
    },
    getBuddyUsage: () => ({ totals: { cost: 0.42, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, estimate: 1.3, budget: { limit: 5, spent: 0.42, ratio: 0.084, level: 'ok' } }),
    getBuddyHistory: () => [{ title: 'Timer stellen', started: now - 60e3, ended: now - 50e3, status: 'done', models: ['claude-haiku-5-5'], steps: [] }],
    listProcesses: async () => [{ name: 'claude', path: 'C:\\Users\\W\\.local\\bin\\claude.exe', cmd: 'claude' }, { name: 'ChatGPT', path: 'C:\\Program Files\\ChatGPT\\ChatGPT.exe' }, { name: 'node', cmd: 'node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js' }, { name: 'explorer' }],
  });

  let r = await usage.collect();
  const by = (id) => r.providers.find((p) => p.id === id);

  const code = by('claude_code');
  assert.strictEqual(code.status, 'ok');
  assert.strictEqual(code.activity.length, 1, 'alte Sitzung ignoriert');
  assert.strictEqual(code.activity[0].title, 'Fix den Login-Bug in app.js', 'Befehle wie /clear sind kein Titel');
  assert.strictEqual(code.activity[0].project, 'buddy');
  assert.strictEqual(code.activity[0].errors, 1);
  assert.deepStrictEqual(code.activity[0].tools, ['Read ×1', 'Edit ×1'], 'Streaming-Duplikat nur einmal gezählt');
  const tok = code.metrics.find((m) => m.label === 'Tokens heute');
  assert.strictEqual(tok.value, '3.5k ein · 150 aus', 'Duplikat nur einmal, letzte Version gilt');
  assert.strictEqual(tok.kind, 'measured');
  assert.strictEqual(code.metrics.find((m) => /API-Preisen/.test(m.label)).kind, 'estimate', 'Kosten bei Claude Code sind Schätzung');
  assert.strictEqual(code.limits.length, 0, 'keine erfundenen Abo-Limits');
  assert.match(code.limitsNote, /keine offizielle Schnittstelle/);
  assert.strictEqual(code.running.length, 1, 'gerade geschriebene Sitzung läuft');

  const codex = by('codex');
  assert.strictEqual(codex.status, 'ok');
  assert.strictEqual(codex.activity[0].title, 'Bau eine Kontaktseite');
  assert.strictEqual(codex.activity[0].model, 'gpt-5.1-codex');
  assert.deepStrictEqual(codex.limits.map((l) => [l.label, l.usedPercent]), [['5-Stunden-Fenster', 36], ['Wochenlimit', 13]], 'neuester Limit-Stand');
  assert.strictEqual(codex.limits[0].resetsAt, resets * 1000);
  assert.match(codex.metrics.find((m) => m.label === 'Tokens heute').value, /9\.0k ein \(davon 6\.0k aus dem Cache\) · 900 aus/, 'Zuwachs der Zähler');

  assert.strictEqual(by('claude_api').status, 'setup', 'ohne Admin-Key nur Hinweis');
  assert.strictEqual(by('chatgpt').status, 'unavailable');
  assert.match(by('chatgpt').limitsNote, /keine offizielle Schnittstelle/);
  assert.strictEqual(by('grok').status, 'unavailable');
  assert.strictEqual(by('buddy').limits[0].usedPercent, 8);
  assert.deepStrictEqual(r.programs.map((p) => p.name).sort(), ['ChatGPT (App)', 'Claude Code', 'Codex']);
  assert.strictEqual(requested.length, 0, 'ohne Keys keine Netzwerkaufrufe');

  // Mit Admin-Key: offizielle Usage- und Cost-API
  secrets.anthropicAdmin = 'sk-ant-admin-test'; // pragma: allowlist secret (Testwert)
  r = await usage.collect({ force: true });
  const api = by('claude_api');
  assert.strictEqual(api.status, 'ok');
  assert.match(api.metrics[0].value, /2\.6k ein · 300 aus/, 'heute = neuster Tages-Eimer');
  assert.strictEqual(api.metrics.find((m) => m.label === 'Kosten 7 Tage').value, '$12.35', 'Beträge kommen in Cent');
  assert.strictEqual(requested[0].headers.authorization, 'Bearer sk-ant-admin-test', 'aktuelle Form: Authorization Bearer');
  assert.strictEqual(requested[0].headers['anthropic-version'], '2026-10-21');
  assert.ok(requested.every((q) => q.url.startsWith('https://api.anthropic.com/')), 'Key nur an Anthropic');

  // Fehler eines Anbieters reisst die anderen nicht mit
  const broken = createAiUsage({ home, env: {}, getSecret: () => 'sk-admin-x', fetchJson: async () => { throw new Error('Der Admin-Key wurde abgelehnt.'); }, getBuddyUsage: () => ({ totals: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, estimate: 0, budget: { limit: 0, level: 'none' } }), getBuddyHistory: () => [], listProcesses: async () => { throw new Error('nicht erlaubt'); } });
  const b = await broken.collect();
  assert.strictEqual(b.providers.find((p) => p.id === 'claude_api').status, 'error');
  assert.strictEqual(b.providers.find((p) => p.id === 'codex').status, 'ok');
  assert.strictEqual(b.programsError, 'nicht erlaubt');

  // Lokale Protokolle ausgeschaltet
  const off = createAiUsage({ home, env: {}, getSecret: () => null, fetchJson: async () => ({}), getBuddyUsage: () => ({ totals: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, estimate: 0, budget: { limit: 0 } }), getBuddyHistory: () => [], listProcesses: async () => [], isEnabled: () => false });
  assert.strictEqual((await off.collect()).providers.find((p) => p.id === 'claude_code').status, 'off');

  // Text für den Chat
  const text = (await usage.run('ai_usage', { provider: 'codex' })).text;
  assert.match(text, /5-Stunden-Fenster: 36 % genutzt, 64 % übrig/);
  assert.match(text, /\[gemessen\]/);
  assert.ok(!/Claude Code/.test(text), 'nur der gefragte Anbieter');
  const all = (await usage.run('ai_usage', {})).text;
  assert.match(all, /Grok/);
  assert.match(all, /nicht verfügbar/);
  assert.match(all, /Laufende KI-Programme/);

  assert.strictEqual(windowLabel(300), '5-Stunden-Fenster');
  assert.strictEqual(windowLabel(10080), 'Wochenlimit');
  assert.deepStrictEqual(matchPrograms([{ name: 'claude', path: 'C:\\Users\\W\\AppData\\Local\\AnthropicClaude\\app-1\\claude.exe' }]), [{ name: 'Claude (App)', count: 1 }]);

  // Abo, API und lokal getrennt; lokal nicht in Buddys API-Kosten; Zwischenspeicher gekennzeichnet
  {
    let localCalls = 0;
    const u2 = createAiUsage({
      home, env: {}, getSecret: () => null, fetchJson: async () => ({}),
      getBuddyUsage: () => ({ totals: { cost: 0.3, input: 900, output: 90, cacheRead: 0, cacheWrite: 0 }, estimate: 1, budget: { limit: 0, level: 'none' },
        models: [{ id: 'claude-haiku-5-5', cost: 0.1, input: 300, output: 30 }, { id: 'gemini-2.5-flash', cost: 0.2, input: 400, output: 40 }, { id: 'hf:Qwen/Qwen2.5-1.5B-Instruct', cost: 0, input: 200, output: 20 }] }),
      getBuddyHistory: () => [], listProcesses: async () => [],
      getLocalUsage: async () => { localCalls += 1; return { model: 'Qwen/Qwen2.5-1.5B-Instruct', loaded: true, device: 'cpu', memoryMB: 3100 }; },
    });
    const r1 = await u2.collect();
    const cat = Object.fromEntries(r1.providers.map((p) => [p.id, p.category]));
    assert.strictEqual(cat.buddy, 'api');
    assert.strictEqual(cat.claude_code, 'subscription');
    assert.strictEqual(cat.chatgpt, 'subscription');
    assert.strictEqual(cat.openai_api, 'api');
    assert.strictEqual(cat.gemini, 'api');
    assert.strictEqual(cat.local, 'local');
    const buddy = r1.providers.find((p) => p.id === 'buddy');
    const rows = buddy.metrics.map((m) => m.label);
    assert.ok(rows.includes('Google Gemini') && rows.includes('Anthropic Claude'), `pro Anbieter: ${rows}`);
    assert.ok(!rows.some((r) => /Hugging|lokal/i.test(r)), 'lokale Nutzung nicht bei den API-Kosten');
    const local = r1.providers.find((p) => p.id === 'local');
    assert.ok(local.metrics.some((m) => m.value === '3100 MB' && m.kind === 'measured'), 'Arbeitsspeicher gemessen');
    assert.strictEqual(r1.providers.find((p) => p.id === 'gemini').status, 'unavailable', 'nichts erfunden');
    assert.strictEqual(r1.cached, false);
    const r2 = await u2.collect();
    assert.strictEqual(r2.cached, true, 'zweiter Abruf kommt aus dem Zwischenspeicher');
    assert.strictEqual(localCalls, 1);
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log('Nutzungs-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
