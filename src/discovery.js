// @ts-check
// Erkennt im Hintergrund, welche KI-Programme, CLIs und Laufzeiten auf dem PC installiert
// sind. Die Oberfläche zeigt nur, was es wirklich gibt: Nicht installierte Tools werden
// komplett ausgeblendet. Geprüft wird nur, ob etwas da ist (Pfade, Versionen), nie Inhalte.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { t } = require('./i18n');

/** @typedef {{ id: string, name: string, kind: 'cli'|'app'|'runtime', version?: string|null, path?: string|null, detail?: string|null }} DetectedTool */
/** @typedef {{ exe: string, args: string[], version: string, transformers: string, torch: string, hub: string|null, cuda: boolean, device: string, vramGB: number|null, gpu: string|null }} PythonRuntime */
/** @typedef {{ at: number, tools: DetectedTool[], python: PythonRuntime|null, hfModels: {id: string, size: number}[], has: Record<string, boolean> }} DiscoveryResult */

/**
 * Führt einen Befehl kurz aus und gibt stdout zurück (oder null).
 * @param {string} cmd @param {string[]} args @param {number} [timeout]
 * @returns {Promise<string|null>}
 */
function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout) => {
        resolve(err ? null : String(stdout || '').trim());
      });
    } catch {
      resolve(null);
    }
  });
}

/** @param {string} p */
const exists = (p) => fsp.access(p).then(() => true, () => false);

/**
 * Sucht ein Programm im PATH (Windows: where, sonst which).
 * @param {string} name
 */
async function which(name) {
  const out = await run(process.platform === 'win32' ? 'where.exe' : 'which', [name], 4000);
  if (!out) return null;
  return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
}

const PY_PROBE = 'import json,sys\nr={"version":sys.version.split()[0]}\ntry:\n import transformers;r["transformers"]=transformers.__version__\nexcept Exception: r["transformers"]=None\ntry:\n import torch;r["torch"]=torch.__version__;r["cuda"]=bool(torch.cuda.is_available())\n r["vram"]=round(torch.cuda.get_device_properties(0).total_memory/1073741824,1) if r["cuda"] else None\n r["gpu"]=torch.cuda.get_device_name(0) if r["cuda"] else None\n mps=getattr(torch.backends,"mps",None)\n r["mps"]=bool(mps and mps.is_available())\nexcept Exception: r["torch"]=None;r["cuda"]=False;r["mps"]=False\ntry:\n import huggingface_hub;r["hub"]=huggingface_hub.__version__\nexcept Exception: r["hub"]=None\nprint(json.dumps(r))';

/** @returns {Promise<{exe: string, args: string[], version: string}|null>} irgendein Python 3 (auch ohne Pakete) */
async function findPythonExe() {
  /** @type {Array<[string, string[]]>} */
  const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [exe, args] of candidates) {
    const out = await run(exe, [...args, '-c', 'import sys;print(sys.version.split()[0])'], 10000);
    if (out && /^3\.(\d+)/.test(out) && Number(out.split('.')[1]) >= 9) return { exe, args, version: out };
  }
  return null;
}

/** @returns {Promise<PythonRuntime|null>} Python mit transformers und torch */
async function findPython() {
  /** @type {Array<[string, string[]]>} */
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [exe, args] of candidates) {
    const out = await run(exe, [...args, '-c', PY_PROBE], 25000);
    if (!out) continue;
    try {
      const r = JSON.parse(out.split(/\r?\n/).pop() || '{}');
      if (r.transformers && r.torch) {
        return { exe, args, version: r.version, transformers: r.transformers, torch: r.torch, hub: r.hub, cuda: Boolean(r.cuda), device: r.cuda ? 'cuda' : r.mps ? 'mps' : 'cpu', vramGB: r.vram || null, gpu: r.gpu || null };
      }
    } catch { /* nächster Kandidat */ }
  }
  return null;
}

/**
 * Modelle im Hugging-Face-Cache (HF_HOME bzw. ~/.cache/huggingface/hub).
 * @param {string} home @param {NodeJS.ProcessEnv} env
 */
async function hfCacheModels(home, env) {
  const hub = env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(home, '.cache', 'huggingface'), 'hub');
  /** @type {{id: string, size: number}[]} */
  const out = [];
  let entries;
  try { entries = await fsp.readdir(hub, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('models--')) continue;
    const id = e.name.slice('models--'.length).replace(/--/g, '/');
    // Nur vollständige Modelle mit Konfiguration (keine reinen Tokenizer-Downloads)
    const snaps = path.join(hub, e.name, 'snapshots');
    let ok = false;
    try {
      for (const s of await fsp.readdir(snaps)) if (await exists(path.join(snaps, s, 'config.json'))) { ok = true; break; }
    } catch { ok = false; }
    if (ok) out.push({ id, size: 0 });
  }
  return out;
}

/**
 * @param {{ home: string, env?: NodeJS.ProcessEnv, localAppData?: string, log?: (m: string) => void }} opts
 */
