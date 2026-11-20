// Tests: Buddy Live (src/live.js, src/live-tools.js) mit simulierter Gegenstelle.
// Teil 1: Ablauf mit Attrappen (WebSocket, Zeitgeber). Teil 2: echte Kette App → Backend-Relay →
// simulierte OpenAI-Realtime-Gegenstelle (lokal, ohne Netz, ohne Kosten).
const assert = require('assert');
const http = require('http');
const { createLive, instructionsFor, SILENCE_MS } = require('../src/live');
const { createLiveTools, LIVE_TOOLS } = require('../src/live-tools');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('✓', name); };
const tick = () => new Promise((r) => setImmediate(r));

class FakeWs {
  static last = null;
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; this.readyState = 0; FakeWs.last = this; }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(ev) { this.onmessage?.({ data: JSON.stringify(ev) }); }
  types() { return this.sent.map((e) => e.type); }
}

function fakeTimers() {
  const list = new Map();
  let id = 0;
  return {
    setTimeout: (fn, ms) => { id += 1; list.set(id, { fn, ms }); return id; },
    clearTimeout: (i) => list.delete(i),
    fire(ms) { for (const [i, t] of [...list]) if (t.ms === ms) { list.delete(i); t.fn(); } },
    has: (ms) => [...list.values()].some((t) => t.ms === ms),
  };
}

function setup({ ticketErr, toolResult } = {}) {
  const ui = [];
  const ended = [];
  const runs = [];
  const timers = fakeTimers();
  const live = createLive({
    ticket: async () => { if (ticketErr) throw Object.assign(new Error(ticketErr), { code: ticketErr }); return { ticket: 'T'.repeat(43), path: '/v1/cloud/realtime', protocol: 'buddy-live.v1' }; },
    wsBase: () => 'https://api.example.test',
    tools: { definitions: () => [{ type: 'function', name: 'set_timer', parameters: {} }], run: async (id, name, args) => { runs.push({ id, name, args }); return toolResult ? toolResult(name) : { output: 'ok' }; } },
    send: (ch, m) => ui.push({ ch, ...m }),
    settings: () => ({ name: 'Buddy', language: 'de', voice: 'cedar' }),
    onEnd: (i) => ended.push(i),
    WebSocketImpl: FakeWs,
    timers,
  });
  return { live, ui, ended, runs, timers, kinds: () => ui.map((u) => u.kind) };
}

