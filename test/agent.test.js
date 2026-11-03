// Tests für den Ausführungsagenten mit einem geskripteten Claude
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgent, pruneImages, validateInput } = require('../src/agent');
const { createRouter } = require('../src/router');
const { createUsage } = require('../src/usage');
const { createHistory } = require('../src/history');
const { createFiles } = require('../src/files');
const { ClaudeError } = require('../src/claude');

let n = 0;
const tu = (name, input, computer) => ({ type: 'tool_use', id: `tu_${(n += 1)}`, name, input, ...(computer ? { toolset_name: 'computer' } : {}) });
const txt = (text) => ({ type: 'text', text });

const ANALYSIS = {
  komplexitaet: 'mittel', reasoning: 'mittel', schritte: 4, faehigkeiten: ['dateien', 'planung'], risiko: 'mittel',
  risiken: [], tokens: 600, modell: 'sonnet', aufwand: 'medium', begruendung: 'Mehrstufige Dateiorganisation',
};

function scripted(steps, analysis = ANALYSIS) {
  const calls = [];
  return {
    calls,
    json: async () => ({ data: analysis, usage: { input_tokens: 500, output_tokens: 60 } }),
    async streamMessage(req) {
      const i = calls.length;
      calls.push({ model: req.model, effort: req.effort, messages: JSON.parse(JSON.stringify(req.messages)), tools: (req.tools || []).map((t) => t.name || t.type) });
      const step = steps[i];
      if (!step) throw new Error(`Kein Skript-Schritt ${i}`);
      if (typeof step === 'function') return step(req, i);
      for (const b of step) if (b.type === 'text') req.onText(b.text);
      return {
        stopReason: step.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: step,
      };
    },
  };
}

function fakeTools() {
  const ran = [];
  const errors = new Set();
  return {
    ran,
    errors,
    definitions: [
      { name: 'set_timer', description: '', input_schema: { type: 'object', properties: { minutes: { type: 'number' }, label: { type: 'string' } } } },
      { name: 'open_app', description: '', input_schema: { type: 'object', properties: { app: { type: 'string', enum: ['rechner', 'editor'] } }, required: ['app'] } },
    ],
    describe: (name) => `${name} gemacht`,
    run: async (name, input) => {
      ran.push({ name, input });
      if (errors.has(name)) return { error: true, text: `${name} ging nicht` };
      return { text: `${name} ok` };
    },
  };
}

function fakeComputer() {
  const ran = [];
  let shot = 0;
  return {
    ran,
    sameScreen: false,
    run: async function run(name) {
      ran.push(name);
      if (name === 'screenshot') {
        if (!this.sameScreen) shot += 1;
        return [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: `BILD${shot}` } }];
      }
      return [{ type: 'text', text: 'OK' }];
    },
    describe: (name) => name,
    warmUp: () => {},
    stop: () => {},
  };
}

function setup({ steps, analysis, settings = {}, computer = false, files = null, permissionAnswer = true, limit = 0, usage = null }) {
  const claude = scripted(steps, analysis);
  const u = usage || createUsage({});
  const history = createHistory({});
  const tools = fakeTools();
  const comp = fakeComputer();
  const events = [];
  const asked = [];
  const agent = createAgent({
    claude,
    router: createRouter({ claude, usage: u }),
    usage: u,
    history,
    getKey: () => 'test-key-ohne-wert', // pragma: allowlist secret (Testwert)
    getSettings: () => ({ autoModel: true, effort: 'auto', confirmControl: false, permissions: { medium: 'ask', high: 'ask' }, monthlyLimit: limit, ...settings }),
    getTools: () => tools,
    getComputer: () => comp,
    getFiles: () => files,
    isComputerAvailable: () => computer,
    getAvailableModels: async () => [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }],
    getGame: () => ({ active: false, name: '' }),
    systemPrompt: () => 'System',
    askControl: async () => true,
    askPermission: async (_id, req) => { asked.push(req); return typeof permissionAnswer === 'function' ? permissionAnswer(req) : permissionAnswer; },
    onControl: () => {},
  });
  const send = (channel, payload) => events.push({ channel, payload });
  const run = (text, signal = new AbortController().signal) => agent.run({ id: 't1', messages: [{ role: 'user', content: text }], send, signal });
  const of = (ch) => events.filter((e) => e.channel === ch).map((e) => e.payload);
  return { claude, tools, comp, events, asked, history, usage: u, run, of };
}

