// @ts-check
// Colibrì (github.com/JustVugg/colibri) als zweite Laufzeit für lokale Modelle.
//
// Wofür: sehr grosse Mixture-of-Experts-Modelle (ab etwa 19 GB), die nicht in Grafik- und
// Arbeitsspeicher passen. Colibrì hält den dichten Teil im Arbeitsspeicher und liest die
// Experten bei Bedarf von der SSD. Für Modelle, die ganz in den Speicher passen, bleibt
// Ollama die bessere Wahl (siehe catalog.chooseRuntime).
//
// Buddy baut nichts nach, sondern steuert Colibrìs eigenen Starter `coli` (Python):
//   coli status --json          Zustand von Einrichtung, Download und Server
//   coli setup --list --json    Modelle gegen diesen PC (passt / zu wenig RAM / zu wenig Platz)
//   coli setup --yes --model …  Modell laden (mit Fortsetzen nach Abbruch)
//   coli start --background     Server starten        coli stop   Server beenden
// und spricht mit dem Server über dessen OpenAI-kompatible Schnittstelle (nur 127.0.0.1).
// Colibrìs Einstellungen liegen in %LOCALAPPDATA%\colibri\setup.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { LocalError, runCmd, envFor } = require('./ollama');

const REPO = 'JustVugg/colibri';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const MIN_PYTHON = [3, 10];

/** Setup-Ordner von Colibrì (wie c/setup_flow.py setup_home) @param {string} platform @param {NodeJS.ProcessEnv} env @param {string} home */
function setupHome(platform, env, home) {
  if (env.COLI_SETUP_HOME) return path.resolve(env.COLI_SETUP_HOME);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'colibri');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'colibri');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'colibri');
}

/** Zeilen aus SHA256SUMS.txt → Dateiname → Prüfsumme @param {string} text */
function parseSums(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m) out[path.basename(m[2])] = m[1].toLowerCase();
  }
  return out;
}

/**
 * Release-Dateien für Windows wählen. CUDA nur für NVIDIA ab Compute Capability 8.0
 * (so steht es in Colibrìs docs/windows.md); ältere Karten nutzen Vulkan.
 * @param {any} release @param {{ cudaOk?: boolean }} [opts]
 */
function pickAssets(release, { cudaOk = false } = {}) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const find = (/** @type {RegExp} */ re) => assets.find((/** @type {any} */ a) => re.test(String(a.name)));
  const main = find(/^colibri-.+-windows-x86_64\.zip$/);
  const cuda = cudaOk ? find(/^colibri-.+-windows-x86_64-cuda\.zip$/) : null;
  const sums = find(/^SHA256SUMS(\.txt)?$/i);
  if (!main || !sums) return null;
  const pick = (/** @type {any} */ a) => ({ name: String(a.name), url: String(a.browser_download_url), size: Number(a.size) || 0 });
  return { tag: String(release.tag_name || ''), main: pick(main), cuda: cuda ? pick(cuda) : null, sums: pick(sums) };
}

/**
 * Antwort-Stream (Server-Sent Events) von /v1/chat/completions lesen.
 * @param {Response} res @param {(obj: any) => void} onEvent @param {number} idleMs
 */
async function readSse(res, onEvent, idleMs) {
  if (!res.body) throw new LocalError('error', 'Leere Antwort');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {ReturnType<typeof setTimeout>|null} */
  let idle = null;
  let timedOut = false;
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, idleMs);
  };
  arm();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onEvent(JSON.parse(data)); } catch { /* unvollständig */ }
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
  }
  if (timedOut) throw new LocalError('timeout', 'Keine Antwort mehr von Colibrì.');
}