(async () => {
  await test('Anweisungen: Sprache der App, kurz, Freigaben im Island, Verabschiedung → end_conversation', () => {
    const txt = instructionsFor({ name: 'Kiki', language: 'fr' });
    assert.match(txt, /Kiki/);
    assert.match(txt, /français/);
    assert.match(txt, /im Island/);
    assert.match(txt, /end_conversation/);
    assert.match(txt, /hand_off_to_chat/);
    assert.ok(txt.length < 2000, 'kurz halten (kostet in jeder Runde)');
  });

  await test('Start: Ticket → WebSocket mit Subprotokollen (kein Token in der URL) → session.update', async () => {
    const t = setup();
    const r = await t.live.start();
    assert.ok(r.ok);
    const ws = FakeWs.last;
    assert.strictEqual(ws.url, 'wss://api.example.test/v1/cloud/realtime');
    assert.deepStrictEqual(ws.protocols, ['buddy-live.v1', `ticket.${'T'.repeat(43)}`]);
    ws.open();
    const su = ws.sent[0];
    assert.strictEqual(su.type, 'session.update');
    assert.strictEqual(su.session.audio.output.voice, 'cedar');
    assert.strictEqual(su.session.audio.input.turn_detection.type, 'semantic_vad');
    assert.strictEqual(su.session.tools[0].name, 'set_timer');
    // Ton erst nach buddy.session
    t.live.audio('AAAA');
    assert.strictEqual(ws.sent.length, 1);
    ws.emit({ type: 'buddy.session', model: 'gpt-realtime-2.1' });
    assert.ok(t.ui.some((u) => u.kind === 'mic' && u.on === true));
    t.live.audio('AAAA');
    assert.deepStrictEqual(ws.sent[1], { type: 'input_audio_buffer.append', audio: 'AAAA' });
    assert.strictEqual(t.live.phase(), 'listening');
  });

  await test('Unterbrechen: speech_started → Wiedergabe stoppen; gespielte ms → conversation.item.truncate', async () => {
    const t = setup();
    await t.live.start();
    const ws = FakeWs.last;
    ws.open();
    ws.emit({ type: 'buddy.session' });
    ws.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'item_7' });
    assert.strictEqual(t.live.phase(), 'speaking');
    assert.ok(t.ui.some((u) => u.kind === 'audio' && u.itemId === 'item_7'));
    ws.emit({ type: 'input_audio_buffer.speech_started' });
    assert.ok(t.kinds().includes('interrupt'));
    t.live.played('item_7', 1234.6);
    assert.deepStrictEqual(ws.sent.at(-1), { type: 'conversation.item.truncate', item_id: 'item_7', content_index: 0, audio_end_ms: 1234 });
    assert.strictEqual(t.live.phase(), 'listening');
  });

  await test('Stille: nach 8 s ohne Sprechen endet das Gespräch; nicht während Buddy spricht oder ein Werkzeug läuft', async () => {
    const t = setup();
    await t.live.start();
    const ws = FakeWs.last;
    ws.open();
    ws.emit({ type: 'buddy.session' });
    assert.ok(t.timers.has(SILENCE_MS));
    ws.emit({ type: 'input_audio_buffer.speech_started' });
    assert.ok(!t.timers.has(SILENCE_MS), 'Nutzer spricht');
    ws.emit({ type: 'input_audio_buffer.speech_stopped' });
    ws.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'i1' });
    ws.emit({ type: 'response.done', response: {} });
    assert.ok(!t.timers.has(SILENCE_MS), 'Buddy spricht noch (Wiedergabe)');
    t.live.playbackIdle();
    assert.ok(t.timers.has(SILENCE_MS));
    t.timers.fire(SILENCE_MS);
    assert.strictEqual(ws.sent.at(-1).type, 'buddy.end');
    ws.emit({ type: 'buddy.ended', reason: 'client', credits: '3.200000', seconds: 20 });
    assert.strictEqual(t.ended[0].reason, 'silence');
    assert.strictEqual(t.ended[0].credits, '3.200000');
    assert.ok(!t.live.active());
  });

  await test('Werkzeug im Gespräch: Ergebnis zurück + neue Antwort; «tschüss» → end_conversation → Ende nach der Wiedergabe', async () => {
    const t = setup({ toolResult: (name) => (name === 'end_conversation' ? { output: 'x', action: 'end' } : { output: 'Timer läuft' }) });
    await t.live.start();
    const ws = FakeWs.last;
    ws.open();
    ws.emit({ type: 'buddy.session' });
    ws.emit({ type: 'response.function_call_arguments.done', name: 'set_timer', call_id: 'c1', arguments: '{"minutes":2}' });
    await tick();
    assert.deepStrictEqual(t.runs[0], { id: t.ui[0].id, name: 'set_timer', args: '{"minutes":2}' });
    assert.deepStrictEqual(ws.sent.slice(-2), [{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: 'Timer läuft' } }, { type: 'response.create' }]);
    ws.emit({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'i2' });
    ws.emit({ type: 'response.function_call_arguments.done', name: 'end_conversation', call_id: 'c2', arguments: '{}' });
    await tick();
    assert.notStrictEqual(ws.sent.at(-1).type, 'buddy.end', 'erst fertig abspielen');
    t.live.playbackIdle();
    assert.strictEqual(ws.sent.at(-1).type, 'buddy.end');
    ws.emit({ type: 'buddy.ended', reason: 'client', credits: '1.000000' });
    assert.strictEqual(t.ended[0].reason, 'goodbye');
  });

  await test('Übergabe an den Chat (PC-Steuerung/Befehle): Gespräch endet mit Aufgabe', async () => {
    const t = setup({ toolResult: () => ({ output: 'x', action: 'handoff', task: 'Öffne den Editor und tippe Hallo' }) });
    await t.live.start();
    const ws = FakeWs.last;
    ws.open();
    ws.emit({ type: 'buddy.session' });
    ws.emit({ type: 'response.function_call_arguments.done', name: 'hand_off_to_chat', call_id: 'c1', arguments: '{"task":"x"}' });
    await tick();
    ws.emit({ type: 'buddy.ended', reason: 'client' });
    assert.strictEqual(t.ended[0].reason, 'handoff');
    assert.strictEqual(t.ended[0].task, 'Öffne den Editor und tippe Hallo');
  });

  await test('Kein Start ohne Guthaben/Anmeldung/Backend; Guthaben leer im Gespräch → Grund «credits»', async () => {
    for (const [code, reason] of [['insufficient_credits', 'credits'], ['signed_out', 'signed_out'], ['not_configured', 'unavailable'], ['live_busy', 'busy']]) {
      FakeWs.last = null;
      const t = setup({ ticketErr: code });
      const r = await t.live.start();
      assert.strictEqual(r.reason, reason);
      assert.strictEqual(FakeWs.last, null, 'keine Verbindung');
      assert.strictEqual(t.ended[0].reason, reason);
    }
    const t = setup();
    await t.live.start();
    const ws = FakeWs.last;
    ws.open();
    ws.emit({ type: 'buddy.session' });
    ws.emit({ type: 'buddy.usage', credits: '9.000000' });
    ws.emit({ type: 'buddy.error', code: 'insufficient_credits' });
    ws.emit({ type: 'buddy.ended', reason: 'insufficient_credits', credits: '9.000000' });
    assert.strictEqual(t.ended[0].reason, 'credits');
    assert.ok(t.kinds().includes('credits-low'));
  });

  await test('Stopp-Knopf/Tastenkürzel: sofort Mikrofon aus, buddy.end; ohne Antwort schliesst die App nach 3 s selbst', async () => {
    const t = setup();
    await t.live.start();
    const ws = FakeWs.last;
    ws.open();
    ws.emit({ type: 'buddy.session' });
    t.live.stop('stopped');
    assert.ok(t.ui.some((u) => u.kind === 'mic' && u.on === false));
    assert.strictEqual(ws.sent.at(-1).type, 'buddy.end');
    t.timers.fire(3000);
    assert.strictEqual(t.ended[0].reason, 'stopped');
    assert.strictEqual(ws.readyState, 3);
  });

  // ---------- live-tools ----------
  const fakeTools = {
    definitions: [{ name: 'set_timer', description: 'Timer', input_schema: { type: 'object', properties: { minutes: { type: 'number' } } } }, { name: 'close_app', description: 'Schliessen', input_schema: { type: 'object', properties: { name: { type: 'string' }, force: { type: 'boolean' } }, required: ['name'] } }],
    run: async (name, input) => ({ text: `${name} ${JSON.stringify(input)}`, label: `Label ${name}` }),
    describe: (name) => name,
  };

  await test('Werkzeuge: gleiche Definitionen wie im Chat + Live-eigene, im Realtime-Format', () => {
    const lt = createLiveTools({ tools: fakeTools, getPolicy: () => ({ medium: 'ask', high: 'ask' }), askPermission: async () => true, send: () => {} });
    const defs = lt.definitions();
    assert.deepStrictEqual(defs.map((d) => d.name), ['set_timer', 'close_app', ...LIVE_TOOLS.map((d) => d.name)]);
    assert.ok(defs.every((d) => d.type === 'function' && d.parameters && d.parameters.type === 'object'));
  });

  await test('Werkzeuge: Freigabe wird im Island geklickt (askPermission), Ablehnung wird nicht ausgeführt', async () => {
    const asked = [];
    let answer = false;
    const sent = [];
    const lt = createLiveTools({ tools: fakeTools, getPolicy: () => ({ medium: 'ask', high: 'ask' }), askPermission: async (id, req) => { asked.push({ id, req }); return answer; }, send: (ch, m) => sent.push({ ch, ...m }) });
    const low = await lt.run('live-1', 'set_timer', '{"minutes":2}');
    assert.match(low.output, /set_timer/);
    assert.strictEqual(asked.length, 0, 'niedriges Risiko ohne Frage');
    const denied = await lt.run('live-1', 'close_app', '{"name":"notepad","force":true}');
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].id, 'live-1');
    assert.strictEqual(asked[0].req.level, 'high');
    assert.match(denied.output, /abgelehnt/);
    answer = true;
    const ok = await lt.run('live-1', 'close_app', '{"name":"notepad","force":true}');
    assert.match(ok.output, /close_app/);
    assert.ok(sent.some((m) => m.ch === 'live' && m.kind === 'tool' && m.label === 'Label close_app'));
    assert.match((await lt.run('live-1', 'format_disk', '{}')).output, /Unbekanntes Werkzeug/);
    assert.match((await lt.run('live-1', 'close_app', '{kaputt')).output, /kein gültiges JSON/);
    assert.match((await lt.run('live-1', 'close_app', '{}')).output, /Pflichtfeld/);
    assert.strictEqual((await lt.run('live-1', 'end_conversation', '{}')).action, 'end');
    const h = await lt.run('live-1', 'hand_off_to_chat', '{"task":"Klick auf Datei"}');
    assert.strictEqual(h.action, 'handoff');
    assert.strictEqual(h.task, 'Klick auf Datei');
  });

  await test('Werkzeuge: hohes Risiko gesperrt (Einstellung «blockieren») → nie ausgeführt, nie gefragt', async () => {
    let ran = false;
    const lt = createLiveTools({ tools: { ...fakeTools, run: async () => { ran = true; return { text: '' }; } }, getPolicy: () => ({ medium: 'ask', high: 'block' }), askPermission: async () => { throw new Error('nicht fragen'); }, send: () => {} });
    const r = await lt.run('live-1', 'close_app', '{"name":"notepad","force":true}');
    assert.match(r.output, /Gesperrt/);
    assert.strictEqual(ran, false);
  });

  // ---------- Kette: App → Backend-Relay → simulierte OpenAI-Gegenstelle ----------
  await test('Kette: echtes Backend-Relay + simulierte Realtime-Gegenstelle, Werkzeug, Abrechnung, Ende', async () => {
    const helpers = require('../backend/tests/helpers');
    const { acceptUpgrade } = require('../backend/src/lib/websocket');
    // Simulierte Gegenstelle: antwortet auf Ton mit Sprache-Erkannt, ruft set_timer auf, spricht, meldet usage
    const seen = [];
    const oa = http.createServer();
    oa.on('upgrade', (req, socket, head) => {
      const c = acceptUpgrade(req, socket, head, {});
      let step = 0;
      c.on('message', (m) => {
        const ev = JSON.parse(m);
        seen.push(ev);
        const usage = { input_tokens: 150, output_tokens: 210, input_token_details: { text_tokens: 100, audio_tokens: 50, cached_tokens: 0 }, output_token_details: { text_tokens: 10, audio_tokens: 200 } };
        if (ev.type === 'input_audio_buffer.append' && step === 0) {
          step = 1;
          c.send({ type: 'input_audio_buffer.speech_started' });
          c.send({ type: 'input_audio_buffer.speech_stopped' });
          c.send({ type: 'response.function_call_arguments.done', name: 'set_timer', call_id: 'call_1', arguments: '{"minutes":2}' });
          c.send({ type: 'response.done', response: { status: 'completed', usage } });
        } else if (ev.type === 'response.create') {
          c.send({ type: 'response.output_audio.delta', delta: Buffer.alloc(960).toString('base64'), item_id: 'item_a' });
          c.send({ type: 'response.output_audio_transcript.delta', delta: 'Timer läuft.' });
          c.send({ type: 'response.done', response: { status: 'completed', usage } });
        }
      });
    });
    await new Promise((r) => oa.listen(0, '127.0.0.1', r));
    const l = { available: 100_000000n, res: new Map(), settled: [] };
    const fmt = (v) => `${v / 1000000n}.${String(v % 1000000n).padStart(6, '0')}`;
    const parse = (s) => { const [a, b = ''] = String(s).split('.'); return BigInt(a) * 1000000n + BigInt((b + '000000').slice(0, 6)); };
    const cost = (a) => BigInt(a.p_input_tokens + a.p_output_tokens) * 1000n + BigInt((a.p_audio?.input_tokens || 0) + (a.p_audio?.output_tokens || 0)) * 10000n;
    const handlers = {
      supabaseSelect: (table) => helpers.json(200, table === 'model_pricing' ? [{ model_id: 'gpt-realtime-2.1' }] : []),
      supabaseRpc: (name, a) => {
        if (name === 'billing_quote') return helpers.json(200, [{ credits: fmt(cost(a)) }]);
        if (name === 'reserve_credits') { const amt = parse(a.p_amount); l.available -= amt; l.res.set(a.p_request_id, amt); return helpers.json(200, [{ reservation_id: 'r', amount: fmt(amt), available_credits: fmt(l.available) }]); }
        if (name === 'settle_reservation') { const c = cost(a); l.available += (l.res.get(a.p_request_id) || 0n) - c; l.res.delete(a.p_request_id); l.settled.push(a); return helpers.json(200, { credits_charged: fmt(c), status: 'settled' }); }
        if (name === 'release_reservation') { l.available += l.res.get(a.p_request_id) || 0n; l.res.delete(a.p_request_id); return helpers.json(200, [{}]); }
        return helpers.json(404, {});
      },
    };
    const app = await helpers.startApp({ handlers, config: { realtime: { url: `ws://127.0.0.1:${oa.address().port}/v1/realtime` } } });
    const token = helpers.signToken();
    const ui = [];
    const runs = [];
    let ended;
    const done = new Promise((r) => { ended = r; });
    const lt = createLiveTools({
      tools: { definitions: fakeTools.definitions, run: async (name, input) => { runs.push({ name, input }); return { text: 'Timer 2 Min. läuft', label: 'Timer 2 Min.' }; }, describe: (x) => x },
      getPolicy: () => ({ medium: 'ask', high: 'ask' }), askPermission: async () => false, send: (ch, m) => ui.push({ ch, ...m }),
    });
    const live = createLive({
      ticket: async () => {
        const r = await app.call('POST', '/v1/cloud/realtime/sessions', { token, body: {} });
        if (r.status !== 200) throw Object.assign(new Error(r.data.error.code), { code: r.data.error.code });
        return r.data;
      },
      wsBase: () => app.base,
      tools: lt,
      send: (ch, m) => {
        ui.push({ ch, ...m });
        // Renderer-Attrappe: Mikrofon schickt Ton, Wiedergabe meldet Ende
        if (m.kind === 'mic' && m.on) live.audio(Buffer.alloc(4800).toString('base64'));
        if (m.kind === 'audio') setTimeout(() => live.playbackIdle(), 20);
        if (m.kind === 'caption' && /Timer läuft/.test(m.text)) setTimeout(() => live.stop('stopped'), 50);
      },
      settings: () => ({ name: 'Buddy', language: 'de', voice: 'marin' }),
      onEnd: (i) => ended(i),
    });
    try {
      const r = await live.start();
      assert.ok(r.ok, JSON.stringify(r));
      const info = await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`Zeitüberschreitung: ${ui.map((u) => u.kind).join(',')}`)), 5000))]);
      assert.strictEqual(info.reason, 'stopped');
      // 2 × (110 Text × 0.001 + 250 Ton × 0.01) = 2 × 2.61 BC
      assert.strictEqual(info.credits, '5.220000');
      assert.deepStrictEqual(runs, [{ name: 'set_timer', input: { minutes: 2 } }]);
      assert.deepStrictEqual(seen.map((e) => e.type), ['session.update', 'session.update', 'input_audio_buffer.append', 'conversation.item.create', 'response.create']);
      assert.strictEqual(seen[1].session.audio.input.transcription, null, 'Backend erzwingt: keine Zusatz-Transkription');
      assert.ok(seen[1].session.tools.some((x) => x.name === 'end_conversation'));
      assert.strictEqual(seen[3].item.output, 'Timer 2 Min. läuft');
      assert.ok(ui.some((u) => u.kind === 'tool' && u.label === 'Timer 2 Min.'));
      assert.strictEqual(l.res.size, 0);
      assert.strictEqual(fmt(l.available), '94.780000');
    } finally {
      await app.close();
      await new Promise((r) => { oa.closeAllConnections?.(); oa.close(r); });
    }
  });

  console.log(`\n${n} Tests bestanden`);
})().catch((err) => { console.error(err); process.exit(1); });
