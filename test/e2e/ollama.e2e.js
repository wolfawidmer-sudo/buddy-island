// Echter Durchlauf der lokalen KI mit Ollama (kein Nachbau): Hardware erkennen, Ollama finden
// oder mit Buddys eigenem Installer installieren (Signaturprüfung inklusive), Modell
// herunterladen, laden, auf Deutsch und Englisch chatten, abbrechen, Modell wechseln und löschen.
// Schreibt gemessene Zeiten in test-results/ollama-e2e.json. Erfundene Zahlen gibt es nicht:
// was nicht gemessen werden konnte, steht als null drin.
//
// Aufruf: npm run test:ollama            (Modell: BUDDY_E2E_MODEL, Standard qwen3.5:0.8b)
//         BUDDY_E2E_INSTALL=1 npm run test:ollama   installiert Ollama, falls es fehlt (nur Windows)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hardware = require('../../src/local/hardware');
const { createOllama } = require('../../src/local/ollama');
const { createLocalManager, cleanAdvanced } = require('../../src/local/manager');
const { createLocalClient } = require('../../src/llm/local');

const MODEL = process.env.BUDDY_E2E_MODEL || 'qwen3.5:0.8b';
const SECOND = process.env.BUDDY_E2E_MODEL2 || '';
const out = { model: MODEL, platform: `${os.type()} ${os.release()}`, steps: [], measurements: {} };
const t0 = Date.now();
const step = (name, data = {}) => { const e = { name, ms: Date.now() - t0, ...data }; out.steps.push(e); console.log(`[${(e.ms / 1000).toFixed(1)} s] ${name}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`); };