/** Fehlermeldung von Colibrì einordnen @param {string} text */
function classifyColibri(text) {
  const s = String(text || '');
  if (/RAM budget cannot hold|not enough (free )?RAM|needs \d+ GB of RAM|out of memory|cannot allocate/i.test(s)) return 'out_of_memory';
  if (/needs \d+ GB free|no space left|disk/i.test(s) && /free|space/i.test(s)) return 'disk_full';
  if (/vulkan|cuda|vk_|GPU/i.test(s) && /fail|error|lost/i.test(s)) return 'gpu_error';
  if (/download|network|connection|timed out|HTTP Error/i.test(s)) return 'network';
  if (/engine.*(not built|missing)|predates/i.test(s)) return 'runtime_too_old';
  return 'error';
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch, remoteFetch?: typeof fetch, spawnImpl?: typeof spawn, runImpl?: typeof runCmd,
 *   platform?: string, env?: NodeJS.ProcessEnv, home?: string, installRoot?: string, tmpDir?: string,
 *   log?: (m: string) => void, now?: () => number,
 * }} [opts]
 */
function createColibri(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const remoteFetch = opts.remoteFetch || globalThis.fetch;
  const spawnImpl = opts.spawnImpl || spawn;
  const exec = opts.runImpl || runCmd;
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const installRoot = opts.installRoot || path.join(home, '.buddy-colibri');
  const tmpDir = opts.tmpDir || os.tmpdir();
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;

  /** @type {{ exe: string, args: string[], version: string }|null|undefined} */
  let python;
  /** Selbst gestartet (nur dann beendet Buddy den Server) */
  let startedByBuddy = false;
  /** @type {{ at: number, list: any[] }|null} */
  let catalogCache = null;
  /** @type {any} */
  let lastHealth = null;
  /** @type {import('child_process').ChildProcess|null} */
  let setupProc = null;

  const home_ = () => setupHome(platform, env, home);

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(home_(), 'setup.json'), 'utf8')); } catch { return null; }
  }
  function readInstallState() {
    try { return JSON.parse(fs.readFileSync(path.join(home_(), 'install-state.json'), 'utf8')); } catch { return null; }
  }

  /** Python 3.10+ für den Starter (wird zwischengespeichert) */
  async function findPython() {
    if (python !== undefined) return python;
    /** @type {Array<[string, string[]]>} */
    const candidates = platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
    for (const [exe, args] of candidates) {
      const r = await exec(exe, [...args, '-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], 10000);
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(r.out.trim());
      if (r.code === 0 && m && (Number(m[1]) > MIN_PYTHON[0] || (Number(m[1]) === MIN_PYTHON[0] && Number(m[2]) >= MIN_PYTHON[1]))) {
        python = { exe, args, version: m[0] };
        return python;
      }
    }
    python = null;
    return null;
  }

  /** Der Starter `coli`: aus Colibrìs Einstellungen, sonst aus Buddys Installationsordner */
  function findLauncher() {
    const cfg = readConfig();
    /** @type {string[]} */
    const candidates = [];
    if (cfg?.launcher) candidates.push(String(cfg.launcher));
    try {
      const versions = fs.readdirSync(installRoot).filter((d) => /^v?\d/.test(d)).sort().reverse();
      for (const v of versions) candidates.push(path.join(installRoot, v, 'coli'));
    } catch { /* noch nichts installiert */ }
    if (env.BUDDY_COLIBRI_LAUNCHER) candidates.unshift(env.BUDDY_COLIBRI_LAUNCHER);
    return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  }

  /** Version aus version.py neben dem Starter */
  function launcherVersion(/** @type {string|null} */ launcher) {
    if (!launcher) return null;
    try {
      const m = /__version__\s*=\s*["']([^"']+)/.exec(fs.readFileSync(path.join(path.dirname(launcher), 'version.py'), 'utf8'));
      return m ? m[1] : null;
    } catch { return null; }
  }

  /** Startet den Starter mit Argumenten @param {string[]} args @param {number} [timeout] */
  async function coli(args, timeout = 60000) {
    const py = await findPython();
    const launcher = findLauncher();
    if (!launcher) throw new LocalError('runtime_missing', 'Colibrì ist nicht installiert.');
    if (!py) throw new LocalError('python_missing', 'Für Colibrì fehlt Python 3.10 oder neuer.');
    return exec(py.exe, [...py.args, launcher, ...args], timeout);
  }

  /** @param {string} text */
  function parseJson(text) {
    const s = String(text || '');
    const start = s.search(/[[{]/);
    if (start < 0) return null;
    try { return JSON.parse(s.slice(start)); } catch { return null; }
  }

  function serverAddress(/** @type {any} */ cfg) {
    const host = !cfg?.host || cfg.host === '0.0.0.0' ? '127.0.0.1' : String(cfg.host);
    return `http://${host}:${Number(cfg?.port) || 8000}`;
  }

  /** /health des konfigurierten Servers: ready | loading | stopped @param {any} cfg */
  async function health(cfg) {
    if (!cfg) return { state: 'stopped', data: null };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetchImpl(`${serverAddress(cfg)}/health`, { signal: ctrl.signal });
      const data = await res.json().catch(() => null);
      if (res.status === 200 && data?.status === 'ok') { lastHealth = data; return { state: 'ready', data }; }
      return { state: 'loading', data };
    } catch {
      // Kein Server: läuft vielleicht noch der Start (PID-Datei)?
      return { state: pidAlive(cfg) ? 'loading' : 'stopped', data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  function pidAlive(/** @type {any} */ cfg) {
    try {
      // wie c/setup_flow.py serve_pidfile: im Temp-Ordner
      const raw = fs.readFileSync(path.join(tmpDir, `coli-serve-${Number(cfg?.port) || 8000}.pid`), 'utf8');
      const pid = Number(raw.split(/\s+/)[0]);
      if (!pid) return false;
      process.kill(pid, 0);
      return true;
    } catch { return false; }
  }

  /** Zustand ohne Python-Aufruf (schnell, für jeden Start) */
  async function detect() {
    const launcher = findLauncher();
    const cfg = readConfig();
    const h = cfg ? await health(cfg) : { state: 'stopped', data: null };
    const ready = cfg ? Boolean(cfg.status === 'ready' || cfg.status === 'started' || cfg.model_dir) : false;
    return {
      installed: Boolean(launcher),
      launcher,
      version: launcherVersion(launcher),
      configured: Boolean(cfg && ready),
      model: cfg?.model?.id ? { id: String(cfg.model.id), name: String(cfg.model.name || cfg.model.id), dir: cfg.model_dir || null } : cfg?.model_dir ? { id: path.basename(String(cfg.model_dir)), name: path.basename(String(cfg.model_dir)), dir: cfg.model_dir } : null,
      backend: cfg?.backend || null,
      address: cfg ? serverAddress(cfg) : null,
      state: h.state,
      running: h.state === 'ready',
      managed: startedByBuddy,
      setupHome: home_(),
    };
  }

  /** Modelle gegen diesen PC, so wie Colibrì sie selbst beurteilt (1 Tag zwischengespeichert) */
  async function catalog({ force = false } = {}) {
    if (!force && catalogCache && now() - catalogCache.at < 24 * 3600 * 1000) return catalogCache.list;
    const r = await coli(['setup', '--list', '--json'], 120000);
    const data = parseJson(r.out);
    if (!Array.isArray(data)) throw new LocalError('error', 'Colibrì hat keine Modellliste geliefert.', { raw: r.out.slice(-300) });
    const list = data.filter((m) => m && typeof m.id === 'string').map((m) => ({
      id: String(m.id), name: String(m.name || m.id), kind: String(m.kind || 'text'),
      downloadGB: Number(m.download_gb) || null, ramMinGB: Number(m.ram_min_gb) || null, ramGoodGB: Number(m.ram_good_gb) || null,
      denseGB: Number(m.dense_gb) || null, runs: String(m.runs || ''), status: String(m.status || ''),
      fits: m.fits === true, reason: String(m.reason || ''), recommended: m.recommended === true, summary: String(m.summary || ''),
      license: String(m.license_note || ''),
    }));
    catalogCache = { at: now(), list };
    return list;
  }

  /** Vollständiger Zustand über `coli status --json` (Download-Fortschritt usw.) */
  async function status() {
    const r = await coli(['status', '--json'], 30000);
    return parseJson(r.out);
  }

  /** Modell-ID des laufenden Servers */
  async function servedModel() {
    const cfg = readConfig();
    try {
      const res = await fetchImpl(`${serverAddress(cfg)}/v1/models`);
      const data = await res.json();
      return String(data?.data?.[0]?.id || cfg?.model?.id || 'colibri');
    } catch { return String(cfg?.model?.id || 'colibri'); }
  }

  /**
   * Server starten (oder einen laufenden mitbenutzen) und warten, bis das Modell geladen ist.
   * @param {{ onProgress?: (p: { phase: string, elapsedMs: number }) => void, signal?: AbortSignal, timeoutMs?: number }} [o]
   */
  async function start({ onProgress = () => {}, signal, timeoutMs = 20 * 60 * 1000 } = {}) {
    const cfg = readConfig();
    if (!findLauncher()) throw new LocalError('runtime_missing', 'Colibrì ist nicht installiert.');
    if (!cfg) throw new LocalError('no_model', 'In Colibrì ist noch kein Modell eingerichtet.');
    const t0 = now();
    let h = await health(cfg);
    if (h.state === 'ready') return { reused: true, loadMs: 0 };
    if (h.state === 'stopped') {
      onProgress({ phase: 'starting', elapsedMs: 0 });
      const r = await coli(['start', '--background', '--no-browser'], 120000);
      if (r.code !== 0) throw new LocalError(classifyColibri(r.out) === 'error' ? 'runtime_failed' : classifyColibri(r.out), 'Colibrì startet nicht.', { raw: r.out.slice(-400) });
      startedByBuddy = true;
    }
    while (now() - t0 < timeoutMs) {
      if (signal?.aborted) {
        if (startedByBuddy) await stop().catch(() => {});
        throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      }
      await new Promise((r) => setTimeout(r, 1000));
      h = await health(readConfig());
      if (h.state === 'ready') return { reused: false, loadMs: now() - t0 };
      if (h.state === 'stopped') {
        const tail = await logs(30).catch(() => '');
        throw new LocalError(classifyColibri(tail) === 'error' ? 'runner_crashed' : classifyColibri(tail), 'Colibrì hat sich beim Laden beendet.', { raw: tail.slice(-400) });
      }
      onProgress({ phase: 'loading', elapsedMs: now() - t0 });
    }
    throw new LocalError('timeout', 'Colibrì lädt zu lange.');
  }

  /** Nur einen selbst gestarteten Server beenden (ausser force) @param {{ force?: boolean }} [o] */
  async function stop({ force = false } = {}) {
    if (!startedByBuddy && !force) return false;
    const r = await coli(['stop'], 60000).catch(() => ({ code: 1, out: '' }));
    startedByBuddy = false;
    return r.code === 0;
  }

  async function logs(n = 50) {
    const r = await coli(['logs', '-n', String(n)], 20000);
    return r.out;
  }

  /**
   * Fähigkeiten: Bilder und Kontext aus /health, Werkzeuge nach Colibrìs Tabelle
   * (docs/api.md «Tool-calling support»: alle Chat-Engines ausser Inkling und OLMoE).
   */
  function capabilities() {
    const caps = Array.isArray(lastHealth?.capabilities) ? lastHealth.capabilities : [];
    const modal = Array.isArray(lastHealth?.input_modalities) ? lastHealth.input_modalities : [];
    const arch = String(lastHealth?.arch || readConfig()?.family || '').toLowerCase();
    const chats = !caps.length || caps.includes('chat');
    return {
      tools: chats && Boolean(arch) && !/inkling|olmoe/.test(arch),
      vision: modal.includes('image'),
      contextTokens: Number(lastHealth?.context_tokens) || null,
      arch: arch || null,
    };
  }

  /**
   * Chat über /v1/chat/completions mit Streaming.
   * @param {{ messages: any[], tools?: any[], options?: { temperature?: number, top_p?: number, max_tokens?: number },
   *   format?: any, signal?: AbortSignal, onDelta?: (t: string) => void, idleMs?: number }} req
   */
  async function chat(req) {
    const cfg = readConfig();
    const model = await servedModel();
    const t0 = now();
    /** @type {Record<string, any>} */
    const body = { model, messages: req.messages, stream: true, stream_options: { include_usage: true } };
    if (req.tools && req.tools.length) body.tools = req.tools;
    if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
    if (req.options?.top_p !== undefined) body.top_p = req.options.top_p;
    if (req.options?.max_tokens) body.max_tokens = req.options.max_tokens;
    if (req.format) body.response_format = { type: 'json_schema', json_schema: { name: 'antwort', schema: req.format } };
    let res;
    try {
      res = await fetchImpl(`${serverAddress(cfg)}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: req.signal });
    } catch (err) {
      if (req.signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      throw new LocalError('unreachable', 'Colibrì ist nicht erreichbar.', { raw: String(/** @type {Error} */ (err).message) });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try { const j = JSON.parse(text); msg = j.error?.message || j.error || text; } catch { /* Text */ }
      throw new LocalError(res.status === 503 ? 'runner_crashed' : classifyColibri(msg), String(msg || `HTTP ${res.status}`), { status: res.status, raw: String(msg) });
    }
    let content = '';
    /** @type {Map<number, {name: string, args: string}>} */
    const calls = new Map();
    let finish = 'stop';
    let first = 0;
    /** @type {any} */
    let usage = null;
    try {
      await readSse(res, (ev) => {
        if (ev.error) throw new LocalError(classifyColibri(ev.error.message || ev.error), String(ev.error.message || ev.error));
        if (ev.usage) usage = ev.usage;
        const choice = ev.choices?.[0];
        if (!choice) return;
        const d = choice.delta || {};
        if (typeof d.content === 'string' && d.content) {
          if (!first) first = now() - t0;
          content += d.content;
          req.onDelta?.(d.content);
        }
        for (const tc of d.tool_calls || []) {
          const i = Number(tc.index) || 0;
          const cur = calls.get(i) || { name: '', args: '' };
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (choice.finish_reason) finish = String(choice.finish_reason);
      }, req.idleMs ?? 10 * 60 * 1000);
    } catch (err) {
      if (req.signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      throw err;
    }
    const total = now() - t0;
    const out = Number(usage?.completion_tokens) || 0;
    const genMs = first ? total - first : total;
    return {
      content,
      toolCalls: [...calls.values()].map((c) => {
        let args = {};
        try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = {}; }
        return { function: { name: c.name, arguments: args } };
      }),
      doneReason: finish === 'length' ? 'length' : finish,
      promptTokens: Number(usage?.prompt_tokens) || 0,
      evalTokens: out,
      timings: { totalMs: total, firstTokenMs: first || null, loadMs: null, promptMs: null, evalMs: genMs, tokensPerSecond: out && genMs > 0 ? Math.round((out / (genMs / 1000)) * 10) / 10 : null },
    };
  }

  // ---------------- Installation (Windows) ----------------

  /** Was eine Installation bedeuten würde. Lädt nichts. @param {{ cudaOk?: boolean }} [o] */
  async function installPlan({ cudaOk = false } = {}) {
    const py = await findPython();
    if (platform !== 'win32') return { automatic: false, python: Boolean(py), pythonVersion: py?.version || null, url: `https://github.com/${REPO}#get-started-in-one-step` };
    try {
      const res = await remoteFetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const assets = pickAssets(await res.json(), { cudaOk });
      if (!assets) return { automatic: false, python: Boolean(py), error: 'no_windows_release' };
      return { automatic: true, python: Boolean(py), pythonVersion: py?.version || null, tag: assets.tag, sizeBytes: assets.main.size + (assets.cuda?.size || 0), cuda: Boolean(assets.cuda) };
    } catch (err) {
      return { automatic: false, python: Boolean(py), error: 'network', detail: String(/** @type {Error} */ (err).message) };
    }
  }

  /**
   * Lädt das Windows-Release von GitHub, prüft die SHA-256-Prüfsummen aus SHA256SUMS.txt
   * und entpackt es in Buddys Ordner. Führt dabei nichts aus. Modelle lädt erst setupModel().
   * @param {{ cudaOk?: boolean, onProgress?: (p: any) => void, signal?: AbortSignal }} [o]
   */
  async function install({ cudaOk = false, onProgress = () => {}, signal } = {}) {
    if (platform !== 'win32') throw new LocalError('manual_install', 'Colibrì bitte nach der Anleitung im Colibrì-Repo installieren.');
    if (!(await findPython())) throw new LocalError('python_missing', 'Für Colibrì fehlt Python 3.10 oder neuer.');
    const res = await remoteFetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal });
    if (!res.ok) throw new LocalError('network', `GitHub antwortet mit ${res.status}`);
    const assets = pickAssets(await res.json(), { cudaOk });
    if (!assets) throw new LocalError('install_failed', 'Im neusten Colibrì-Release fehlt das Windows-Archiv.');
    const sumsRes = await remoteFetch(assets.sums.url, { signal, redirect: 'follow' });
    const sums = parseSums(await sumsRes.text());
    const dir = fs.mkdtempSync(path.join(tmpDir, 'buddy-colibri-'));
    const target = path.join(installRoot, assets.tag.replace(/[^\w.-]/g, '_'));
    try {
      const files = [assets.main, ...(assets.cuda ? [assets.cuda] : [])];
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      let doneBefore = 0;
      for (const f of files) {
        const expected = sums[f.name];
        if (!expected) throw new LocalError('checksum_mismatch', `Für ${f.name} gibt es keine Prüfsumme.`);
        const file = path.join(dir, f.name);
        const hash = crypto.createHash('sha256');
        const dl = await remoteFetch(f.url, { signal, redirect: 'follow' });
        if (!dl.ok || !dl.body) throw new LocalError('network', `Download fehlgeschlagen (HTTP ${dl.status})`);
        const out = fs.createWriteStream(file);
        const reader = dl.body.getReader();
        let done = 0;
        let last = 0;
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          const buf = Buffer.from(value);
          hash.update(buf);
          done += buf.length;
          if (!out.write(buf)) await new Promise((r) => out.once('drain', () => r(undefined)));
          if (now() - last > 300) { last = now(); onProgress({ phase: 'download', completedBytes: doneBefore + done, totalBytes, percent: totalBytes ? ((doneBefore + done) / totalBytes) * 100 : null }); }
        }
        await new Promise((resolve, reject) => { out.end(); out.on('finish', () => resolve(undefined)); out.on('error', reject); });
        doneBefore += done;
        onProgress({ phase: 'verify' });
        const got = hash.digest('hex');
        if (got !== expected) throw new LocalError('checksum_mismatch', `Prüfsumme von ${f.name} stimmt nicht.`, { raw: `erwartet ${expected}, erhalten ${got}` });
      }
      onProgress({ phase: 'install' });
      fs.mkdirSync(target, { recursive: true });
      for (const f of files) {
        const ps = `Expand-Archive -LiteralPath '${path.join(dir, f.name).replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`;
        const r = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], 10 * 60 * 1000);
        if (r.code !== 0) throw new LocalError('install_failed', 'Colibrì konnte nicht entpackt werden.', { raw: r.out.slice(-300) });
      }
      if (!fs.existsSync(path.join(target, 'coli'))) throw new LocalError('install_failed', 'Im Colibrì-Archiv fehlt der Starter.');
      log(`Lokale KI: Colibrì ${assets.tag} installiert (${target})`);
      catalogCache = null;
      return { tag: assets.tag, dir: target };
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      throw err;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ }
    }
  }

  /**
   * Ein Modell einrichten (Download mit Fortsetzen). Die Oberfläche hat vorher Grösse und
   * Speicherort gezeigt und um Bestätigung gebeten.
   * @param {string} id @param {{ dir?: string|null, modelDir?: string|null, onProgress?: (p: any) => void, signal?: AbortSignal }} [o]
   */
  async function setupModel(id, { dir = null, modelDir = null, onProgress = () => {}, signal } = {}) {
    if (!/^[\w.-]{1,80}$/.test(id) && !modelDir) throw new LocalError('error', 'Ungültige Modell-ID.');
    const py = await findPython();
    const launcher = findLauncher();
    if (!launcher) throw new LocalError('runtime_missing', 'Colibrì ist nicht installiert.');
    if (!py) throw new LocalError('python_missing', 'Für Colibrì fehlt Python 3.10 oder neuer.');
    const args = [...py.args, launcher, 'setup', '--yes', '--no-start', '--no-browser'];
    if (modelDir) args.push('--model-dir', modelDir);
    else args.push('--model', id);
    if (dir) args.push('--dir', dir);
    if (readConfig()) args.push('--reconfigure');
    await stop().catch(() => {});
    const proc = spawnImpl(py.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: envFor(py.exe) });
    setupProc = proc;
    let tail = '';
    const keep = (/** @type {any} */ d) => { tail = (tail + String(d)).slice(-4000); };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    const exited = new Promise((resolve) => { proc.on('exit', (c) => resolve(c ?? -1)); proc.on('error', () => resolve(-1)); });
    let code = null;
    const onAbort = () => killTree(proc);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (code === null) {
        code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 1500))]);
        const st = readInstallState();
        if (st) onProgress({ phase: String(st.phase || ''), completedBytes: Number(st.done) || 0, totalBytes: Number(st.total) || 0, rateBps: Number(st.rate) || null, message: st.message || null });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      setupProc = null;
    }
    if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
    const st = readInstallState();
    if (code !== 0 || st?.phase === 'error') {
      const msg = String(st?.message || tail.slice(-400));
      throw new LocalError(classifyColibri(msg), 'Das Colibrì-Modell konnte nicht eingerichtet werden.', { raw: msg });
    }
    catalogCache = null;
    return readConfig();
  }

  /**
   * Ein Modell, das Ollama schon geladen hat, für Colibrì nutzen: kein zweiter Download.
   * Die GGUF-Datei liegt bei Ollama als «Blob»; ein fester Link gibt ihr einen Namen, ohne
   * Platz zu brauchen (geht nur auf demselben Laufwerk), und «coli import» erstellt daraus
   * Colibrìs Modellordner. Gibt den Ordner zurück, oder null, wenn das hier nicht geht.
   * @param {{ modelsDir: string, id: string, outRoot?: string }} o
   */
  async function importFromOllama({ modelsDir, id, outRoot }) {
    const [name, tag = 'latest'] = String(id).split(':');
    if (!/^[\w.-]+$/.test(name) || !/^[\w.-]+$/.test(tag)) return null;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag), 'utf8')); } catch { return null; }
    const layer = (manifest.layers || []).find((/** @type {any} */ l) => /image\.model$/.test(l.mediaType || ''));
    if (!layer?.digest) return null;
    const blob = path.join(modelsDir, 'blobs', String(layer.digest).replace(':', '-'));
    if (!fs.existsSync(blob)) return null;
    const gguf = path.join(modelsDir, 'blobs', `${name}-${tag}.gguf`);
    try {
      if (!fs.existsSync(gguf)) fs.linkSync(blob, gguf);
    } catch (err) {
      log(`Colibrì: Ollama-Datei lässt sich nicht verknüpfen (${/** @type {any} */ (err).code || err}), lade stattdessen herunter`);
      return null;
    }
    const out = path.join(outRoot || path.join(home, 'colibri-models'), `${name}-${tag}-ollama`.replace(/[^\w.-]/g, '-'));
    const r = await coli(['import', '--out', out, gguf], 30 * 60 * 1000);
    if (r.code !== 0 || !fs.existsSync(out)) throw new LocalError(classifyColibri(r.out), 'Colibrì konnte die Ollama-Datei nicht übernehmen.', { raw: r.out.slice(-400) });
    log(`Colibrì: ${id} von Ollama übernommen (${out})`);
    return out;
  }

  /** @param {import('child_process').ChildProcess} proc */
  function killTree(proc) {
    if (!proc.pid) return;
    if (platform === 'win32') exec('taskkill', ['/PID', String(proc.pid), '/T', '/F'], 10000).catch(() => {});
    else { try { proc.kill('SIGTERM'); } catch { /* weg */ } }
  }

  return {
    id: 'colibri',
    name: 'Colibrì',
    detect, catalog, status, start, stop, chat, logs, capabilities, servedModel,
    installPlan, install, setupModel, importFromOllama, findPython, findLauncher,
    isManaged: () => startedByBuddy,
    cancelSetup: () => { if (setupProc) killTree(setupProc); },
    setupHome: home_,
  };
}

module.exports = { createColibri, setupHome, parseSums, pickAssets, readSse, classifyColibri, RELEASES_API };
