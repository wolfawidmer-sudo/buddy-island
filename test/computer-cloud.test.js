// PC-Steuerung mit Buddy Cloud: Funktions-Werkzeug «computer» statt Claude-Toolset.
// Simuliert (kein echter Bildschirm, keine echte KI): Umwandlung, Freigabe vor der Aufgabe,
// Spielmodus, «Prüfen statt Behaupten», Werkzeugliste.
const assert = require('assert');
const fns = require('../src/computer-functions');
const { createAgent } = require('../src/agent');
const { createRouter } = require('../src/router');
const { createUsage } = require('../src/usage');
const { createHistory } = require('../src/history');

(async () => {
  // ---------- Umwandlung ----------
  assert.deepStrictEqual(fns.toComputerCall({ action: 'screenshot' }), { ok: true, name: 'screenshot', input: {} });
  assert.deepStrictEqual(fns.toComputerCall({ action: 'left_click', x: 10.4, y: 20 }), { ok: true, name: 'left_click', input: { coordinate: [10, 20] } });
  assert.deepStrictEqual(fns.toComputerCall({ action: 'left_click_drag', from_x: 1, from_y: 2, x: 3, y: 4 }).input, { start_coordinate: [1, 2], coordinate: [3, 4] });
  assert.deepStrictEqual(fns.toComputerCall({ action: 'scroll', direction: 'down', amount: 99 }).input, { scroll_direction: 'down', scroll_amount: 30 });
  assert.deepStrictEqual(fns.toComputerCall({ action: 'key', text: 'ctrl+s' }).input, { text: 'ctrl+s' });
  assert.deepStrictEqual(fns.toComputerCall({ action: 'wait', seconds: 60 }).input, { duration: 10 });
  assert.strictEqual(fns.toComputerCall({ action: 'rm_rf' }).ok, false, 'unbekannte Aktion');
  assert.strictEqual(fns.toComputerCall({ action: 'left_click', x: -1, y: 3 }).ok, false, 'negative Koordinaten');
  assert.strictEqual(fns.toComputerCall({ action: 'mouse_move' }).ok, false);
  assert.strictEqual(fns.toComputerCall({ action: 'type', text: '' }).ok, false);
  assert.strictEqual(fns.toComputerCall({ action: 'type', text: 'x'.repeat(4001) }).ok, false);
  assert.strictEqual(fns.toComputerCall({ action: 'zoom', region: [1, 2, 3] }).ok, false);
  assert.strictEqual(fns.toComputerCall(null).ok, false);
  assert.ok(fns.ACTIONS.every((a) => !['left_mouse_down', 'left_mouse_up', 'hold_key'].includes(a)), 'keine halb offenen Eingaben');

  // ---------- Modus je Modell ----------
  assert.strictEqual(fns.controlMode({ computerUse: true }, 'anthropic'), 'native');
  assert.strictEqual(fns.controlMode({ computerUse: false, vision: true, tools: true }, 'buddy'), 'functions');
  assert.strictEqual(fns.controlMode({ computerUse: false, vision: true, tools: true }, 'openai'), null, 'nur über Buddy Cloud');
  assert.strictEqual(fns.controlMode({ computerUse: false, vision: false, tools: true }, 'buddy'), null);

  // ---------- Agent ----------
  function scripted(steps) {
    const seen = [];
    return {
      seen,
      json: async () => ({ data: { komplexitaet: 'einfach', reasoning: 'niedrig', schritte: 1, faehigkeiten: ['pc_steuerung'], risiko: 'niedrig', risiken: [], tokens: 100, modell: 'haiku', aufwand: 'low', begruendung: 'x' }, usage: {} }),
      streamMessage: async (req) => {
        seen.push({ model: req.model, tools: (req.tools || []).map((x) => x.name || x.type), system: req.system, messages: JSON.parse(JSON.stringify(req.messages)) });
        const step = steps[Math.min(seen.length - 1, steps.length - 1)];
        for (const b of step) if (b.type === 'text') req.onText(b.text);
        return { stopReason: step.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: step };
      },
    };
  }
  function agentFor(client, { allowControl = true, game = false, available = [{ id: 'cloud:gpt-5.4-mini' }, { id: 'cloud:gpt-5.4' }] } = {}) {
    const events = [];
    const runs = [];
    let asked = 0;
    let shot = 0;
    const agent = createAgent({
      claude: client, getClient: () => client, getProvider: () => 'buddy',
      router: createRouter({ claude: client, usage: createUsage({}) }), usage: createUsage({}), history: createHistory({}),
      getKey: () => 'k', getSettings: () => ({ autoModel: true, effort: 'auto', confirmControl: true, permissions: {} }),
      getTools: () => ({ definitions: [], run: async () => ({ text: 'ok' }), describe: () => 'x' }),
      getComputer: () => ({
        describe: (n) => n, warmUp() {}, stop() {},
        run: async (name, input) => {
          runs.push({ name, input });
          if (name === 'screenshot') { shot += 1; return [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `AAAA${shot}` } }]; }
          return [{ type: 'text', text: 'ok' }];
        },
      }),
      getFiles: () => null,
      isComputerAvailable: () => true, getAvailableModels: async () => available, getGame: () => ({ active: game, name: 'Testspiel' }),
      systemPrompt: (withComputer, opts) => `withComputer=${withComputer} tools=${opts?.tools}`,
      askControl: async () => { asked += 1; return allowControl; }, askPermission: async () => true,
    });
    return {
      events, runs, asked: () => asked,
      run: (text) => agent.run({ id: 'c1', messages: [{ role: 'user', content: text }], send: (c, p) => events.push({ c, p }), signal: new AbortController().signal }),
    };
  }
  const call = (cid, input) => ({ type: 'tool_use', id: cid, name: 'computer', input });

  // Ablauf: Bildschirmfoto → Klick → Bildschirmfoto → fertig
  let client = scripted([
    [call('a', { action: 'screenshot' })],
    [call('b', { action: 'left_click', x: 100, y: 200 })],
    [call('c', { action: 'screenshot' })],
    [{ type: 'text', text: 'Erledigt.' }],
  ]);
  let a = agentFor(client);
  await a.run('Klick im Editor auf Datei');
  assert.ok(client.seen[0].tools.includes('computer'), 'Funktions-Werkzeug computer an Buddy Cloud');
  assert.ok(!client.seen[0].tools.includes('computer_toolset_20260801'), 'kein Claude-Toolset');
  assert.match(client.seen[0].system, /withComputer=true/);
  assert.deepStrictEqual(a.runs.map((r) => r.name), ['screenshot', 'left_click', 'screenshot']);
  assert.deepStrictEqual(a.runs[1].input, { coordinate: [100, 200] });
  assert.strictEqual(a.asked(), 1, 'genau eine Freigabe pro Aufgabe');
  const done = a.events.find((e) => e.c === 'chat:done');
  assert.strictEqual(done.p.verified, true, 'nach Bildschirmfoto geprüft');
  // Bild geht als Werkzeug-Ergebnis zurück
  const results = client.seen[1].messages.at(-1).content;
  assert.ok(results.some((r) => r.type === 'tool_result' && Array.isArray(r.content) && r.content.some((x) => x.type === 'image')));

  // Abgelehnt: nichts ausgeführt
  client = scripted([[call('a', { action: 'left_click', x: 1, y: 1 })], [{ type: 'text', text: 'Ok, lasse ich.' }]]);
  a = agentFor(client, { allowControl: false });
  await a.run('Klick auf Start');
  assert.strictEqual(a.runs.length, 0, 'ohne Freigabe keine Eingabe');
  assert.match(JSON.stringify(client.seen[1].messages.at(-1).content), /abgelehnt/);

  // Spielmodus: keine simulierten Eingaben
  client = scripted([[call('a', { action: 'left_click', x: 1, y: 1 })], [{ type: 'text', text: 'Später.' }]]);
  a = agentFor(client, { game: true });
  await a.run('Klick auf Start');
  assert.strictEqual(a.runs.length, 0, 'im Spiel nichts ausführen');
  assert.match(JSON.stringify(client.seen[1].messages.at(-1).content), /Spiel/);

  // Ungültiger Aufruf → Fehler an die KI, nichts ausgeführt
  client = scripted([[call('a', { action: 'format_disk' })], [{ type: 'text', text: 'Sorry.' }]]);
  a = agentFor(client);
  await a.run('Klick irgendwo');
  assert.strictEqual(a.runs.length, 0);
  assert.match(JSON.stringify(client.seen[1].messages.at(-1).content), /Ungültiger Aufruf von computer/);

  // Ohne Prüfung behauptet: verified=false
  client = scripted([[call('a', { action: 'type', text: 'Hallo' })], [{ type: 'text', text: 'Fertig getippt.' }], [{ type: 'text', text: 'Fertig getippt.' }]]);
  a = agentFor(client);
  await a.run('Tipp Hallo ins Fenster');
  const d2 = a.events.find((e) => e.c === 'chat:done');
  assert.ok(a.runs.some((r) => r.name === 'type'));
  assert.ok(d2.p.verified === false || a.runs.at(-1).name === 'screenshot', 'nicht als geprüft gemeldet ohne Bildschirmfoto');

  console.log('PC-Steuerung über Buddy Cloud ok (simuliert: Umwandlung, Freigabe, Spielmodus, Prüfen statt Behaupten)');
})().catch((err) => { console.error(err); process.exit(1); });