function createDiscovery({ home, env = process.env, localAppData = env.LOCALAPPDATA || '', log = () => {} }) {
  /** @type {DiscoveryResult|null} */
  let last = null;
  /** @type {Promise<DiscoveryResult>|null} */
  let pending = null;
  /** @type {Set<(r: DiscoveryResult) => void>} */
  const listeners = new Set();

  /** @returns {Promise<DiscoveryResult>} */
  async function scan() {
    /** @type {DetectedTool[]} */
    const tools = [];
    /** @param {DetectedTool} t */
    const add = (t) => tools.push(t);

    // Kommandozeilen-Tools: im PATH oder an ihren üblichen Orten
    /** @type {Array<{id: string, name: string, bins: string[], dirs?: string[], versionArgs?: string[]}>} */
    const clis = [
      { id: 'claude_code', name: 'Claude Code', bins: ['claude'], dirs: [path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'), path.join(home, '.claude', 'local', process.platform === 'win32' ? 'claude.exe' : 'claude')] },
      { id: 'codex', name: 'Codex CLI', bins: ['codex'] },
      { id: 'gemini_cli', name: 'Gemini CLI', bins: ['gemini'] },
      { id: 'grok_cli', name: 'Grok CLI', bins: ['grok'] },
      { id: 'hf_cli', name: 'Hugging Face CLI', bins: ['hf', 'huggingface-cli'] },
    ];
    await Promise.all(clis.map(async (c) => {
      let found = null;
      for (const b of c.bins) { found = await which(b); if (found) break; }
      if (!found) for (const d of c.dirs || []) if (await exists(d)) { found = d; break; }
      if (found) add({ id: c.id, name: c.name, kind: 'cli', path: found, version: null });
    }));
    // Spuren auf der Platte zählen auch (z. B. Claude Code in WSL nicht, aber .claude-Protokolle schon)
    if (!tools.some((t) => t.id === 'claude_code') && await exists(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'))) {
      add({ id: 'claude_code', name: 'Claude Code', kind: 'cli', path: null, detail: t('Protokolle gefunden') });
    }
    if (!tools.some((t) => t.id === 'codex') && await exists(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'))) {
      add({ id: 'codex', name: 'Codex CLI', kind: 'cli', path: null, detail: t('Protokolle gefunden') });
    }

    // Desktop-Apps (Windows)
    if (process.platform === 'win32' && localAppData) {
      /** @type {Array<{id: string, name: string, paths: string[]}>} */
      const apps = [
        { id: 'claude_app', name: 'Claude (App)', paths: [path.join(localAppData, 'AnthropicClaude'), path.join(localAppData, 'Programs', 'Claude')] },
        { id: 'chatgpt_app', name: 'ChatGPT (App)', paths: [path.join(localAppData, 'Programs', 'ChatGPT'), path.join(localAppData, 'Microsoft', 'WindowsApps', 'ChatGPT.exe')] },
        { id: 'cursor', name: 'Cursor', paths: [path.join(localAppData, 'Programs', 'cursor')] },
        { id: 'lmstudio', name: 'LM Studio', paths: [path.join(localAppData, 'Programs', 'LM Studio')] },
      ];
      for (const a of apps) for (const p of a.paths) if (await exists(p)) { add({ id: a.id, name: a.name, kind: 'app', path: p }); break; }
    }

    // Hugging-Face-Laufzeit für lokale Modelle
    const python = await findPython();
    if (python) {
      add({ id: 'hf_runtime', name: 'Hugging Face Transformers', kind: 'runtime', version: python.transformers, detail: `Python ${python.version}, torch ${python.torch}, ${python.device === 'cuda' ? t('Grafikkarte (CUDA)') : python.device === 'mps' ? 'Apple GPU' : t('Prozessor')}` });
    }
    const hfModels = await hfCacheModels(home, env);

    /** @type {Record<string, boolean>} */
    const has = {};
    for (const t of tools) has[t.id] = true;
    return { at: Date.now(), tools, python, hfModels, has };
  }

  /** @param {{force?: boolean}} [opts] @returns {Promise<DiscoveryResult>} */
  async function get({ force = false } = {}) {
    if (last && !force) return last;
    if (pending) return pending;
    pending = scan().then((r) => {
      last = r;
      log(`Erkannt: ${r.tools.map((t) => t.name).join(', ') || 'keine KI-Tools'}`);
      for (const fn of listeners) fn(r);
      return r;
    }).catch((err) => {
      log(`Erkennung fehlgeschlagen: ${err.message}`);
      return last || { at: Date.now(), tools: [], python: null, hfModels: [], has: {} };
    }).finally(() => { pending = null; });
    return pending;
  }

  return {
    get,
    /** Letztes Ergebnis ohne zu warten (oder null) */
    peek: () => last,
    /** @param {(r: DiscoveryResult) => void} fn */
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { createDiscovery, findPython, findPythonExe, hfCacheModels, which, run };
