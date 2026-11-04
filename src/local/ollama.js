// @ts-check
// Ollama als Laufzeit für lokale Modelle.
//
// Warum Ollama: offizielles Windows-Programm ohne Administratorrechte, rechnet mit NVIDIA (CUDA),
// AMD (ROCm oder Vulkan), Intel (Vulkan) oder nur dem Prozessor, lädt quantisierte Modelle
// (GGUF) aus der eigenen Registry mit Prüfsumme und fortsetzbarem Download, bietet eine lokale
// HTTP-Schnittstelle mit Streaming und Werkzeugaufrufen und verteilt das Modell selbst auf
// Grafikkarte und Prozessor. Die Schnittstelle hört nur auf 127.0.0.1.
//
// Dieses Modul spricht nur mit Ollama. Was wann passiert, entscheidet manager.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const DEFAULT_HOST = '127.0.0.1:11434';
const INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
const DOWNLOAD_PAGE = 'https://ollama.com/download';
const WINGET_ID = 'Ollama.Ollama';
const LOG_LINES = 300;

/** @typedef {{ status: string, completedBytes: number, totalBytes: number, percent: number|null }} PullProgress */
/** @typedef {{ id: string, sizeBytes: number, digest: string, modifiedAt: string|null, family: string|null, params: string|null, quant: string|null }} InstalledModel */
/** @typedef {{ id: string, sizeBytes: number, vramBytes: number, expiresAt: string|null, ctx: number|null }} LoadedModel */

/** Fehler mit maschinenlesbarem Code (für verständliche Meldungen) */
class LocalError extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number, raw?: string }} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LocalError';
    this.code = code;
    this.status = extra.status || 0;
    this.raw = extra.raw || message;
  }
}

/**
 * Ordnet eine Ollama-Fehlermeldung einer Ursache zu.
 * @param {string} text @param {number} [status]
 */
function classify(text, status = 0) {
  const s = String(text || '');
  if (/not found|file does not exist|pull model manifest|no such model/i.test(s) || status === 404) return 'not_found';
  if (/requires more system memory|out of memory|insufficient memory|cudaMalloc|unable to allocate|failed to allocate|memory allocation|not enough memory|vk::.*OutOfDeviceMemory|ErrorOutOfDeviceMemory/i.test(s)) return 'out_of_memory';
  if (/does not support (tools|thinking|insert|vision|images)/i.test(s)) return 'unsupported';
  if (/no space left|disk full|not enough space|insufficient disk/i.test(s)) return 'disk_full';
  if (/CUDA error|ROCm error|hip error|vulkan|ggml_cuda|driver|0xc0000409|0xc0000005/i.test(s)) return 'gpu_error';
  if (/runner process has terminated|runner process no longer running|exit status/i.test(s)) return 'runner_crashed';
  if (/dial tcp|tls|i\/o timeout|connection reset|no such host|network|EOF|temporary failure|unexpected EOF/i.test(s)) return 'network';
  if (/requires a newer version|newer version of ollama|unsupported model|unknown model architecture|412/i.test(s)) return 'runtime_too_old';
  if (/timed? ?out|deadline exceeded/i.test(s)) return 'timeout';
  return 'error';
}

/** «inference compute»-Zeilen aus dem Ollama-Protokoll: welche Beschleuniger Ollama gefunden hat @param {string[]} lines */
function parseComputeLines(lines) {
  /** @type {{ library: string, name: string, totalGB: number|null, availableGB: number|null }[]} */
  const out = [];
  for (const line of lines) {
    if (!/inference compute/.test(line)) continue;
    const field = (/** @type {string} */ k) => {
      const m = new RegExp(`\\b${k}=(?:"([^"]*)"|(\\S+))`).exec(line);
      return m ? (m[1] ?? m[2]) : '';
    };
    const gib = (/** @type {string} */ v) => {
      const m = /([\d.]+)\s*(GiB|MiB)/i.exec(v);
      return m ? Math.round((Number(m[1]) / (m[2].toLowerCase() === 'mib' ? 1024 : 1)) * 10) / 10 : null;
    };
    const library = field('library').toLowerCase();
    if (!library) continue;
    out.push({ library, name: field('description') || field('name'), totalGB: gib(field('total')), availableGB: gib(field('available')) });
  }
  return out;
}

/**
 * Liest NDJSON aus einem Response-Body und ruft für jede Zeile `onLine` auf.
 * @param {Response} res @param {(obj: any) => void} onLine @param {{ idleMs?: number, signal?: AbortSignal }} [opts]
 */
