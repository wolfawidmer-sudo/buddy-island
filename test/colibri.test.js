// Colibrì als zweite Laufzeit: Erkennung, Start/Stop, Chat (OpenAI-Stream mit Werkzeugen),
// Installation mit Prüfsumme, Modell-Einrichtung, Laufzeitwahl pro Modell und Wechsel zwischen
// Ollama und Colibrì im Manager. Colibrìs Server und Starter sind nachgebaut; die Formate
// (setup.json, status/list-JSON, /health, SSE) stammen aus dem Colibrì-Quelltext (c/setup_flow.py,
// c/openai_server.py). Der echte Durchlauf läuft in CI unter Windows (test/e2e/colibri.e2e.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createColibri, parseSums, pickAssets, classifyColibri } = require('../src/local/colibri');
const catalog = require('../src/local/catalog');
const hardware = require('../src/local/hardware');
const { createOllama } = require('../src/local/ollama');
const { createLocalManager, isColibri } = require('../src/local/manager');
const { createLocalClient, toOpenAiMessages } = require('../src/llm/local');
const { createMockOllama } = require('./mock-ollama');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-colibri-'));
const setupHome = path.join(tmp, 'colihome');
const launcherDir = path.join(tmp, 'release');
fs.mkdirSync(setupHome, { recursive: true });
fs.mkdirSync(launcherDir, { recursive: true });
fs.writeFileSync(path.join(launcherDir, 'coli'), '#!/usr/bin/env python3\n');
fs.writeFileSync(path.join(launcherDir, 'version.py'), '__version__ = "2.1.0"\n');

// Nachgebauter Colibrì-Server
function mockServer() {
  const ctl = { up: false, loadingRequests: 0, requests: [], reply: 'Grüezi! Wie kann ich helfen?', toolCall: null, arch: 'qwen36' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      ctl.requests.push({ path: req.url, body });
      const json = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/health') {
        if (!ctl.up) { if (ctl.loading) return json(503, { status: 'restarting' }); req.socket.destroy(); return; }
        return json(200, { status: 'ok', arch: ctl.arch, capabilities: ['chat', 'systemone'], input_modalities: ['text'], context_tokens: 16384 });
      }
      if (req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: 'qwen3.6-colibri', object: 'model' }] });
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (ctl.toolCall && body.tools && !body.messages.some((m) => m.role === 'tool')) {
          w({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: ctl.toolCall.name, arguments: '' } }] } }] });
          w({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(ctl.toolCall.arguments).slice(0, 8) } }] } }] });
          w({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(ctl.toolCall.arguments).slice(8) } }] }, finish_reason: 'tool_calls' }] });
        } else {
          for (const piece of ctl.reply.match(/.{1,5}/gs)) w({ choices: [{ index: 0, delta: { content: piece } }] });
          w({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        w({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      json(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ ctl, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}

const writeConfig = (port, extra = {}) => fs.writeFileSync(path.join(setupHome, 'setup.json'), JSON.stringify({
  status: 'ready', model: { id: 'qwen36-35b', name: 'Qwen3.6-35B-A3B', repo: 'Kreuzzelg/qwen36-35b-a3b-colibri-i4-gs64' },
  model_dir: path.join(tmp, 'models', 'qwen36-35b'), family: 'qwen36', launcher: path.join(launcherDir, 'coli'),
  engine: 'qwen36', backend: 'cpu', host: '127.0.0.1', port, urls: {}, ...extra,
}));

// Nachgestellter Starter: antwortet wie `coli` (gleiche JSON-Formate)
const LIST = [
  { id: 'qwen3-coder-30b', name: 'Qwen3-Coder-30B-A3B', kind: 'text', download_gb: 19.4, ram_min_gb: 8, ram_good_gb: 18, dense_gb: 3.6, runs: 'from RAM', status: 'tight', fits: true, reason: 'runs with a small expert cache', recommended: true },
  { id: 'qwen36-35b', name: 'Qwen3.6-35B-A3B', kind: 'text', download_gb: 23.1, ram_min_gb: 10, ram_good_gb: 20, dense_gb: 3.5, runs: 'from RAM', status: 'good', fits: true, reason: '', recommended: false },
  { id: 'qwen-image-2.1', name: 'Qwen-Image-2.1', kind: 'image', download_gb: 33.1, fits: true },
  { id: 'glm-5.2', name: 'GLM-5.2', kind: 'text', download_gb: 429, ram_min_gb: 16, ram_good_gb: 24, runs: 'streams experts from the SSD', status: 'needs-disk', fits: false, reason: 'needs 440 GB free for the download' },
];
function fakeColi(srv, calls) {
  return async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args.includes('-c')) return { code: 0, out: '3.12.4' };
    const sub = args.slice(args.findIndex((a) => a.endsWith('coli')) + 1);
    if (sub[0] === 'setup' && sub.includes('--list')) return { code: 0, out: `Detecting hardware…\n${JSON.stringify(LIST)}` };
    if (sub[0] === 'status') return { code: 0, out: JSON.stringify({ configured: true }) };
    if (sub[0] === 'start') { srv.ctl.loading = true; setTimeout(() => { srv.ctl.up = true; srv.ctl.loading = false; }, 1200); return { code: 0, out: 'Starting colibri' }; }
    if (sub[0] === 'stop') { srv.ctl.up = false; return { code: 0, out: 'stopped' }; }
    if (sub[0] === 'logs') return { code: 0, out: 'serve log' };
    if (sub[0] === 'import') { const out = sub[sub.indexOf('--out') + 1]; fs.mkdirSync(out, { recursive: true }); return { code: 0, out: `colibri model directory ready: ${out}` }; }
    if (cmd === 'powershell.exe' && /Expand-Archive/.test(args.join(' '))) {
      const dest = /-DestinationPath '([^']+)'/.exec(args.join(' '))[1];
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'coli'), '#!/usr/bin/env python3\n');
      return { code: 0, out: '' };
    }
    return { code: 1, out: `unbekannt: ${sub.join(' ')}` };
  };
}