function rssOf(pid) {
  try {
    if (process.platform === 'win32') {
      const r = require('child_process').execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const kb = Number((r.split('","')[4] || '').replace(/[^\d]/g, ''));
      return kb ? Math.round(kb / 1024) : null;
    }
    const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ollama-e2e-'));
  // 1) Hardware
  const hw = await hardware.detect({ modelsDir: path.join(os.homedir(), '.ollama', 'models') });
  out.hardware = { summary: hardware.summary(hw), gpus: hw.gpus, cpu: hw.cpu, errors: hw.errors };
  step('Hardware erkannt', hardware.summary(hw));
  assert.ok(hw.ram.totalGB > 0);
  assert.ok(hw.cpu.threads > 0);
  if (process.platform === 'win32') assert.ok(!hw.errors.includes('windows_probe'), 'PowerShell-Erkennung muss unter Windows klappen');

  // 2) Laufzeit
  const rt = createOllama({ log: (m) => console.log(`  ${m}`) });
  let det = await rt.detect();
  step('Ollama geprüft', { installed: det.installed, running: det.running, version: det.version });
  if (!det.installed) {
    if (process.env.BUDDY_E2E_INSTALL !== '1') throw new Error('Ollama fehlt (BUDDY_E2E_INSTALL=1 setzt Buddys Installer ein)');
    const plan = await rt.installPlan();
    step('Installationsplan', plan);
    const started = Date.now();
    await rt.install({ onProgress: (p) => { if (p.phase !== 'download') console.log(`  Installation: ${p.phase}`); } });
    out.measurements.runtimeInstallMs = Date.now() - started;
    det = await rt.detect();
    step('Ollama installiert', { version: det.version });
  }
  const startT = Date.now();
  await rt.start();
  out.measurements.runtimeReadyMs = Date.now() - startT;
  det = await rt.detect();
  assert.ok(det.running, 'Ollama läuft');
  step('Ollama bereit', { version: det.version, managed: det.managed });

  // 3) Manager, Empfehlung, Download
  let config = { model: null, modelsDir: null, tools: true, unloadOnExit: true, advanced: cleanAdvanced({}) };
  const mgr = createLocalManager({ runtime: rt, cacheDir: dir, remoteFetch: fetch, getConfig: () => config, setConfig: (p) => { config = { ...config, ...p }; }, log: (m) => console.log(`  ${m}`) });
  await mgr.init();
  await mgr.refreshRegistry();
  const snap = mgr.snapshot();
  out.picks = { recommended: snap.picks?.recommended?.id || null, fastest: snap.picks?.fastest?.id || null, best: snap.picks?.best?.id || null, mode: snap.picks?.mode };
  step('Empfehlung', out.picks);
  assert.ok(snap.picks?.recommended, 'Es gibt eine Empfehlung');
  const already = snap.installed.some((m) => m.id === MODEL);
  const pullStart = Date.now();
  let lastPct = -10;
  const off = mgr.onChange((s) => { if (s.download && s.download.percent !== null && s.download.percent - lastPct >= 10) { lastPct = s.download.percent; console.log(`  Download ${Math.floor(s.download.percent)} % ${s.download.speedBps ? `${(s.download.speedBps / 1e6).toFixed(1)} MB/s` : ''}`); } });
  const afterPull = await mgr.pull(MODEL);
  off();
  if (!already) out.measurements.downloadMs = Date.now() - pullStart;
  out.measurements.downloadBytes = afterPull.installed.find((m) => m.id === MODEL)?.sizeBytes || null;
  assert.strictEqual(afterPull.phase, 'ready', `Modell bereit (${JSON.stringify(afterPull.error)})`);
  out.measurements.loadMs = afterPull.loaded.loadMs;
  out.loaded = afterPull.loaded;
  step('Modell geladen und getestet', afterPull.loaded);
  // Kein zweiter Download
  const again = Date.now();
  await mgr.pull(MODEL);
  assert.ok(Date.now() - again < 15000, 'schon installiert: kein Download');

  // 4) Chat Deutsch / Englisch / Schweizerdeutsch mit Streaming
  const client = createLocalClient({ manager: mgr, getAdvanced: () => cleanAdvanced({}) });
  const ask = async (label, text) => {
    let first = 0;
    let pieces = 0;
    const s = Date.now();
    const r = await client.streamMessage({ apiKey: '', model: `local:${MODEL}`, system: 'Du bist Buddy, ein freundlicher Assistent. Antworte kurz.', messages: [{ role: 'user', content: text }], maxTokens: 160, onText: () => { if (!first) first = Date.now() - s; pieces += 1; } });
    const answer = r.content.map((b) => b.text || '').join('').trim();
    const perf = mgr.snapshot().perf;
    step(`Chat ${label}`, { firstTokenMs: first, pieces, tokensPerSecond: perf?.tokensPerSecond, answer: answer.slice(0, 160) });
    assert.ok(answer.length > 0, `${label}: Antwort`);
    assert.ok(pieces > 1, `${label}: gestreamt`);
    return { firstTokenMs: first, tokensPerSecond: perf?.tokensPerSecond ?? null, answer };
  };
  out.chat = {
    de: await ask('Deutsch', 'Erkläre in zwei Sätzen, was ein Arbeitsspeicher ist.'),
    en: await ask('Englisch', 'Explain in two sentences what RAM is.'),
    gsw: await ask('Schweizerdeutsch', 'Chasch mer churz säge, was es Betriebssystem isch?'),
    code: await ask('Code', 'Schreib eine JavaScript-Funktion, die zwei Zahlen addiert.'),
  };
  out.measurements.firstTokenMs = out.chat.de.firstTokenMs;
  out.measurements.tokensPerSecond = out.chat.de.tokensPerSecond;
  const ps = await rt.ps();
  const mine = ps.find((m) => m.id === MODEL);
  out.measurements.modelMemoryBytes = mine?.sizeBytes ?? null;
  out.measurements.vramBytes = mine?.vramBytes ?? null;
  out.measurements.buddyRssMB = rssOf(process.pid);

  // 5) Abbrechen mitten in der Antwort
  const ac = new AbortController();
  let got = 0;
  const p = client.streamMessage({ apiKey: '', model: `local:${MODEL}`, messages: [{ role: 'user', content: 'Zähle langsam von 1 bis 200, jede Zahl auf eine Zeile.' }], maxTokens: 800, signal: ac.signal, onText: () => { got += 1; if (got === 5) ac.abort(); } });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  step('Abbrechen klappt', { chunksBeforeStop: got });
  // Nach dem Abbruch antwortet das Modell weiter normal
  await ask('nach Abbruch', 'Sag Hallo.');

  // 6) Modellwechsel (optional) und Löschen
  if (SECOND) {
    await mgr.pull(SECOND);
    const loaded = (await rt.ps()).map((m) => m.id);
    assert.ok(!loaded.includes(MODEL), 'vorheriges Modell freigegeben');
    step('Modell gewechselt', { loaded });
    await mgr.removeModel(SECOND);
  }
  if (process.env.BUDDY_E2E_DELETE === '1') {
    await mgr.removeModel(MODEL);
    assert.ok(!(await rt.list()).some((m) => m.id === MODEL));
    step('Modell gelöscht');
  }

  // 7) Beenden: Modell freigeben, eigenen Server beenden
  await mgr.shutdown();
  step('Beendet', { stillRunning: Boolean(await rt.version()), managed: det.managed });
  out.measurements.totalMs = Date.now() - t0;
  out.diagnostics = { devices: rt.computeDevices() };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(path.join('test-results', 'ollama-e2e.json'), JSON.stringify(out, null, 2));
  console.log('Ollama-E2E ok');
  console.log(JSON.stringify(out.measurements, null, 2));
})().catch((err) => {
  console.error(err);
  try { fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync(path.join('test-results', 'ollama-e2e.json'), JSON.stringify({ ...out, error: String(err.stack || err) }, null, 2)); } catch { /* egal */ }
  process.exit(1);
});