async function readNdjson(res, onLine, { idleMs = 0 } = {}) {
  if (!res.body) throw new LocalError('error', 'Leere Antwort');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {ReturnType<typeof setTimeout>|null} */
  let idle = null;
  let timedOut = false;
  const arm = () => {
    if (!idleMs) return;
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
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        onLine(obj);
      }
    }
    const rest = buffer.trim();
    if (rest) { try { onLine(JSON.parse(rest)); } catch { /* unvollständig */ } }
  } finally {
    if (idle) clearTimeout(idle);
  }
  if (timedOut) throw new LocalError('timeout', 'Keine Antwort mehr vom lokalen Modell.');
}

/**
 * @param {string} cmd @param {string[]} args @param {number} [timeout]
 * @returns {Promise<{ code: number, out: string }>}
 */
function runCmd(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, out, errOut) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${out || ''}${errOut || ''}`.trim() });
      });
    } catch (e) {
      resolve({ code: 1, out: String(/** @type {Error} */ (e).message) });
    }
  });
}

/**
 * @param {{
 *   host?: string,
 *   fetchImpl?: typeof fetch,           // lokal (127.0.0.1)
 *   remoteFetch?: typeof fetch,         // Internet (Installer); respektiert den System-Proxy
 *   spawnImpl?: typeof spawn,
 *   runImpl?: typeof runCmd,
 *   platform?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   tmpDir?: string,
 *   log?: (m: string) => void,
 * }} [opts]
 */
function createOllama(opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const base = `http://${host}`;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const remoteFetch = opts.remoteFetch || globalThis.fetch;
  const spawnImpl = opts.spawnImpl || spawn;
  const exec = opts.runImpl || runCmd;
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const tmpDir = opts.tmpDir || os.tmpdir();
  const log = opts.log || (() => {});

  /** @type {import('child_process').ChildProcess|null} */
  let managed = null;
  /** @type {Promise<void>|null} */
  let starting = null;
  /** @type {string[]} */
  const logLines = [];
  /** @type {string|null} */
  let modelsDir = null;
  /** @type {string|null} */
  let knownExe = null;

  const pushLog = (/** @type {string} */ chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      logLines.push(line.slice(0, 600));
      if (logLines.length > LOG_LINES) logLines.shift();
    }
  };

  /**
   * HTTP-Anfrage an Ollama. Wirft LocalError mit Code.
   * @param {string} p @param {{ method?: string, body?: any, timeoutMs?: number, signal?: AbortSignal }} [o]
   */
  async function request(p, { method = 'GET', body, timeoutMs = 10000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    // Das Signal des Aufrufers bleibt auch während des Streams am Body (Abbrechen mitten im Download)
    const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
    try {
      const res = await fetchImpl(`${base}${p}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: combined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch { /* Text */ }
        throw new LocalError(classify(msg, res.status), msg || `HTTP ${res.status}`, { status: res.status, raw: msg });
      }
      return res;
    } catch (err) {
      if (err instanceof LocalError) throw err;
      if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      if (/** @type {Error} */ (err).name === 'AbortError') throw new LocalError('timeout', 'Zeitüberschreitung bei Ollama.');
      throw new LocalError('unreachable', 'Ollama ist nicht erreichbar.', { raw: String(/** @type {Error} */ (err).message) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @returns {Promise<string|null>} Version, wenn der Server antwortet */
  async function version() {
    try {
      const res = await request('/api/version', { timeoutMs: 2500 });
      const data = await res.json();
      return typeof data.version === 'string' ? data.version : '0';
    } catch {
      return null;
    }
  }

  /** Programmdatei von Ollama finden (ohne es zu starten) */
  async function findExe() {
    if (knownExe && fs.existsSync(knownExe)) return knownExe;
    /** @type {string[]} */
    const candidates = [];
    if (platform === 'win32') {
      const lad = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      candidates.push(path.join(lad, 'Programs', 'Ollama', 'ollama.exe'));
      if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'Ollama', 'ollama.exe'));
    } else {
      candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama');
    }
    for (const c of candidates) if (fs.existsSync(c)) { knownExe = c; return c; }
    const r = await exec(platform === 'win32' ? 'where.exe' : 'which', ['ollama'], 5000);
    const found = r.code === 0 ? r.out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l)) : null;
    knownExe = found || null;
    return knownExe;
  }

  /** Zustand der Laufzeit */
  async function detect() {
    const [v, exe] = await Promise.all([version(), findExe()]);
    return {
      installed: Boolean(exe) || v !== null,
      running: v !== null,
      version: v,
      path: exe,
      managed: Boolean(managed && managed.exitCode === null),
      host,
      modelsDir: getModelsDir(),
    };
  }

  /** Wo Ollama Modelle speichert (eigene Wahl, OLLAMA_MODELS oder Standard) */
  function getModelsDir() {
    return modelsDir || env.OLLAMA_MODELS || path.join(home, '.ollama', 'models');
  }

  /** @param {string|null} dir */
  function setModelsDir(dir) {
    modelsDir = dir || null;
  }

  /** Wartet, bis der Server antwortet @param {number} ms */
  async function waitReady(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await version()) return true;
      if (managed && managed.exitCode !== null) return false;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /**
   * Startet den Server, falls er nicht läuft. Läuft er schon (Ollama-App, anderes Programm),
   * wird er mitbenutzt und nie von Buddy beendet.
   */
  async function start() {
    if (await version()) return;
    if (starting) return starting;
    starting = (async () => {
      const exe = await findExe();
      if (!exe) throw new LocalError('runtime_missing', 'Ollama ist nicht installiert.');
      /** @type {NodeJS.ProcessEnv} */
      const childEnv = { ...env, OLLAMA_HOST: host };
      if (modelsDir) childEnv.OLLAMA_MODELS = modelsDir;
      log(`Lokale KI: starte Ollama (${exe})`);
      let proc;
      try {
        proc = spawnImpl(exe, ['serve'], { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        throw new LocalError('runtime_failed', 'Ollama konnte nicht gestartet werden.', { raw: String(/** @type {Error} */ (err).message) });
      }
      managed = proc;
      proc.stdout?.on('data', pushLog);
      proc.stderr?.on('data', pushLog);
      proc.on('exit', (code) => {
        log(`Lokale KI: Ollama beendet (${code})`);
        if (managed === proc) managed = null;
      });
      proc.on('error', (err) => { pushLog(`spawn error: ${err.message}`); });
      const ok = await waitReady(30000);
      if (!ok) {
        const tail = logLines.slice(-8).join(' | ');
        const inUse = /address already in use|only one usage of each socket address/i.test(tail);
        try { proc.kill(); } catch { /* weg */ }
        if (managed === proc) managed = null;
        throw new LocalError(inUse ? 'port_in_use' : 'runtime_failed', inUse ? 'Ein anderes Programm belegt den Anschluss von Ollama.' : 'Ollama startet nicht.', { raw: tail });
      }
    })().finally(() => { starting = null; });
    return starting;
  }

  /** Beendet nur einen Server, den Buddy selbst gestartet hat */
  async function stop() {
    const proc = managed;
    if (!proc || proc.exitCode !== null) return false;
    managed = null;
    if (platform === 'win32' && proc.pid) {
      // Ganzen Prozessbaum beenden (Ollama startet für jedes Modell einen eigenen Runner)
      await exec('taskkill', ['/PID', String(proc.pid), '/T', '/F'], 8000);
    } else {
      try { proc.kill('SIGTERM'); } catch { /* weg */ }
    }
    return true;
  }

  /** @returns {Promise<InstalledModel[]>} */
  async function list() {
    const data = await (await request('/api/tags')).json();
    return (Array.isArray(data.models) ? data.models : []).map((/** @type {any} */ m) => ({
      id: String(m.model || m.name),
      sizeBytes: Number(m.size) || 0,
      digest: String(m.digest || ''),
      modifiedAt: m.modified_at || null,
      family: m.details?.family || null,
      params: m.details?.parameter_size || null,
      quant: m.details?.quantization_level || null,
    }));
  }

  /** @returns {Promise<LoadedModel[]>} */
  async function ps() {
    const data = await (await request('/api/ps')).json();
    return (Array.isArray(data.models) ? data.models : []).map((/** @type {any} */ m) => ({
      id: String(m.model || m.name),
      sizeBytes: Number(m.size) || 0,
      vramBytes: Number(m.size_vram) || 0,
      expiresAt: m.expires_at || null,
      ctx: Number(m.context_length) || null,
    }));
  }

  /**
   * Fähigkeiten und Aufbau eines installierten Modells
   * @param {string} id
   */
  async function show(id) {
    const data = await (await request('/api/show', { method: 'POST', body: { model: id }, timeoutMs: 15000 })).json();
    const info = data.model_info || {};
    const arch = String(info['general.architecture'] || data.details?.family || '');
    const get = (/** @type {string} */ k) => {
      const v = info[`${arch}.${k}`];
      return typeof v === 'number' ? v : Array.isArray(v) ? Math.max(...v.filter((x) => typeof x === 'number')) : null;
    };
    const caps = Array.isArray(data.capabilities) ? data.capabilities.map(String) : ['completion'];
    return {
      id,
      caps,
      family: data.details?.family || arch || null,
      params: data.details?.parameter_size || null,
      paramCount: typeof info['general.parameter_count'] === 'number' ? info['general.parameter_count'] : null,
      quant: data.details?.quantization_level || null,
      contextLength: get('context_length'),
      layers: get('block_count'),
      kvHeads: get('attention.head_count_kv'),
      keyLength: get('attention.key_length') || (get('embedding_length') && get('attention.head_count') ? Math.round(/** @type {number} */ (get('embedding_length')) / /** @type {number} */ (get('attention.head_count'))) : null),
      valueLength: get('attention.value_length'),
      slidingWindow: get('attention.sliding_window'),
      license: typeof data.license === 'string' ? data.license.slice(0, 400) : null,
    };
  }

  /**
   * Modell herunterladen. Ollama prüft die SHA-256-Prüfsumme jeder Datei und setzt
   * abgebrochene Downloads beim nächsten Mal fort.
   * @param {string} id @param {{ onProgress?: (p: PullProgress) => void, signal?: AbortSignal }} [o]
   */
  async function pull(id, { onProgress = () => {}, signal } = {}) {
    const res = await request('/api/pull', { method: 'POST', body: { model: id, stream: true }, timeoutMs: 0, signal });
    /** @type {Map<string, {total: number, completed: number}>} */
    const parts = new Map();
    let lastStatus = '';
    /** @type {LocalError|null} */
    let failure = null;
    try {
      await readNdjson(res, (msg) => {
        if (msg.error) { failure = new LocalError(classify(msg.error), String(msg.error), { raw: String(msg.error) }); return; }
        lastStatus = String(msg.status || '');
        if (msg.digest && Number(msg.total)) parts.set(msg.digest, { total: Number(msg.total), completed: Number(msg.completed) || 0 });
        let total = 0;
        let done = 0;
        for (const p of parts.values()) { total += p.total; done += Math.min(p.total, p.completed); }
        onProgress({ status: lastStatus, completedBytes: done, totalBytes: total, percent: total ? Math.min(100, (done / total) * 100) : null });
      }, { idleMs: 5 * 60 * 1000 });
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      throw err;
    }
    if (failure) throw failure;
    if (lastStatus !== 'success') {
      if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      throw new LocalError('network', 'Der Download wurde unterbrochen.', { raw: lastStatus });
    }
  }

  /** @param {string} id */
  async function remove(id) {
    await request('/api/delete', { method: 'DELETE', body: { model: id, name: id } });
  }

  /**
   * Modell laden (ohne Text zu erzeugen). Dieselben Optionen wie später beim Chat,
   * sonst lädt Ollama das Modell beim ersten Satz nochmals.
   * @param {string} id @param {{ keepAlive?: string|number, options?: Record<string, number>, signal?: AbortSignal }} [o]
   */
  async function load(id, { keepAlive = '30m', options = {}, signal } = {}) {
    const started = Date.now();
    const res = await request('/api/generate', { method: 'POST', body: { model: id, keep_alive: keepAlive, options, stream: false }, timeoutMs: 10 * 60 * 1000, signal });
    const data = await res.json().catch(() => ({}));
    return { loadMs: Date.now() - started, reportedLoadMs: data.load_duration ? Math.round(data.load_duration / 1e6) : null };
  }

  /** Modell aus dem Speicher nehmen @param {string} id */
  async function unload(id) {
    try { await request('/api/generate', { method: 'POST', body: { model: id, keep_alive: 0, stream: false }, timeoutMs: 15000 }); } catch { /* war nicht geladen */ }
  }

  /**
   * Chat mit Streaming.
   * @param {{
   *   model: string, messages: any[], tools?: any[], options?: Record<string, number>, think?: boolean|string|null,
   *   keepAlive?: string|number, format?: any, signal?: AbortSignal, idleMs?: number,
   *   onDelta?: (text: string) => void, onThinking?: (text: string) => void,
   * }} req
   */
  async function chat(req) {
    const started = Date.now();
    /** @type {Record<string, any>} */
    const body = { model: req.model, messages: req.messages, stream: true, keep_alive: req.keepAlive ?? '30m', options: req.options || {} };
    if (req.tools && req.tools.length) body.tools = req.tools;
    if (req.think !== null && req.think !== undefined) body.think = req.think;
    if (req.format) body.format = req.format;
    const res = await request('/api/chat', { method: 'POST', body, timeoutMs: 0, signal: req.signal });
    let content = '';
    let thinking = '';
    /** @type {any[]} */
    const toolCalls = [];
    /** @type {any} */
    let final = null;
    let firstTokenMs = 0;
    /** @type {LocalError|null} */
    let failure = null;
    try {
      await readNdjson(res, (msg) => {
        if (msg.error) { failure = new LocalError(classify(msg.error), String(msg.error), { raw: String(msg.error) }); return; }
        const m = msg.message || {};
        if (m.thinking) { thinking += m.thinking; req.onThinking?.(m.thinking); }
        if (m.content) {
          if (!firstTokenMs) firstTokenMs = Date.now() - started;
          content += m.content;
          req.onDelta?.(m.content);
        }
        if (Array.isArray(m.tool_calls)) toolCalls.push(...m.tool_calls);
        if (msg.done) final = msg;
      }, { idleMs: req.idleMs ?? 5 * 60 * 1000 });
    } catch (err) {
      if (req.signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      throw err;
    }
    if (failure) throw failure;
    if (!final) {
      if (req.signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      throw new LocalError('runner_crashed', 'Das lokale Modell hat die Antwort abgebrochen.');
    }
    const ns = (/** @type {any} */ x) => (Number(x) ? Math.round(Number(x) / 1e6) : null);
    return {
      content,
      thinking,
      toolCalls,
      doneReason: String(final.done_reason || 'stop'),
      promptTokens: Number(final.prompt_eval_count) || 0,
      evalTokens: Number(final.eval_count) || 0,
      timings: {
        totalMs: Date.now() - started,
        firstTokenMs: firstTokenMs || null,
        loadMs: ns(final.load_duration),
        promptMs: ns(final.prompt_eval_duration),
        evalMs: ns(final.eval_duration),
        tokensPerSecond: Number(final.eval_count) && Number(final.eval_duration) ? Math.round((Number(final.eval_count) / (Number(final.eval_duration) / 1e9)) * 10) / 10 : null,
      },
    };
  }

  /** Letzte Zeilen des Ollama-Protokolls (eigener Prozess oder server.log der Ollama-App) */
  function logTail(n = 80) {
    if (logLines.length) return logLines.slice(-n);
    if (platform === 'win32') {
      try {
        const file = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Ollama', 'server.log');
        const fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n);
      } catch { /* kein Protokoll */ }
    }
    return [];
  }

  /** Beschleuniger laut Ollama (aus dem Protokoll) */
  function computeDevices() {
    return parseComputeLines(logTail(LOG_LINES).length ? logTail(LOG_LINES) : []);
  }

  // ---------------- Installation (nur Windows automatisch) ----------------

  /** Was eine Installation bedeuten würde (Grösse, Weg). Lädt nichts herunter. */
  async function installPlan() {
    if (platform !== 'win32') return { automatic: false, method: 'manual', url: DOWNLOAD_PAGE, sizeBytes: null };
    let sizeBytes = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await remoteFetch(INSTALLER_URL, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      const len = Number(res.headers.get('content-length'));
      if (res.ok && len > 1e6) sizeBytes = len;
    } catch { /* unbekannt */ }
    return { automatic: true, method: 'download', url: INSTALLER_URL, sizeBytes };
  }

  /**
   * Prüft die digitale Signatur einer Windows-Programmdatei (Authenticode).
   * @param {string} file
   */
  async function verifySignature(file) {
    // Windows prüft die Signatur über die ganze Datei (über 1 GB): darum grosszügige Zeitgrenze
    const ps = `$ErrorActionPreference = 'Stop'; try { $s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; @{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress } catch { @{ status = 'Error'; subject = ''; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress }`;
    const r = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], 5 * 60 * 1000);
    let data = null;
    try { data = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)); } catch { data = null; }
    const status = String(data?.status || (r.code ? `exit ${r.code}` : 'no_output'));
    const subject = String(data?.subject || '');
    const detail = data?.error ? String(data.error).slice(0, 200) : !data ? r.out.slice(-200) : '';
    return { ok: status === 'Valid' && /(O|CN)=["]?Ollama/i.test(subject), status, subject, detail };
  }

  /**
   * Installiert Ollama für den aktuellen Benutzer (ohne Administratorrechte):
   * offizielles Installationsprogramm von ollama.com laden, Signatur prüfen, still ausführen.
   * Klappt der Download nicht, über winget (prüft die Prüfsumme aus dem Paketverzeichnis).
   * @param {{ onProgress?: (p: { phase: string, completedBytes?: number, totalBytes?: number, percent?: number|null }) => void, signal?: AbortSignal }} [o]
   */
  async function install({ onProgress = () => {}, signal } = {}) {
    if (platform !== 'win32') throw new LocalError('manual_install', 'Auf diesem System bitte Ollama selbst installieren.');
    const dir = fs.mkdtempSync(path.join(tmpDir, 'buddy-ollama-'));
    const file = path.join(dir, 'OllamaSetup.exe');
    let downloaded = false;
    try {
      onProgress({ phase: 'download', completedBytes: 0, totalBytes: 0, percent: 0 });
      const res = await remoteFetch(INSTALLER_URL, { redirect: 'follow', signal });
      if (!res.ok || !res.body) throw new LocalError('network', `Download fehlgeschlagen (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const out = fs.createWriteStream(file);
      const reader = res.body.getReader();
      let done = 0;
      let lastEmit = 0;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        done += value.byteLength;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', () => r(undefined)));
        if (Date.now() - lastEmit > 300) {
          lastEmit = Date.now();
          onProgress({ phase: 'download', completedBytes: done, totalBytes: total, percent: total ? (done / total) * 100 : null });
        }
      }
      await new Promise((resolve, reject) => { out.end(); out.on('finish', () => resolve(undefined)); out.on('error', reject); });
      downloaded = true;
    } catch (err) {
      if (signal?.aborted) { cleanup(dir); throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' }); }
      log(`Lokale KI: Download von ollama.com fehlgeschlagen (${/** @type {Error} */ (err).message}), versuche winget`);
    }

    if (downloaded) {
      onProgress({ phase: 'verify' });
      const sig = await verifySignature(file);
      if (!sig.ok) {
        cleanup(dir);
        log(`Lokale KI: Signatur ungültig (${sig.status}, ${sig.subject}, ${sig.detail})`);
        throw new LocalError('signature_invalid', 'Das Installationsprogramm ist nicht gültig signiert. Buddy hat es nicht ausgeführt.', { raw: `status=${sig.status} subject=${sig.subject} ${sig.detail}`.trim() });
      }
      onProgress({ phase: 'install' });
      const code = await new Promise((resolve) => {
        try {
          const p = spawnImpl(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], { windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => { try { p.kill(); } catch { /* weg */ } resolve(-1); }, 15 * 60 * 1000);
          p.on('exit', (c) => { clearTimeout(timer); resolve(c ?? -1); });
          p.on('error', () => { clearTimeout(timer); resolve(-1); });
        } catch {
          resolve(-1);
        }
      });
      cleanup(dir);
      if (code !== 0) throw new LocalError('install_failed', 'Die Installation von Ollama ist fehlgeschlagen.', { raw: `exit ${code}` });
    } else {
      cleanup(dir);
      const wg = await exec('where.exe', ['winget'], 5000);
      if (wg.code !== 0) throw new LocalError('network', 'Ollama konnte nicht heruntergeladen werden.');
      onProgress({ phase: 'install' });
      const r = await exec('winget', ['install', '--id', WINGET_ID, '-e', '--silent', '--scope', 'user', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], 20 * 60 * 1000);
      if (r.code !== 0 && !/already installed|bereits installiert/i.test(r.out)) throw new LocalError('install_failed', 'Die Installation von Ollama ist fehlgeschlagen.', { raw: r.out.slice(-400) });
    }
    knownExe = null;
    onProgress({ phase: 'start' });
    await start();
  }

  /** @param {string} dir */
  function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ }
  }

  return {
    id: 'ollama',
    name: 'Ollama',
    host,
    detect, version, start, stop, findExe, waitReady,
    list, ps, show, pull, remove, load, unload, chat,
    getModelsDir, setModelsDir,
    installPlan, install, verifySignature,
    logTail, computeDevices,
    isManaged: () => Boolean(managed && managed.exitCode === null),
  };
}

module.exports = { createOllama, LocalError, classify, parseComputeLines, readNdjson, DEFAULT_HOST, INSTALLER_URL, DOWNLOAD_PAGE };