(async () => {
  // ---------- 1. Beispiel aus der Aufgabe: Haiku analysiert, Sonnet plant und ordnet, Haiku fasst zusammen ----------
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-agent-'));
    const desktop = path.join(base, 'Desktop');
    fs.mkdirSync(desktop);
    fs.writeFileSync(path.join(desktop, 'a.jpg'), 'X');
    fs.writeFileSync(path.join(desktop, 'b.jpg'), 'X');
    fs.writeFileSync(path.join(desktop, 'c.pdf'), 'P');
    const files = createFiles({ roots: { desktop }, trash: async () => {} });
    const plan = (s1, s2, s3) => [
      { title: 'Duplikate suchen', status: s1, difficulty: 'normal' },
      { title: 'Dateien sortieren', status: s2, difficulty: 'normal' },
      { title: 'Zusammenfassung', status: s3, difficulty: 'simple' },
    ];
    const t = setup({
      files,
      steps: [
        [tu('update_plan', { steps: plan('in_progress', 'pending', 'pending') })],
        [tu('find_duplicates', { folder: 'Desktop' })],
        [tu('update_plan', { steps: plan('done', 'in_progress', 'pending') }), tu('move_files', { moves: [{ from: 'Desktop/a.jpg', to: 'Desktop/Bilder/' }, { from: 'Desktop/c.pdf', to: 'Desktop/Dokumente/' }] })],
        [tu('update_plan', { steps: plan('done', 'done', 'in_progress') })],
        [txt('Ich habe 1 Duplikat gefunden und 2 Dateien in Ordner sortiert. Alles geprüft.')],
      ],
    });
    await t.run('Suche alle doppelten Dateien auf meinem Desktop, sortiere die übrigen Dateien in passende Ordner und erstelle eine Zusammenfassung.');
    const used = t.claude.calls.map((c) => c.model);
    assert.deepStrictEqual(used, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], `Modelle pro Schritt: ${used}`);
    const first = JSON.stringify(t.claude.calls[0].messages);
    assert.match(first, /mehrstufige Aufgabe/, 'Router-Hinweis für den Plan');
    const last = JSON.stringify(t.claude.calls[4].messages);
    assert.match(last, /Claude Haiku 5\.5 weiter/, 'Haiku bekommt den Stand mitgeteilt');
    assert.match(last, /Duplikate suchen/, 'gemeinsamer Kontext inkl. Plan');
    assert.match(last, /Verschoben und geprüft: 2 von 2/, 'Haiku sieht die Ergebnisse von Sonnet');
    assert.strictEqual(t.asked.length, 1, 'mittleres Risiko einmal gefragt');
    assert.strictEqual(t.asked[0].level, 'medium');
    assert.ok(fs.existsSync(path.join(desktop, 'Bilder', 'a.jpg')));
    const done = t.of('chat:done')[0];
    assert.ok(done && done.usage.cost > 0, 'Kosten pro Anfrage');
    assert.deepStrictEqual(done.usage.models, ['Sonnet 5.5', 'Haiku 5.5']);
    assert.strictEqual(t.of('agent:plan').length, 4, 'letzter Schritt automatisch erledigt');
    const routes = t.of('agent:route');
    assert.strictEqual(routes[0].modelName, 'Sonnet 5.5');
    assert.ok(routes.some((r) => r.switched && r.modelName === 'Haiku 5.5'), 'Wechsel wird angezeigt');
    const task = t.history.list()[0];
    assert.deepStrictEqual(task.models, ['claude-sonnet-5-5', 'claude-haiku-5-5']);
    assert.strictEqual(task.status, 'done');
    assert.ok(task.steps.some((s) => s.kind === 'permission' && s.status === 'ok'));
    fs.rmSync(base, { recursive: true, force: true });
  }

  // ---------- 2. Eskalation nach wiederholten Fehlern, Kontext bleibt ----------
  {
    const t = setup({
      steps: [
        [tu('open_app', { app: 'rechner' })],
        [tu('open_app', { app: 'editor' })],
        [txt('Mit dem stärkeren Modell geht es: Ich erkläre dir, wie du den Rechner öffnest.')],
      ],
    });
    t.tools.errors.add('open_app');
    await t.run('Öffne den Rechner');
    const used = t.claude.calls.map((c) => c.model);
    assert.deepStrictEqual(used, ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'], `Eskalation: ${used}`);
    assert.strictEqual(t.of('agent:escalate').length, 1);
    const ctx = JSON.stringify(t.claude.calls[2].messages);
    assert.match(ctx, /open_app ging nicht/, 'bisherige Ergebnisse bleiben');
    assert.match(ctx, /übernimmt Claude Sonnet 5\.5/);
    assert.strictEqual(t.history.list()[0].escalations.length, 1);
  }

  // ---------- 3. Nie «fertig» ohne Prüfung (PC-Steuerung) ----------
  {
    const t = setup({
      computer: true,
      analysis: { ...ANALYSIS, faehigkeiten: ['pc_steuerung'], schritte: 2 },
      steps: [
        [tu('left_click', { coordinate: [10, 10] }, true)],
        [txt('Fertig! Alles erledigt.')],
        [tu('screenshot', {}, true)],
        [txt('Geprüft: Der Editor ist offen.')],
      ],
    });
    await t.run('Klick im offenen Fenster auf Speichern, bitte genau dort');
    const shown = t.of('chat:delta').map((d) => d.text).join('');
    assert.ok(!/Fertig! Alles erledigt/.test(shown), 'ungeprüfte Erfolgsmeldung wird nicht gezeigt');
    assert.match(shown, /Geprüft: Der Editor ist offen/);
    assert.match(JSON.stringify(t.claude.calls[2].messages), /Buddy-Prüfung/);
    assert.deepStrictEqual(t.comp.ran, ['left_click', 'screenshot']);
    assert.strictEqual(t.of('chat:done')[0].verified, true);
    assert.strictEqual(t.history.list()[0].verified, true);
  }

  // ---------- 4. Hohes Risiko: ausdrückliche Zustimmung, abgelehnt = nicht ausgeführt ----------
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-agent-'));
    const desktop = path.join(base, 'Desktop');
    fs.mkdirSync(desktop);
    fs.writeFileSync(path.join(desktop, 'wichtig.txt'), 'X');
    const trashed = [];
    const files = createFiles({ roots: { desktop }, trash: async (p) => { trashed.push(p); fs.unlinkSync(p); } });
    const t = setup({
      files,
      settings: { permissions: { medium: 'allow', high: 'ask' } },
      permissionAnswer: false,
      steps: [
        [tu('delete_files', { paths: ['Desktop/wichtig.txt'] })],
        [txt('Okay, ich lösche nichts.')],
      ],
    });
    await t.run('Lösch die Datei wichtig.txt auf dem Desktop');
    assert.strictEqual(t.asked.length, 1);
    assert.strictEqual(t.asked[0].level, 'high', 'trotz «mittel ohne Nachfrage» wird bei hohem Risiko gefragt');
    assert.ok(fs.existsSync(path.join(desktop, 'wichtig.txt')), 'nichts gelöscht');
    assert.strictEqual(trashed.length, 0);
    assert.match(JSON.stringify(t.claude.calls[1].messages), /abgelehnt/);

    // Gesperrt in den Einstellungen: ohne Frage abgelehnt
    const t2 = setup({ files, settings: { permissions: { medium: 'ask', high: 'block' } }, steps: [[tu('delete_files', { paths: ['Desktop/wichtig.txt'] })], [txt('Geht nicht.')]] });
    await t2.run('Lösch die Datei wichtig.txt auf dem Desktop');
    assert.strictEqual(t2.asked.length, 0);
    assert.match(JSON.stringify(t2.claude.calls[1].messages), /Gesperrt/);

    // Zugestimmt: in den Papierkorb und geprüft
    const t3 = setup({ files, permissionAnswer: true, steps: [[tu('delete_files', { paths: ['Desktop/wichtig.txt'] })], [txt('Liegt im Papierkorb.')]] });
    await t3.run('Lösch die Datei wichtig.txt auf dem Desktop');
    assert.strictEqual(trashed.length, 1);
    fs.rmSync(base, { recursive: true, force: true });
  }

  // ---------- 5. Gefährliche Eingaben über die Bildschirmsteuerung ----------
  {
    const t = setup({
      computer: true,
      permissionAnswer: (req) => req.category !== 'security',
      analysis: { ...ANALYSIS, faehigkeiten: ['pc_steuerung'] },
      steps: [
        [tu('type', { text: 'Set-MpPreference -DisableRealtimeMonitoring $true' }, true)],
        [txt('Das mache ich nicht.')],
      ],
    });
    await t.run('Schalte den Virenschutz in PowerShell aus');
    assert.strictEqual(t.asked[0].category, 'security');
    assert.ok(!t.comp.ran.includes('type'), 'nicht getippt');
  }

  // ---------- 6. Doppelte Aktionen und ungültige Aufrufe ----------
  {
    const t = setup({
      analysis: { ...ANALYSIS, komplexitaet: 'einfach', faehigkeiten: ['werkzeuge'], schritte: 2, modell: 'haiku' },
      steps: [
        [tu('set_timer', { minutes: 5, label: 'Tee' })],
        [tu('set_timer', { minutes: 5, label: 'Tee' }), tu('hack_pc', {}), tu('open_app', { app: 'paint' })],
        [txt('Timer läuft.')],
      ],
    });
    await t.run('Stell mir bitte einen Timer für den Tee und mach dann weiter mit allem');
    assert.strictEqual(t.tools.ran.filter((r) => r.name === 'set_timer').length, 1, 'kein doppelter Timer');
    const ctx = JSON.stringify(t.claude.calls[2].messages);
    assert.match(ctx, /Nicht nochmals ausgeführt/);
    assert.match(ctx, /Unbekanntes Werkzeug: hack_pc/);
    assert.match(ctx, /muss einer dieser Werte sein/, 'Eingaben werden geprüft');
    assert.ok(!t.tools.ran.some((r) => r.name === 'open_app'));
  }

  // ---------- 7. Gleiche Eingabe ohne Prüfung wird gestoppt ----------
  {
    const click = () => [tu('left_click', { coordinate: [5, 5] }, true)];
    const t = setup({
      computer: true,
      analysis: { ...ANALYSIS, faehigkeiten: ['pc_steuerung'] },
      settings: { autoModel: false, model: 'claude-sonnet-5-5' },
      steps: [click(), click(), click(), [tu('screenshot', {}, true)], [txt('Geprüft.')]],
    });
    await t.run('Klick mehrmals auf den Knopf da oben links im Fenster');
    assert.strictEqual(t.comp.ran.filter((x) => x === 'left_click').length, 2, 'dritte Wiederholung blockiert');
    assert.match(JSON.stringify(t.claude.calls[3].messages), /mehrmals hintereinander/);
    assert.ok(t.claude.calls.every((c) => c.model === 'claude-sonnet-5-5'), 'manuell: kein Wechsel');
  }

  // ---------- 8. Aktion ohne sichtbare Wirkung wird erkannt ----------
  {
    const t = setup({
      computer: true,
      analysis: { ...ANALYSIS, faehigkeiten: ['pc_steuerung'] },
      settings: { autoModel: false, model: 'claude-haiku-5-5' },
      steps: [[tu('screenshot', {}, true)], [tu('left_click', { coordinate: [1, 1] }, true)], [tu('screenshot', {}, true)], [txt('Hat nicht geklappt.')]],
    });
    t.comp.sameScreen = true;
    await t.run('Klick auf den Knopf da oben im Programmfenster');
    assert.match(JSON.stringify(t.claude.calls[3].messages), /keine sichtbare Wirkung/);
  }

  // ---------- 9. Ausgabenlimit ----------
  {
    const usage = createUsage({});
    usage.record({ model: 'claude-opus-5-5', usage: { input_tokens: 1e5, output_tokens: 1e5 } });
    const t = setup({ usage, limit: 1, steps: [] });
    await t.run('Hoi');
    assert.strictEqual(t.claude.calls.length, 0, 'kein API-Aufruf über dem Limit');
    assert.strictEqual(t.of('chat:error')[0].code, 'budget');
  }

  // ---------- 10. Verbindungsabbruch mitten im Stream: Runde neu, Text zurückgenommen ----------
  {
    const t = setup({
      steps: [
        (req) => { req.onText('Halb'); throw new ClaudeError(0, ''); },
        [txt('Hoi! Wie kann ich helfen?')],
      ],
    });
    await t.run('Hoi');
    assert.deepStrictEqual(t.of('chat:rewind')[0], { id: 't1', chars: 4 });
    assert.strictEqual(t.of('chat:done').length, 1);
  }

  // ---------- 11. Abbrechen ----------
  {
    const ctrl = new AbortController();
    const t = setup({
      steps: [
        () => { ctrl.abort(); throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' }); },
      ],
    });
    await t.run('Hoi', ctrl.signal);
    assert.strictEqual(t.of('chat:done')[0].stopReason, 'aborted');
    assert.strictEqual(t.history.list()[0].status, 'aborted');
  }

  // ---------- 12. Ungültiger Key ----------
  {
    let authErrors = 0;
    const claude = { calls: [], json: async () => { throw new ClaudeError(401, 'invalid x-api-key', 'authentication_error'); }, streamMessage: async () => { throw new ClaudeError(401, '', 'authentication_error'); } };
    const events = [];
    const agent = createAgent({
      claude, router: createRouter({ claude, usage: createUsage({}) }), usage: createUsage({}), history: createHistory({}),
      getKey: () => 'k', getSettings: () => ({ autoModel: true }), getTools: fakeTools, getComputer: () => null, getFiles: () => null,
      isComputerAvailable: () => false, getAvailableModels: async () => [], getGame: () => ({}), systemPrompt: () => '',
      askControl: async () => true, askPermission: async () => true, onAuthError: () => { authErrors += 1; },
    });
    await agent.run({ id: 'k1', messages: [{ role: 'user', content: 'Analysiere bitte meine Ordnerstruktur und plane eine neue' }], send: (c, p) => events.push({ c, p }), signal: new AbortController().signal });
    const err = events.find((e) => e.c === 'chat:error');
    assert.match(err.p.message, /API-Key ist ungültig/);
    assert.strictEqual(err.p.code, 'key');
    assert.strictEqual(authErrors, 1);
  }

  // ---------- Hilfsfunktionen ----------
  const conv = [];
  for (let i = 0; i < 9; i += 1) conv.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `x${i}`, content: [{ type: 'image', source: { data: String(i) } }] }] });
  assert.strictEqual(pruneImages(conv), 6);
  assert.strictEqual(JSON.stringify(conv).match(/"image"/g).length, 3, 'die neusten 3 Bilder bleiben');
  assert.strictEqual(pruneImages(conv), 0, 'nur in Schüben');
  assert.match(validateInput({ input_schema: { required: ['a'] } }, {}), /Pflichtfeld/);
  assert.match(validateInput({ input_schema: { properties: { n: { type: 'number' } } } }, { n: 'x' }), /falschen Typ/);
  assert.strictEqual(validateInput({ input_schema: { properties: { n: { type: 'number' } } } }, { n: 3 }), null);

  console.log('Agent-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