(async () => {
  // ---------------- Hilfsfunktionen ----------------
  const sums = parseSums('0f'.repeat(32) + '  colibri-v2.1.0-windows-x86_64.zip\n' + 'ab'.repeat(32) + ' *SHA256SUMS-ignored\nquatsch');
  assert.strictEqual(sums['colibri-v2.1.0-windows-x86_64.zip'], '0f'.repeat(32));
  const rel = { tag_name: 'v2.1.0', assets: [
    { name: 'colibri-v2.1.0-linux-x86_64.tar.gz', size: 10, browser_download_url: 'https://x/linux' },
    { name: 'colibri-v2.1.0-windows-x86_64.zip', size: 30e6, browser_download_url: 'https://x/win' },
    { name: 'colibri-v2.1.0-windows-x86_64-cuda.zip', size: 400e6, browser_download_url: 'https://x/cuda' },
    { name: 'SHA256SUMS.txt', size: 500, browser_download_url: 'https://x/sums' },
  ] };
  assert.strictEqual(pickAssets(rel).cuda, null, 'CUDA nur auf Wunsch (ab Compute 8.0)');
  assert.strictEqual(pickAssets(rel, { cudaOk: true }).cuda.size, 400e6);
  assert.strictEqual(pickAssets({ assets: [] }), null);
  assert.strictEqual(classifyColibri('plan warning: RAM budget cannot hold one expert slot'), 'out_of_memory');
  assert.strictEqual(classifyColibri('needs 440 GB free for the download'), 'disk_full');

  // Laufzeitwahl: Ollama, wenn es passt; Colibrì nur wenn nötig und nie, nur weil installiert
  const cat = catalog.validateCatalog(catalog.BUNDLED);
  const q36 = cat.find((c) => c.id === 'qwen3.6:35b');
  assert.strictEqual(q36.colibri, 'qwen36-35b');
  const box = (ram, vram) => ({ ram: { totalGB: ram, freeGB: ram * 0.6 }, cpu: { threads: 12, avx2: true }, primary: vram ? { vramGB: vram, freeVramGB: null } : null, gpus: [] });
  const ce = { fits: true, runs: 'from RAM' };
  assert.deepStrictEqual(catalog.chooseRuntime({ plan: catalog.planFor(q36, box(64, 24)), colibri: ce, colibriInstalled: true, prefer: 'auto' }), { runtime: 'ollama', reason: 'fits_memory' });
  // Standard «immer Colibrì»: auch mit grosser Grafikkarte, sobald Colibrì das Modell kann
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(q36, box(64, 24)), colibri: ce, colibriInstalled: true }).reason, 'colibri_preferred');
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(q36, box(64, 24)), colibri: { fits: false, status: 'needs-ram' }, colibriInstalled: true }).runtime, 'ollama', 'kann Colibrì es hier nicht: Ollama als Ausweich');
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(q36, box(16, 0)), colibri: ce, colibriInstalled: true }).runtime, 'colibri');
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(q36, box(16, 0)), colibri: ce, colibriInstalled: false }).reason, 'colibri_not_installed');
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(q36, box(16, 0)), colibri: { fits: false, status: 'needs-disk' }, colibriInstalled: true }).reason, 'needs_disk');
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(q36, box(16, 0)), colibri: ce, colibriInstalled: true, disk: { media: 'hdd' } }).note, 'hdd_slow');
  // Grosses Modell läuft bei Ollama nur auf dem Prozessor (48 GB, keine Grafikkarte): Colibrì ist
  // gemessen schneller und wird automatisch gewählt; ohne Colibrì bleibt Ollama, mit Angebot
  const q36cpu = catalog.planFor(q36, box(48, 0));
  assert.ok(q36cpu.fits && q36cpu.device === 'cpu', `Plan passt auf dem Prozessor (${JSON.stringify(q36cpu)})`);
  assert.deepStrictEqual(catalog.chooseRuntime({ plan: q36cpu, colibri: ce, colibriInstalled: true, prefer: 'auto' }), { runtime: 'colibri', reason: 'colibri_faster', note: undefined });
  const offer = catalog.chooseRuntime({ plan: q36cpu, colibri: ce, colibriInstalled: false, prefer: 'auto' });
  assert.ok(offer.runtime === 'ollama' && offer.better === 'colibri', 'ohne Colibrì: Ollama, aber Colibrì angeboten');
  // Ohne «immer Colibrì»: kleines Modell, das passt, nie Colibrì
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(cat.find((c) => c.id === 'qwen3.5:4b'), box(16, 0)), colibri: ce, colibriInstalled: true, prefer: 'auto' }).runtime, 'ollama');
  // Modell ohne Colibrì-Gegenstück (colibri: null): immer Ollama
  assert.strictEqual(catalog.chooseRuntime({ plan: catalog.planFor(cat.find((c) => c.id === 'qwen3.5:4b'), box(16, 0)), colibri: null, colibriInstalled: true }).runtime, 'ollama');
  // Colibrì-Modelle tauchen nie in den drei Ollama-Empfehlungen auf
  const reg = Object.fromEntries(cat.map((m) => [m.id, { available: true, sizeBytes: m.sizeGB * 1024 ** 3 }]));
  const r16 = catalog.recommend(box(16, 0), cat, { registry: reg });
  for (const p of [r16.recommended, r16.fastest, r16.best].filter(Boolean)) assert.ok(p.plan.fits && p.id !== 'qwen3.6:35b');

  // Speicherart des Laufwerks
  assert.deepStrictEqual(hardware.parseStorage({ media: 'SSD', bus: 'NVMe' }), { media: 'ssd', bus: 'nvme' });
  assert.deepStrictEqual(hardware.parseStorage({ media: 'HDD', bus: 'SATA' }), { media: 'hdd', bus: 'sata' });
  assert.deepStrictEqual(hardware.parseStorage({ media: '4', bus: '17' }), { media: 'ssd', bus: 'nvme' }, 'Zahlenwerte von Windows');
  assert.deepStrictEqual(await hardware.storageType('D:\\models', { platform: 'win32', runImpl: async () => '{"media":"SSD","bus":"NVMe"}' }), { media: 'ssd', bus: 'nvme' });
  assert.deepStrictEqual(await hardware.storageType('D:\\models', { platform: 'win32', runImpl: async () => null }), { media: null, bus: null }, 'unbekannt bleibt null');
  assert.deepStrictEqual(await hardware.storageType('/data', { platform: 'linux', runImpl: async () => 'Filesystem\n/dev/nvme0n1p2', readFile: () => '0\n' }), { media: 'ssd', bus: 'nvme' });
  assert.deepStrictEqual(await hardware.storageType('/data', { platform: 'linux', runImpl: async () => 'Filesystem\n/dev/sdb1', readFile: () => '1' }), { media: 'hdd', bus: null });

  // OpenAI-Nachrichten für Colibrì: Werkzeug-IDs passen zusammen
  const oa = toOpenAiMessages([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Timer' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'set_timer', arguments: { minutes: 5 } } }] },
    { role: 'tool', tool_name: 'set_timer', content: 'ok' },
    { role: 'user', content: 'Bild', images: ['AAA'] },
  ]);
  assert.strictEqual(oa[2].tool_calls[0].id, oa[3].tool_call_id);
  assert.strictEqual(oa[2].tool_calls[0].function.arguments, '{"minutes":5}');
  assert.strictEqual(oa[4].content[1].image_url.url, 'data:image/png;base64,AAA');

  // ---------------- Laufzeit gegen den nachgebauten Server ----------------
  const srv = await mockServer();
  const calls = [];
  const env = { COLI_SETUP_HOME: setupHome };
  const col = createColibri({ env, platform: 'linux', home: tmp, installRoot: path.join(tmp, 'buddy-colibri'), runImpl: fakeColi(srv, calls), tmpDir: tmp });
  // Nicht eingerichtet
  let d = await col.detect();
  assert.strictEqual(d.installed, false);
  assert.strictEqual(d.configured, false);
  await assert.rejects(col.start(), (e) => e.code === 'runtime_missing');
  writeConfig(srv.port);
  d = await col.detect();
  assert.strictEqual(d.installed, true);
  assert.strictEqual(d.version, '2.1.0');
  assert.strictEqual(d.configured, true);
  assert.strictEqual(d.model.id, 'qwen36-35b');
  assert.strictEqual(d.state, 'stopped');
  assert.ok(!calls.some((c) => / status/.test(c)), 'Erkennung ohne Python-Aufruf');
  // Modellliste von Colibrì selbst (Text vor dem JSON wird übersprungen)
  const list = await col.catalog();
  assert.strictEqual(list.length, 4);
  assert.strictEqual(list[3].fits, false);
  const n = calls.length;
  await col.catalog();
  assert.strictEqual(calls.length, n, 'Liste wird zwischengespeichert');
  // Start: Server lädt, dann bereit; Fortschritt wird gemeldet
  const progress = [];
  const st = await col.start({ onProgress: (p) => progress.push(p.phase) });
  assert.strictEqual(st.reused, false);
  assert.ok(st.loadMs >= 1000);
  assert.ok(progress.includes('starting') && progress.includes('loading'));
  assert.ok(calls.some((c) => /start --background --no-browser/.test(c)));
  assert.strictEqual((await col.detect()).running, true);
  // Läuft schon: mitbenutzen, nicht nochmals starten
  const startsBefore = calls.filter((c) => / start /.test(c)).length;
  assert.strictEqual((await col.start()).reused, true);
  assert.strictEqual(calls.filter((c) => / start /.test(c)).length, startsBefore);
  // Fähigkeiten aus /health und Colibrìs Werkzeug-Tabelle
  assert.deepStrictEqual(col.capabilities(), { tools: true, vision: false, contextTokens: 16384, arch: 'qwen36' });
  // Chat mit Streaming
  let streamed = '';
  const c1 = await col.chat({ messages: [{ role: 'user', content: 'Hoi' }], options: { temperature: 0.5, max_tokens: 64 }, onDelta: (x) => { streamed += x; } });
  assert.strictEqual(streamed, 'Grüezi! Wie kann ich helfen?');
  assert.strictEqual(c1.evalTokens, 8);
  assert.strictEqual(c1.promptTokens, 30);
  const sent = srv.ctl.requests.filter((r) => r.path === '/v1/chat/completions').pop().body;
  assert.strictEqual(sent.model, 'qwen3.6-colibri', 'Modell-ID vom Server');
  assert.strictEqual(sent.stream, true);
  assert.strictEqual(sent.temperature, 0.5);
  assert.strictEqual(sent.max_tokens, 64);
  // Werkzeugaufruf in Teilen
  srv.ctl.toolCall = { name: 'set_timer', arguments: { minutes: 10, label: 'Pizza' } };
  const c2 = await col.chat({ messages: [{ role: 'user', content: 'Timer' }], tools: [{ type: 'function', function: { name: 'set_timer', parameters: {} } }] });
  assert.deepStrictEqual(c2.toolCalls, [{ function: { name: 'set_timer', arguments: { minutes: 10, label: 'Pizza' } } }]);
  srv.ctl.toolCall = null;
  // Stop: nur, was Buddy selbst gestartet hat
  assert.strictEqual(await col.stop(), true);
  assert.strictEqual((await col.detect()).running, false);
  srv.ctl.up = true; // fremd gestartet (z. B. START-HERE.bat)
  const col2 = createColibri({ env, platform: 'linux', home: tmp, runImpl: fakeColi(srv, calls), tmpDir: tmp });
  assert.strictEqual((await col2.start()).reused, true);
  assert.strictEqual(await col2.stop(), false, 'fremden Colibrì-Server nie beenden');
  assert.strictEqual(srv.ctl.up, true);
  // Start abbrechen
  srv.ctl.up = false;
  const ac = new AbortController();
  const col3 = createColibri({ env, platform: 'linux', home: tmp, runImpl: async (cmd, args) => (args.includes('start') ? (srv.ctl.loading = true, { code: 0, out: '' }) : fakeColi(srv, calls)(cmd, args)), tmpDir: tmp });
  fs.writeFileSync(path.join(tmp, `coli-serve-${srv.port}.pid`), String(process.pid)); // «lädt noch»
  setTimeout(() => ac.abort(), 1500);
  await assert.rejects(col3.start({ signal: ac.signal }), (e) => e.name === 'AbortError');
  // Server beendet sich beim Laden: ehrlicher Fehler
  fs.rmSync(path.join(tmp, `coli-serve-${srv.port}.pid`));
  srv.ctl.loading = false;
  const col4 = createColibri({ env, platform: 'linux', home: tmp, runImpl: async (cmd, args) => (args.includes('start') ? { code: 0, out: '' } : args.includes('logs') ? { code: 0, out: 'plan warning: RAM budget cannot hold one expert slot' } : fakeColi(srv, calls)(cmd, args)), tmpDir: tmp });
  await assert.rejects(col4.start(), (e) => e.code === 'out_of_memory');
  // Ohne Python: klare Meldung
  const noPy = createColibri({ env, platform: 'linux', home: tmp, runImpl: async () => ({ code: 1, out: '' }), tmpDir: tmp });
  await assert.rejects(noPy.catalog(), (e) => e.code === 'python_missing');

  // ---------------- Installation unter Windows: Prüfsumme ----------------
  const zip = Buffer.from('PK fake colibri archive');
  const good = crypto.createHash('sha256').update(zip).digest('hex');
  const mkRemote = (hash) => async (url) => {
    if (/releases\/latest/.test(url)) return new Response(JSON.stringify(rel));
    if (url === 'https://x/sums') return new Response(`${hash}  colibri-v2.1.0-windows-x86_64.zip\n`);
    if (url === 'https://x/win') return new Response(zip, { headers: { 'content-length': String(zip.length) } });
    return new Response('', { status: 404 });
  };
  const installRoot = path.join(tmp, 'buddy-install');
  const winCalls = [];
  const winEnv = { COLI_SETUP_HOME: path.join(tmp, 'emptyhome') };
  const winCol = createColibri({ env: winEnv, platform: 'win32', home: tmp, installRoot, tmpDir: tmp, remoteFetch: mkRemote(good), runImpl: fakeColi(srv, winCalls) });
  const plan = await winCol.installPlan();
  assert.strictEqual(plan.automatic, true);
  assert.strictEqual(plan.python, true);
  assert.strictEqual(plan.sizeBytes, 30e6);
  const phases = [];
  const inst = await winCol.install({ onProgress: (p) => phases.push(p.phase) });
  assert.strictEqual(inst.tag, 'v2.1.0');
  assert.ok(fs.existsSync(path.join(installRoot, 'v2.1.0', 'coli')));
  assert.deepStrictEqual([...new Set(phases)], ['download', 'verify', 'install']);
  assert.strictEqual((await winCol.detect()).installed, true, 'danach erkannt');
  // Falsche Prüfsumme: nichts entpacken, nichts ausführen
  const badRoot = path.join(tmp, 'buddy-bad');
  const badCalls = [];
  const badCol = createColibri({ env: winEnv, platform: 'win32', home: tmp, installRoot: badRoot, tmpDir: tmp, remoteFetch: mkRemote('00'.repeat(32)), runImpl: fakeColi(srv, badCalls) });
  await assert.rejects(badCol.install(), (e) => e.code === 'checksum_mismatch');
  assert.ok(!badCalls.some((c) => /Expand-Archive/.test(c)), 'nicht entpackt');
  assert.ok(!fs.existsSync(path.join(badRoot, 'v2.1.0', 'coli')));

  // ---------------- Modell einrichten (Download über coli setup) ----------------
  const fakeProc = () => {
    const { EventEmitter } = require('events');
    const p = new EventEmitter();
    p.pid = 4242;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => p.emit('exit', 1);
    return p;
  };
  const statePath = path.join(setupHome, 'install-state.json');
  let spawnArgs = null;
  const setupCol = createColibri({
    env, platform: 'linux', home: tmp, tmpDir: tmp, runImpl: fakeColi(srv, calls),
    spawnImpl: (exe, args) => {
      spawnArgs = args;
      const p = fakeProc();
      let done = 0;
      const timer = setInterval(() => {
        done += 5e9;
        fs.writeFileSync(statePath, JSON.stringify({ phase: done >= 20e9 ? 'ready' : 'download', done: Math.min(done, 20e9), total: 20e9, rate: 1e9 }));
        if (done >= 20e9) { clearInterval(timer); p.emit('exit', 0); }
      }, 900);
      return p;
    },
  });
  const sp = [];
  await setupCol.setupModel('qwen3-coder-30b', { dir: path.join(tmp, 'm'), onProgress: (p) => sp.push(p) });
  assert.ok(spawnArgs.includes('--model') && spawnArgs.includes('qwen3-coder-30b') && spawnArgs.includes('--no-start') && spawnArgs.includes('--yes'));
  assert.ok(spawnArgs.includes('--dir'));
  assert.ok(sp.some((p) => p.phase === 'download' && p.totalBytes === 20e9));
  // Fehler beim Einrichten: Meldung aus Colibrìs Zustand
  const failCol = createColibri({ env, platform: 'linux', home: tmp, tmpDir: tmp, runImpl: fakeColi(srv, calls), spawnImpl: () => {
    const p = fakeProc();
    setTimeout(() => { fs.writeFileSync(statePath, JSON.stringify({ phase: 'error', message: 'needs 25 GB free for the download' })); p.emit('exit', 1); }, 100);
    return p;
  } });
  await assert.rejects(failCol.setupModel('qwen36-35b'), (e) => e.code === 'disk_full');
  await assert.rejects(failCol.setupModel('../../evil'), (e) => e.code === 'error', 'ungültige ID');
  fs.rmSync(statePath, { force: true });

  // ---------------- Manager: Wechsel zwischen Ollama und Colibrì ----------------
  writeConfig(srv.port);
  srv.ctl.up = false;
  const ollamaMock = await createMockOllama({ models: { 'qwen3:4b': { size: 2.5e9, caps: ['completion', 'tools', 'thinking'] } } });
  const rt = createOllama({ host: ollamaMock.host, platform: 'linux', home: tmp, env: {} });
  const mcalls = [];
  const mcol = createColibri({ env, platform: 'linux', home: tmp, tmpDir: tmp, runImpl: fakeColi(srv, mcalls) });
  let config = { model: 'qwen3:4b', modelsDir: null, tools: true, unloadOnExit: true, advanced: {} };
  const hwFixed = { os: { platform: 'linux', name: 'Linux', arch: 'x64' }, cpu: { name: 'CPU', threads: 16, cores: 8, avx2: true }, ram: { totalGB: 32, freeGB: 24 }, gpus: [], primary: null, disk: { path: tmp, freeGB: 300, media: 'ssd', bus: 'nvme' }, backends: ['cpu'], errors: [] };
  const mgr = createLocalManager({ runtime: rt, colibri: mcol, cacheDir: tmp, getConfig: () => config, setConfig: (p) => { config = { ...config, ...p }; }, detectHardware: async () => JSON.parse(JSON.stringify(hwFixed)), freeRamGB: () => 24 });
  let s = await mgr.init();
  assert.ok(s.installed.some((m) => m.id === '@colibri/qwen36-35b' && m.runtime === 'colibri'), 'Colibrì-Modell in der Liste');
  assert.ok(s.installed.some((m) => m.id === 'qwen3:4b' && m.runtime === 'ollama'));
  assert.strictEqual(s.colibri.installed, true);
  // Zuerst Ollama
  await mgr.ensureLoaded('qwen3:4b');
  assert.deepStrictEqual([...ollamaMock.ctl.loaded.keys()], ['qwen3:4b']);
  // Wechsel zu Colibrì: Ollama-Modell wird freigegeben, Colibrì gestartet
  s = await mgr.selectModel('@colibri/qwen36-35b');
  assert.strictEqual(s.phase, 'ready');
  assert.strictEqual(s.loaded.runtime, 'colibri');
  assert.strictEqual(s.loaded.device, 'cpu', 'Backend cpu: nie «Grafikkarte» behaupten');
  assert.strictEqual(ollamaMock.ctl.loaded.size, 0, 'Ollama-Modell freigegeben');
  assert.strictEqual(srv.ctl.up, true);
  assert.ok(isColibri(config.model));
  // Chat über den Adapter geht an Colibrì, mit Systemtext
  const client = createLocalClient({ manager: mgr });
  let deltas = '';
  const res = await client.streamMessage({ apiKey: '', model: 'local:@colibri/qwen36-35b', system: 'Du bist Buddy.', messages: [{ role: 'user', content: 'Hoi' }], maxTokens: 128, onText: (x) => { deltas += x; } });
  assert.strictEqual(deltas, 'Grüezi! Wie kann ich helfen?');
  assert.strictEqual(res.stopReason, 'end_turn');
  const last = srv.ctl.requests.filter((r) => r.path === '/v1/chat/completions').pop().body;
  assert.strictEqual(last.messages[0].role, 'system');
  assert.ok(/Du bist Buddy/.test(last.messages[0].content));
  // Werkzeuge mit Colibrì (Qwen3.6 kann sie laut Colibrì)
  srv.ctl.toolCall = { name: 'set_timer', arguments: { minutes: 3 } };
  const tr = await client.streamMessage({ apiKey: '', model: 'local:@colibri/qwen36-35b', messages: [{ role: 'user', content: 'Timer' }], tools: [{ name: 'set_timer', description: 'Timer', input_schema: { type: 'object' } }], maxTokens: 64 });
  assert.strictEqual(tr.stopReason, 'tool_use');
  srv.ctl.toolCall = null;
  // Gesprächsverlauf bleibt beim Zurückwechseln erhalten: derselbe Adapter, gleiche Nachrichten
  s = await mgr.selectModel('qwen3:4b');
  assert.strictEqual(s.loaded.id, 'qwen3:4b');
  assert.strictEqual(srv.ctl.up, false, 'Colibrì beendet (von Buddy gestartet)');
  const back = await client.streamMessage({ apiKey: '', model: 'local:qwen3:4b', messages: [{ role: 'user', content: 'Hoi' }, { role: 'assistant', content: 'Grüezi!' }, { role: 'user', content: 'Und jetzt?' }], maxTokens: 64 });
  assert.ok(back.content.length);
  // Colibrì-Modelle löscht Buddy nicht
  await assert.rejects(mgr.removeModel('@colibri/qwen36-35b'), (e) => e.code === 'manual');
  // Colibrì-Liste mit Laufzeitwahl: Qwen3.6 passt mit 32 GB nicht ganz → Colibrì; Bilder ausgeblendet
  const cc = await mgr.colibriCatalog();
  assert.ok(!cc.some((m) => m.kind === 'image'));
  const q = cc.find((m) => m.colibriId === 'qwen36-35b');
  assert.strictEqual(q.ollamaTwin.id, 'qwen3.6:35b');
  assert.strictEqual(q.choice.runtime, 'colibri');
  // Colibrì-Modell weg (z. B. in Colibrì neu eingerichtet): Fehler statt stillem Wechsel
  config.model = '@colibri/qwen36-35b';
  fs.writeFileSync(path.join(setupHome, 'setup.json'), JSON.stringify({ status: 'ready', model: { id: 'qwen3-coder-30b', name: 'Qwen3-Coder' }, launcher: path.join(launcherDir, 'coli'), host: '127.0.0.1', port: srv.port }));
  s = await mgr.refresh();
  assert.strictEqual(s.phase, 'error');
  assert.strictEqual(s.error.code, 'not_found');
  assert.strictEqual(config.model, '@colibri/qwen36-35b', 'Auswahl nicht still geändert');
  // Beenden: eigener Colibrì-Server wird beendet
  writeConfig(srv.port);
  await mgr.refresh();
  await mgr.selectModel('@colibri/qwen36-35b');
  assert.strictEqual(srv.ctl.up, true);
  await mgr.shutdown();
  assert.strictEqual(srv.ctl.up, false);

  // ---------------- Automatisch schneller: Ollama-Modell mit einem Klick auf Colibrì ----------------
  {
    // qwen3.6:35b liegt schon bei Ollama (Manifest und Datei auf der Platte, wie bei Ollama)
    const om = await createMockOllama({ models: { 'qwen3.6:35b': { size: 23e9, caps: ['completion', 'tools'] } } });
    const ort = createOllama({ host: om.host, platform: 'linux', home: tmp, env: {} });
    const mdir = ort.getModelsDir();
    fs.mkdirSync(path.join(mdir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3.6'), { recursive: true });
    fs.mkdirSync(path.join(mdir, 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(mdir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3.6', '35b'), JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }));
    fs.writeFileSync(path.join(mdir, 'blobs', 'sha256-abc123'), 'GGUF');
    // Colibrì ist installiert, aber noch ohne Modell
    fs.writeFileSync(path.join(setupHome, 'setup.json'), JSON.stringify({ launcher: path.join(launcherDir, 'coli'), host: '127.0.0.1', port: srv.port }));
    srv.ctl.up = false;
    let setupArgs = null;
    const acol = createColibri({ env, platform: 'linux', home: tmp, tmpDir: tmp, runImpl: fakeColi(srv, []), spawnImpl: (exe, args) => {
      setupArgs = args;
      const p = fakeProc();
      setTimeout(() => {
        fs.writeFileSync(path.join(setupHome, 'setup.json'), JSON.stringify({ status: 'ready', model: { id: 'qwen3.6-35b-ollama', name: 'qwen3.6-35b-ollama' }, launcher: path.join(launcherDir, 'coli'), host: '127.0.0.1', port: srv.port }));
        fs.writeFileSync(path.join(setupHome, 'install-state.json'), JSON.stringify({ phase: 'ready' }));
        p.emit('exit', 0);
      }, 50);
      return p;
    } });
    let acfg = { model: null, modelsDir: null, tools: true, unloadOnExit: true, advanced: {}, colibriTwins: {} };
    const hw32 = { os: { platform: 'linux', name: 'Linux', arch: 'x64' }, cpu: { name: 'CPU', threads: 16, cores: 8, avx2: true }, ram: { totalGB: 32, freeGB: 24 }, gpus: [], primary: null, disk: { path: tmp, freeGB: 300, media: 'ssd', bus: 'nvme' }, backends: ['cpu'], errors: [] };
    const amgr = createLocalManager({ runtime: ort, colibri: acol, cacheDir: tmp, getConfig: () => acfg, setConfig: (p) => { acfg = { ...acfg, ...p }; }, detectHardware: async () => JSON.parse(JSON.stringify(hw32)), freeRamGB: () => 24 });
    let st = await amgr.init();
    // Angebot: vorhandenes Ollama-Modell, kein neuer Download
    assert.ok(st.colibriOffer || st.colibriAuto, 'Angebot erscheint');
    assert.strictEqual((st.colibriOffer || st.colibriAuto).id, 'qwen3.6:35b');
    if (st.colibriOffer) assert.strictEqual(st.colibriOffer.fromOllama, true);
    // Colibrì ist da, das Modell liegt bei Ollama: Buddy stellt ohne Rückfrage selbst um (kein Download)
    for (let i = 0; i < 100 && amgr.snapshot().loaded?.runtime !== 'colibri'; i += 1) await new Promise((r) => setTimeout(r, 100));
    st = amgr.snapshot();
    assert.ok(!st.colibriAuto, `fertig ohne Fehler (${JSON.stringify(st.colibriAuto)})`);
    assert.ok(setupArgs.includes('--model-dir') && !setupArgs.includes('--model'), 'Colibrì nutzt die übernommene Datei, lädt nichts');
    assert.ok(fs.existsSync(path.join(mdir, 'blobs', 'qwen3.6-35b.gguf')), 'fester Link auf die Ollama-Datei');
    assert.strictEqual(acfg.colibriTwins['qwen3.6:35b'], '@colibri/qwen3.6-35b-ollama', 'Zuordnung gemerkt');
    assert.strictEqual(st.loaded?.runtime, 'colibri');
    assert.strictEqual(st.colibriOffer, null, 'kein Angebot mehr');
    // Danach automatisch: wer das Ollama-Modell wählt, bekommt Colibrì
    await amgr.selectModel('qwen3.6:35b');
    assert.strictEqual(acfg.model, '@colibri/qwen3.6-35b-ollama');
    // Abschaltbar: dann wieder Ollama
    acfg.autoRuntime = false;
    await amgr.selectModel('qwen3.6:35b').catch(() => {});
    assert.strictEqual(acfg.model, 'qwen3.6:35b');
    await amgr.shutdown();
    await om.close();
  }

  await srv.close();
  await ollamaMock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Colibrì-Tests ok (Erkennung, Start/Stop, Chat, Werkzeuge, Installation mit Prüfsumme, Einrichtung, Laufzeitwahl, Wechsel Ollama ↔ Colibrì)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
