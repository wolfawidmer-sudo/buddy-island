// Echter Vergleich Ollama ↔ Colibrì auf derselben Maschine mit derselben Modelldatei:
// Ollama lädt qwen3.6:35b (Q4_K_M), Colibrì importiert genau diese Datei (docs/gguf.md im
// Colibrì-Repo beschreibt das). Gemessen werden Laden, erstes Wort und Tokens pro Sekunde.
// Passt das Modell nicht in den Speicher, wird das als Ergebnis festgehalten, nicht versteckt.
// Ergebnis: test-results/colibri-e2e.json. Erfundene Zahlen gibt es nicht (null = nicht gemessen).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const hardware = require('../../src/local/hardware');
const { createOllama } = require('../../src/local/ollama');
const { createColibri } = require('../../src/local/colibri');

const MODEL = process.env.BUDDY_E2E_MOE || 'qwen3.6:35b';
const PROMPT = [{ role: 'user', content: 'Erkläre in drei Sätzen, was ein Mixture-of-Experts-Modell ist.' }];
const out = { model: MODEL, steps: [], ollama: null, colibri: null };
const t0 = Date.now();
const step = (name, data = {}) => { out.steps.push({ name, s: Math.round((Date.now() - t0) / 100) / 10, ...data }); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${name} ${JSON.stringify(data)}`); };
const save = () => { fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync(path.join('test-results', 'colibri-e2e.json'), JSON.stringify(out, null, 2)); };

(async () => {
  const hw = await hardware.detect({ modelsDir: os.homedir() });
  out.hardware = hardware.summary(hw);
  step('Hardware', out.hardware);

  // 1) Ollama
  const rt = createOllama({ log: (m) => console.log(`  ${m}`) });
  if (!(await rt.detect()).installed) await rt.install();
  await rt.start();
  const pullStart = Date.now();
  await rt.pull(MODEL, { onProgress: () => {} });
  step('Ollama: Modell geladen', { downloadMs: Date.now() - pullStart });
  try {
    const load = await rt.load(MODEL, { options: { num_ctx: 4096 } });
    let first = 0;
    const s = Date.now();
    const r = await rt.chat({ model: MODEL, messages: PROMPT, options: { num_ctx: 4096, num_predict: 96, temperature: 0 }, think: false, onDelta: () => { if (!first) first = Date.now() - s; } });
    const ps = (await rt.ps()).find((m) => m.id === MODEL);
    out.ollama = { ok: true, loadMs: load.loadMs, firstTokenMs: first, tokensPerSecond: r.timings.tokensPerSecond, memoryBytes: ps?.sizeBytes ?? null, answer: r.content.slice(0, 200) };
  } catch (err) {
    out.ollama = { ok: false, code: err.code || 'error', message: String(err.raw || err.message).slice(0, 300) };
  }
  step('Ollama: Ergebnis', out.ollama);
  await rt.unload(MODEL);

  // 2) Colibrì: Programm mit Buddys Installer (Prüfsumme), dieselbe Datei importieren
  const installRoot = path.join(os.homedir(), 'buddy-colibri');
  const col = createColibri({ installRoot, log: (m) => console.log(`  ${m}`) });
  const plan = await col.installPlan();
  step('Colibrì: Plan', plan);
  if (!plan.automatic) throw new Error(`Colibrì kann hier nicht automatisch installiert werden: ${JSON.stringify(plan)}`);
  const inst = await col.install({ onProgress: () => {} });
  step('Colibrì: installiert', inst);
  const py = await col.findPython();
  const launcher = col.findLauncher();
  const coli = (args, timeout = 30 * 60 * 1000) => execFileSync(py.exe, [...py.args, launcher, ...args], { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });

  const modelsDir = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const [name, tag] = MODEL.split(':');
  const manifest = JSON.parse(fs.readFileSync(path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag), 'utf8'));
  const layer = manifest.layers.find((l) => /image\.model$/.test(l.mediaType));
  const blob = path.join(modelsDir, 'blobs', layer.digest.replace(':', '-'));
  const gguf = path.join(path.dirname(blob), `${name}-${tag}.gguf`);
  if (!fs.existsSync(gguf)) fs.linkSync(blob, gguf); // fester Link: kein zweiter Download, kein Platz
  const imported = path.join(os.homedir(), 'colibri-models', `${name}-${tag}-ollama`);
  console.log(coli(['import', '--out', imported, gguf]).slice(-600));
  step('Colibrì: dieselbe Datei importiert', { file: gguf });
  console.log(coli(['setup', '--yes', '--no-start', '--no-browser', '--model-dir', imported]).slice(-1500));
  step('Colibrì: eingerichtet', await col.detect());

  try {
    const st = await col.start({ onProgress: () => {} });
    let first = 0;
    const s = Date.now();
    const r = await col.chat({ messages: PROMPT, options: { temperature: 0, max_tokens: 96 }, onDelta: () => { if (!first) first = Date.now() - s; } });
    out.colibri = { ok: true, loadMs: st.loadMs, firstTokenMs: first, tokensPerSecond: r.timings.tokensPerSecond, backend: (await col.detect()).backend, answer: r.content.slice(0, 200) };
  } catch (err) {
    out.colibri = { ok: false, code: err.code || 'error', message: String(err.raw || err.message).slice(0, 400), log: await col.logs(40).catch(() => '') };
  }
  step('Colibrì: Ergebnis', out.colibri);
  await col.stop();
  save();
  console.log(JSON.stringify({ ollama: out.ollama, colibri: out.colibri }, null, 2));
  if (!out.colibri?.ok && !out.ollama?.ok) process.exit(1);
})().catch((err) => {
  out.error = String(err.stack || err);
  console.error(err);
  save();
  process.exit(1);
});
