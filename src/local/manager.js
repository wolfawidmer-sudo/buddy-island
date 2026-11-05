// @ts-check
// Steuert die lokale KI: Hardware prüfen, Laufzeit finden/installieren/starten, Modelle
// empfehlen, herunterladen, laden, prüfen und wieder freigeben. Die Oberfläche bekommt
// nur einen Zustand (phase) und Zahlen für Fortschrittsbalken, keine Protokolle.
//
// Phasen: checking → needs_runtime → installing_runtime → starting → needs_model →
//         downloading → loading → ready   (jederzeit: error)

const path = require('path');
const fs = require('fs');
const hardware = require('./hardware');
const catalog = require('./catalog');
const { LocalError } = require('./ollama');

/** @typedef {import('./hardware').Hardware} Hardware */
/** @typedef {import('./catalog').Candidate} Candidate */
/**
 * @typedef {{
 *   model: string|null, modelsDir: string|null, colibriDir?: string|null, tools: boolean, unloadOnExit: boolean,
 *   colibriTwins?: Record<string, string>, autoRuntime?: boolean, alwaysColibri?: boolean,
 *   advanced: { ctx: number|null, temperature: number|null, topP: number|null, maxTokens: number|null, keepAlive: string, gpu: 'auto'|'cpu', threads: number|null, batch: number|null },
 * }} LocalConfig
 */

const ADVANCED_DEFAULTS = { ctx: null, temperature: null, topP: null, maxTokens: null, keepAlive: 'auto', gpu: 'auto', threads: null, batch: null };
const REGISTRY_TTL = 6 * 3600 * 1000;
const KEEP_ALIVE = new Set(['auto', '5m', '30m', '2h', 'forever']);
/** Colibrì-Modelle tragen dieses Präfix, alle anderen gehören Ollama */
const COLIBRI = '@colibri/';
const isColibri = (/** @type {string|null|undefined} */ id) => String(id || '').startsWith(COLIBRI);

/** Säubert die erweiterten Einstellungen @param {any} a */
function cleanAdvanced(a) {
  const x = { ...ADVANCED_DEFAULTS, ...(a && typeof a === 'object' ? a : {}) };
  const num = (/** @type {any} */ v, /** @type {number} */ min, /** @type {number} */ max) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) ? null : Math.min(max, Math.max(min, Number(v))));
  return {
    ctx: num(x.ctx, 2048, 262144),
    temperature: num(x.temperature, 0, 2),
    topP: num(x.topP, 0.05, 1),
    maxTokens: num(x.maxTokens, 64, 32768),
    keepAlive: KEEP_ALIVE.has(x.keepAlive) ? x.keepAlive : 'auto',
    gpu: x.gpu === 'cpu' ? 'cpu' : 'auto',
    threads: num(x.threads, 1, 256),
    batch: num(x.batch, 16, 4096),
  };
}

/**
 * Kontextspeicher pro Token aus dem Modellaufbau (vorsichtig: f16, alle Schichten)
 * @param {Awaited<ReturnType<ReturnType<import('./ollama')['createOllama']>['show']>>|null} s
 */
function kvMBPer1kFromShow(s) {
  if (!s || !s.layers || !s.kvHeads || !s.keyLength) return null;
  const v = s.valueLength || s.keyLength;
  const bytes = s.layers * s.kvHeads * (s.keyLength + v) * 2;
  return Math.max(4, Math.round((bytes * 1000) / 1024 / 1024));
}

/**
 * @param {{
 *   runtime: ReturnType<import('./ollama')['createOllama']>,
 *   getConfig: () => LocalConfig,
 *   setConfig: (patch: Partial<LocalConfig>) => void,
 *   remoteFetch?: typeof fetch,
 *   cacheDir: string,
 *   lang?: () => string,
 *   log?: (m: string) => void,
 *   detectHardware?: typeof hardware.detect,
 *   setUserEnv?: (name: string, value: string|null) => Promise<boolean>,
 *   now?: () => number,
 *   freeRamGB?: () => number,
 *   colibri?: ReturnType<import('./colibri')['createColibri']>|null,
 * }} deps
 */
function createLocalManager(deps) {
  const { runtime, getConfig, setConfig, cacheDir } = deps;
  const log = deps.log || (() => {});
  const lang = deps.lang || (() => 'de');
  const detectHw = deps.detectHardware || hardware.detect;
  const now = deps.now || Date.now;
  const colibri = deps.colibri || null;
  /** @type {AbortController|null} */
  let colibriCtrl = null;

  /** @type {Set<(s: any) => void>} */
  const listeners = new Set();
  /** @type {Hardware|null} */
  let hw = null;
  /** @type {Candidate[]} */
  let candidates = catalog.validateCatalog(catalog.BUNDLED) || [];
  let catalogInfo = { source: 'bundled', updated: catalog.BUNDLED.updated };
  /** @type {Record<string, import('./catalog').RegistryInfo>} */
  let registry = {};
  let registryAt = 0;
  /** @type {Map<string, any>} */
  const shown = new Map(); // Modell → show()-Ergebnis
  /** @type {AbortController|null} */
  let pullCtrl = null;
  /** @type {AbortController|null} */
  let installCtrl = null;
  /** @type {Promise<any>|null} */
  let loading = null;
  /** @type {string|null} */
  let loadedByBuddy = null;
  let initialized = false;

  /** Zustand für die Oberfläche */
  const state = {
    phase: 'checking',
    runtime: /** @type {any} */ (null),
    hardware: /** @type {any} */ (null),
    model: /** @type {string|null} */ (null),
    installed: /** @type {any[]} */ ([]),
    picks: /** @type {any} */ (null),
    download: /** @type {any} */ (null),
    install: /** @type {any} */ (null),
    loaded: /** @type {any} */ (null),
    perf: /** @type {any} */ (null),
    error: /** @type {any} */ (null),
    installPlan: /** @type {any} */ (null),
    /** Angebot: grosses Modell automatisch mit Colibrì (schneller) */
    colibriOffer: /** @type {any} */ (null),
    /** Laufende Ein-Klick-Einrichtung mit Colibrì: Schritt und Fehler */
    colibriAuto: /** @type {any} */ (null),
    offline: false,
    // Colibrì: { installed, version, configured, model, backend, state, python, catalog, plan, error }
    colibri: /** @type {any} */ (null),
  };

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) { try { fn(snap); } catch { /* egal */ } }
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({ ...state, config: { ...getConfig(), advanced: cleanAdvanced(getConfig().advanced) } }));
  }

  /** @param {string} phase @param {any} [error] */
  function setPhase(phase, error = null) {
    state.phase = phase;
    state.error = error;
    emit();
  }

  /** Fehler für die Oberfläche (Code + kurze technische Angabe für «Details») @param {any} err @param {string} [model] */
  function errorInfo(err, model) {
    const code = err instanceof LocalError ? err.code : err?.code && typeof err.code === 'string' ? err.code : 'error';
    return { code, model: model || null, detail: String(err?.raw || err?.message || '').slice(0, 300) };
  }

  // ---------------- Hardware und Laufzeit ----------------

  async function refreshHardware() {
    try {
      hw = await detectHw({ modelsDir: runtime.getModelsDir() });
    } catch (err) {
      log(`Lokale KI: Hardware-Erkennung fehlgeschlagen (${/** @type {Error} */ (err).message})`);
      hw = await detectHw({ modelsDir: runtime.getModelsDir(), platform: 'none' }).catch(() => null);
    }
    if (hw) {
      state.hardware = { ...hardware.summary(hw), gpus: hw.gpus.map((g) => ({ name: g.name, vendor: g.vendor, integrated: g.integrated, vramGB: g.vramGB, driver: g.driver, backends: g.backends, notes: g.notes })), avx2: hw.cpu.avx2, errors: hw.errors };
      log(`Lokale KI: Hardware ${hw.cpu.name}, ${hw.cpu.threads} Threads, ${hw.ram.totalGB} GB RAM, GPU: ${hw.gpus.map((g) => `${g.name} (${g.vramGB ?? '?'} GB, ${g.backends.join('/') || '-'})`).join('; ') || 'keine'}`);
    }
    return hw;
  }

  async function refreshRuntime() {
    state.runtime = await runtime.detect();
    return state.runtime;
  }

  async function refreshInstalled() {
    /** @type {any[]} */
    let list = [];
    if (state.runtime?.running) {
      try {
        list = (await runtime.list()).map((m) => ({ ...m, runtime: 'ollama', catalog: candidates.find((c) => c.id === m.id)?.name || null }));
      } catch (err) {
        log(`Lokale KI: Modellliste nicht lesbar (${/** @type {Error} */ (err).message})`);
        list = state.installed.filter((m) => m.runtime !== 'colibri');
      }
    }
    const c = state.colibri;
    if (c?.configured && c.model) list.push({ id: `${COLIBRI}${c.model.id}`, runtime: 'colibri', name: c.model.name, sizeBytes: null, catalog: c.model.name });
    state.installed = list;
    computeColibriOffer();
    return state.installed;
  }

  /**
   * Läuft ein grosses Modell mit Colibrì schneller als mit Ollama (gemessen: siehe chooseRuntime),
   * bietet Buddy das an: zuerst ein schon bei Ollama vorhandenes Modell (kein neuer Download),
   * sonst das beste, das hier mit Colibrì läuft. Nichts wird ohne Bestätigung geladen.
   */
  function computeColibriOffer() {
    const h = hw;
    if (!colibri || !h || state.colibri?.python === false) { state.colibriOffer = null; return; }
    const have = new Set(state.installed.filter((m) => m.runtime === 'ollama').map((m) => m.id));
    const twins = getConfig().colibriTwins || {};
    const ramOk = (h.ram?.totalGB || 0) >= 16;
    const freeGB = h.disk?.freeGB ?? null;
    /** @type {any[]} */
    const offers = [];
    for (const c of candidates) {
      if (!c.colibri || twins[c.id]) continue;
      const plan = catalog.planFor(c, h);
      const fromOllama = have.has(c.id);
      // Colibrì hält ein Modell; ist schon eines eingerichtet, kein weiterer Download anbieten
      if (!fromOllama && state.colibri?.configured) continue;
      const needGB = fromOllama ? 0 : c.sizeGB || 0;
      const fits = ramOk && (freeGB === null || freeGB >= needGB + 2);
      const choice = catalog.chooseRuntime({ plan, colibri: { fits, runs: 'ssd' }, colibriInstalled: false, disk: h.disk || null, prefer: preferRuntime() });
      if (choice.better !== 'colibri') continue;
      offers.push({ id: c.id, name: c.name, fromOllama, downloadGB: needGB, quality: Number(c.quality?.chat ?? c.quality) || 0, ollamaRuns: choice.runtime === 'ollama', note: choice.note || null });
    }
    offers.sort((a, b) => Number(b.fromOllama) - Number(a.fromOllama) || b.quality - a.quality);
    state.colibriOffer = offers[0] || null;
  }

  /**
   * Immer Colibrì, ohne Rückfrage, wo nichts heruntergeladen oder installiert werden muss:
   * Colibrì ist schon da und das Modell liegt bei Ollama. Läuft im Hintergrund, einmal pro Modell.
   * Muss Colibrì erst installiert oder das Modell geladen werden, bleibt es beim Angebot mit Bestätigung.
   */
  /** @type {Set<string>} */
  const autoTried = new Set();
  function maybeAutoColibri() {
    const o = state.colibriOffer;
    if (!o || !o.fromOllama || preferRuntime() !== 'colibri' || getConfig().autoRuntime === false) return null;
    if (!state.colibri?.installed || state.colibri.python === false || state.colibriAuto || colibriCtrl || autoTried.has(o.id)) return null;
    if (['downloading', 'installing_runtime', 'loading'].includes(state.phase)) return null;
    autoTried.add(o.id);
    log(`Lokale KI: ${o.id} wird automatisch auf Colibrì umgestellt (Datei von Ollama, kein Download)`);
    return colibriAuto(o.id);
  }

  /** Immer Colibrì (Standard, Wunsch des Nutzers) oder nur wenn nötig/schneller */
  function preferRuntime() {
    return getConfig().alwaysColibri === false ? 'auto' : 'colibri';
  }

  /** Für ein Ollama-Modell automatisch Colibrì nehmen? (nur wenn eingerichtet und gemessen schneller) @param {string} id */
  function autoColibriFor(id) {
    const cfg = getConfig();
    if (cfg.autoRuntime === false || isColibri(id) || !colibri || !hw) return null;
    const colId = cfg.colibriTwins?.[id];
    if (!colId || !state.colibri?.configured || `${COLIBRI}${state.colibri.model?.id}` !== colId) return null;
    const twin = candidates.find((c) => c.id === id && c.colibri);
    if (!twin) return null;
    const choice = catalog.chooseRuntime({ plan: catalog.planFor(twin, hw), colibri: { fits: true }, colibriInstalled: true, disk: hw.disk || null, prefer: preferRuntime() });
    return choice.runtime === 'colibri' ? colId : null;
  }

  /**
   * Ein Modell automatisch mit Colibrì betreiben. Die Oberfläche hat einmal gefragt und Grösse
   * gezeigt; danach läuft alles von selbst: Colibrì installieren (falls nötig), die Datei von
   * Ollama übernehmen (sonst herunterladen), einrichten, starten und verwenden.
   * @param {string} ollamaId
   */
  async function colibriAuto(ollamaId) {
    const twin = candidates.find((c) => c.id === ollamaId && c.colibri);
    if (!colibri || !twin || colibriCtrl) return snapshot();
    /** @param {string} step @param {any} [error] */
    const mark = (step, error = null) => { state.colibriAuto = { id: ollamaId, name: twin.name, step, error }; emit(); };
    try {
      mark('install');
      await refreshColibri();
      if (!state.colibri?.installed) {
        await colibriInstall();
        if (!state.colibri?.installed) { mark('error', state.colibri?.error || { code: 'runtime_missing', message: 'Colibrì konnte nicht installiert werden.' }); return snapshot(); }
      }
      if (state.colibri?.python === false) { mark('error', { code: 'python_missing', message: 'Für Colibrì fehlt Python 3.10 oder neuer.' }); return snapshot(); }
      // Schon bei Ollama: dieselbe Datei übernehmen (kein zweiter Download, kein zusätzlicher Platz)
      let modelDir = null;
      if (state.installed.some((m) => m.id === ollamaId && m.runtime === 'ollama')) {
        mark('import');
        if (loadedByBuddy) { await runtime.unload(loadedByBuddy).catch(() => {}); loadedByBuddy = null; state.loaded = null; }
        modelDir = await colibri.importFromOllama({ modelsDir: runtime.getModelsDir(), id: ollamaId, outRoot: getConfig().colibriDir || undefined });
      }
      if (modelDir) {
        mark('setup');
        colibriCtrl = new AbortController();
        try { await colibri.setupModel('', { modelDir, signal: colibriCtrl.signal }); } finally { colibriCtrl = null; }
      } else {
        mark('download');
        await colibriSetup(String(twin.colibri), { select: false });
        if (state.colibri?.error) { mark('error', state.colibri.error); return snapshot(); }
      }
      await refreshColibri();
      await refreshInstalled();
      const colId = state.colibri?.model?.id ? `${COLIBRI}${state.colibri.model.id}` : null;
      if (!state.colibri?.configured || !colId) { mark('error', { code: 'error', message: 'Colibrì ist nicht eingerichtet.' }); return snapshot(); }
      setConfig({ colibriTwins: { ...(getConfig().colibriTwins || {}), [ollamaId]: colId } });
      log(`Lokale KI: ${ollamaId} läuft ab jetzt automatisch mit Colibrì (${colId})`);
      mark('start');
      await selectModel(colId);
      state.colibriAuto = null;
      computeColibriOffer();
      emit();
    } catch (err) {
      if (/** @type {Error} */ (err).name === 'AbortError') { state.colibriAuto = null; emit(); }
      else mark('error', errorInfo(err));
    }
    return snapshot();
  }

  // ---------------- Colibrì ----------------

  /** Schneller Zustand von Colibrì (ohne Python, ausser es ist installiert und nichts bekannt) */
  async function refreshColibri() {
    if (!colibri) { state.colibri = null; return null; }
    try {
      const d = await colibri.detect();
      const py = d.installed ? await colibri.findPython().catch(() => null) : null;
      state.colibri = { ...(state.colibri || {}), ...d, python: d.installed ? Boolean(py) : (state.colibri?.python ?? null) };
    } catch (err) {
      state.colibri = { installed: false, error: errorInfo(err) };
    }
    return state.colibri;
  }

  /**
   * Colibrìs eigene Modellliste gegen diesen PC, ergänzt um die Laufzeitwahl: Gibt es dasselbe
   * Modell für Ollama und passt es dort in den Speicher, ist Ollama die Empfehlung.
   */
  async function colibriCatalog({ force = false } = {}) {
    if (!colibri) return [];
    await refreshColibri();
    if (!state.colibri?.installed) return [];
    try {
      const list = await colibri.catalog({ force });
      const h = hw || await refreshHardware();
      const annotated = list.filter((m) => m.kind === 'text').map((m) => {
        const twin = candidates.find((c) => c.colibri === m.id) || null;
        const plan = twin && h ? catalog.planFor(twin, h) : null;
        const choice = catalog.chooseRuntime({ plan, colibri: m, colibriInstalled: true, disk: h?.disk || null, prefer: preferRuntime() });
        return { ...m, id: `${COLIBRI}${m.id}`, colibriId: m.id, ollamaTwin: twin ? { id: twin.id, name: twin.name, fits: Boolean(plan?.fits && plan.speed !== 'very_slow'), speed: plan?.speed || null } : null, choice };
      });
      state.colibri = { ...state.colibri, catalog: annotated, error: null };
      emit();
      return annotated;
    } catch (err) {
      state.colibri = { ...state.colibri, catalog: null, error: errorInfo(err) };
      emit();
      return [];
    }
  }

  /** Was eine Colibrì-Installation bedeuten würde (lädt nichts) */
  async function colibriPlan() {
    if (!colibri) return null;
    const h = hw || await refreshHardware();
    const nv = h?.gpus.find((g) => g.vendor === 'nvidia' && !g.integrated);
    const plan = await colibri.installPlan({ cudaOk: Boolean(nv && (nv.computeCap || 0) >= 8) });
    state.colibri = { ...(state.colibri || {}), plan };
    emit();
    return plan;
  }

  /** Colibrì-Programm installieren (Download mit Prüfsumme). Die Oberfläche hat vorher gefragt. */
  async function colibriInstall() {
    if (!colibri || colibriCtrl) return snapshot();
    colibriCtrl = new AbortController();
    const h = hw || await refreshHardware();
    const nv = h?.gpus.find((g) => g.vendor === 'nvidia' && !g.integrated);
    state.colibri = { ...(state.colibri || {}), busy: 'install', progress: { phase: 'download', percent: 0 }, error: null };
    emit();
    try {
      await colibri.install({ cudaOk: Boolean(nv && (nv.computeCap || 0) >= 8), signal: colibriCtrl.signal, onProgress: (p) => { state.colibri = { ...state.colibri, progress: p }; emit(); } });
      await refreshColibri();
      state.colibri = { ...state.colibri, busy: null, progress: null };
      await colibriCatalog({ force: true });
    } catch (err) {
      state.colibri = { ...state.colibri, busy: null, progress: null, error: /** @type {Error} */ (err).name === 'AbortError' ? null : errorInfo(err) };
      if (/** @type {Error} */ (err).name !== 'AbortError') log(`Lokale KI: Colibrì-Installation fehlgeschlagen (${/** @type {any} */ (err).raw || /** @type {Error} */ (err).message})`);
    } finally {
      colibriCtrl = null;
      emit();
    }
    return snapshot();
  }

  /**
   * Ein Colibrì-Modell einrichten (Download). Die Oberfläche hat Grösse und Platz gezeigt und gefragt.
   * @param {string} id mit oder ohne Präfix @param {{ select?: boolean }} [o]
   */
  async function colibriSetup(id, { select = true } = {}) {
    if (!colibri || colibriCtrl) return snapshot();
    const plain = id.replace(COLIBRI, '');
    colibriCtrl = new AbortController();
    const entry = state.colibri?.catalog?.find((/** @type {any} */ m) => m.colibriId === plain);
    const total = entry?.downloadGB ? entry.downloadGB * 1e9 : 0;
    /** @type {{t: number, b: number}[]} */
    const samples = [];
    state.download = { id: `${COLIBRI}${plain}`, runtime: 'colibri', status: 'start', completedBytes: 0, totalBytes: total, percent: 0, speedBps: null, etaSec: null };
    const prev = state.phase;
    setPhase('downloading');
    try {
      // Ein von Buddy geladenes Ollama-Modell freigeben: der Download und Colibrì brauchen Platz
      if (loadedByBuddy) { await runtime.unload(loadedByBuddy).catch(() => {}); loadedByBuddy = null; state.loaded = null; }
      await colibri.setupModel(plain, {
        dir: getConfig().colibriDir || null,
        signal: colibriCtrl.signal,
        onProgress: (p) => {
          const t = now();
          if (p.completedBytes) samples.push({ t, b: p.completedBytes });
          while (samples.length > 2 && t - samples[0].t > 10000) samples.shift();
          const span = samples.length > 1 ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0;
          const speed = p.rateBps || (span >= 2 ? (samples[samples.length - 1].b - samples[0].b) / span : null);
          const tot = p.totalBytes || total;
          state.download = {
            id: `${COLIBRI}${plain}`, runtime: 'colibri', status: p.phase, completedBytes: p.completedBytes, totalBytes: tot,
            percent: tot ? Math.min(100, (p.completedBytes / tot) * 100) : null, speedBps: speed ? Math.round(speed) : null,
            etaSec: speed && tot && span >= 3 ? Math.round((tot - p.completedBytes) / speed) : null,
          };
          emit();
        },
      });
      state.download = null;
      await refreshColibri();
      await refreshInstalled();
      if (select) {
        colibriCtrl = null;
        await selectModel(`${COLIBRI}${plain}`);
      } else { state.phase = 'checking'; decidePhase(); }
    } catch (err) {
      state.download = null;
      state.phase = prev === 'downloading' ? 'needs_model' : prev;
      decidePhase();
      if (/** @type {Error} */ (err).name !== 'AbortError') {
        log(`Lokale KI: Colibrì-Modell ${plain} nicht eingerichtet (${/** @type {any} */ (err).raw || /** @type {Error} */ (err).message})`);
        state.error = errorInfo(err, `${COLIBRI}${plain}`);
        emit();
      }
    } finally {
      colibriCtrl = null;
    }
    return snapshot();
  }

  function cancelColibri() {
    colibriCtrl?.abort();
    colibri?.cancelSetup();
  }

  /** Registry-Angaben für die Kandidaten, die auf diesem PC überhaupt passen könnten */
  async function refreshRegistry({ force = false } = {}) {
    if (!deps.remoteFetch) return registry;
    if (!force && now() - registryAt < REGISTRY_TTL && Object.keys(registry).length) return registry;
    const cacheFile = path.join(cacheDir, 'local-registry.json');
    if (!force && !Object.keys(registry).length) {
      try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (now() - Number(c.at) < 3 * 24 * 3600 * 1000) { registry = c.data || {}; registryAt = Number(c.at); return registry; }
      } catch { /* neu */ }
    }
    const h = hw || await refreshHardware();
    const fitting = candidates.filter((c) => !h || catalog.planFor(c, h).fits);
    /** @type {Record<string, import('./catalog').RegistryInfo>} */
    const next = { ...registry };
    let reached = false;
    const queue = [...fitting];
    const remoteFetch = deps.remoteFetch;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const info = await catalog.registryInfo(c.id, remoteFetch);
        if (info.available !== null) { next[c.id] = info; reached = true; }
      }
    }));
    state.offline = !reached && fitting.length > 0;
    if (reached) {
      registry = next;
      registryAt = now();
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ at: registryAt, data: registry })); } catch { /* egal */ }
    }
    return registry;
  }

  /** Empfehlungen berechnen (für Oberfläche und Ersteinrichtung) */
  function computePicks() {
    if (!hw) return null;
    const r = catalog.recommend(hw, candidates, {
      registry, installed: state.installed.map((m) => m.id), lang: lang(), runtimeVersion: state.runtime?.version || null,
    });
    const lean = (/** @type {any} */ x, /** @type {string} */ role) => (x ? {
      role, id: x.id, name: x.name, maker: x.maker, downloadBytes: x.downloadBytes, sizeExact: x.sizeExact,
      needGB: x.plan.needGB, device: x.plan.device, gpuShare: x.plan.gpuShare, ctx: x.plan.ctx, speed: x.plan.speed,
      strengths: x.strengths, limits: x.limits, caps: x.caps, installed: x.installed, license: x.license, quant: x.quant,
    } : null);
    const all = r.all
      .filter((x) => x.available && x.plan.fits)
      .sort((a, b) => b.quality - a.quality)
      .map((x) => ({ ...lean(x, 'other'), usable: x.usable, tooNew: x.tooNew }));
    state.picks = {
      recommended: lean(r.recommended, 'recommended'),
      fastest: lean(r.fastest, 'fastest'),
      best: lean(r.best, 'best'),
      all,
      mode: r.mode,
      budget: r.budget,
      nothingFits: r.nothingFits,
      catalog: catalogInfo,
    };
    return state.picks;
  }

  /**
   * Erster Start bzw. Neuprüfung: Hardware und Laufzeit parallel, dann Modelle.
   * Lädt nie selbst etwas herunter.
   * @param {{ force?: boolean }} [opts]
   */
  async function init({ force = false } = {}) {
    if (initialized && !force) return snapshot();
    initialized = true;
    setPhase('checking');
    const cfg = getConfig();
    runtime.setModelsDir(cfg.modelsDir || null);
    const [, rt] = await Promise.all([refreshHardware(), refreshRuntime(), refreshColibri()]);
    // Läuft Ollama nicht, aber ist installiert: still starten (eigener Prozess).
    // Ist ein Colibrì-Modell gewählt, braucht es Ollama nicht.
    if (rt.installed && !rt.running && !isColibri(cfg.model)) {
      try {
        setPhase('starting');
        await runtime.start();
        await refreshRuntime();
      } catch (err) {
        log(`Lokale KI: Start fehlgeschlagen (${/** @type {Error} */ (err).message})`);
        await refreshRuntime();
        setPhase('error', errorInfo(err));
        return snapshot();
      }
    }
    await refreshInstalled();
    // Katalog aktualisieren und Registry fragen, ohne den Start aufzuhalten
    const cat = await catalog.loadCatalog({ cacheFile: path.join(cacheDir, 'local-catalog.json'), fetchImpl: deps.remoteFetch, log }).catch(() => null);
    if (cat) { candidates = cat.models; catalogInfo = { source: cat.source, updated: cat.updated }; }
    computePicks();
    decidePhase();
    maybeAutoColibri();
    refreshRegistry({ force }).then(() => { computePicks(); emit(); }).catch(() => {});
    if (deps.remoteFetch && !state.runtime?.installed) runtime.installPlan().then((p) => { state.installPlan = p; emit(); }).catch(() => {});
    return snapshot();
  }

  /** Phase aus dem aktuellen Wissen ableiten (ohne etwas zu tun) */
  function decidePhase() {
    if (state.phase === 'downloading' || state.phase === 'installing_runtime' || state.phase === 'loading') { emit(); return; }
    // Immer Colibrì: gibt es das gewählte Ollama-Modell auch in Colibrì, gilt Colibrì
    const routed = autoColibriFor(getConfig().model || '');
    if (routed) setConfig({ model: routed });
    const cfg = getConfig();
    if (isColibri(cfg.model)) {
      const have = state.installed.some((m) => m.id === cfg.model);
      if (have) { state.model = cfg.model; return setPhase(state.loaded?.id === cfg.model ? 'ready' : 'idle'); }
      // Colibrì-Modell nicht mehr eingerichtet: ehrlich melden, nicht still wechseln
      return setPhase('error', { code: state.colibri?.installed ? 'not_found' : 'runtime_missing', model: cfg.model });
    }
    if (!state.runtime?.installed) return setPhase('needs_runtime');
    if (!state.runtime.running) return setPhase('error', state.error || { code: 'runtime_failed' });
    const have = state.installed.some((m) => m.id === cfg.model);
    if (!cfg.model || !have) {
      // Ein installiertes Modell übernehmen, wenn noch keins gewählt ist (z. B. von früher)
      if (!cfg.model && state.installed.length) {
        const preferred = state.picks?.all?.find((/** @type {any} */ p) => p.installed && p.usable) || null;
        const pick = preferred?.id || state.installed[0].id;
        setConfig({ model: pick });
        state.model = pick;
        return setPhase(state.loaded?.id === pick ? 'ready' : 'idle');
      }
      state.model = null;
      return setPhase('needs_model');
    }
    state.model = cfg.model;
    return setPhase(state.loaded?.id === cfg.model ? 'ready' : 'idle');
  }

  // ---------------- Installation der Laufzeit ----------------

  async function installRuntime() {
    if (installCtrl) return snapshot();
    installCtrl = new AbortController();
    state.install = { phase: 'download', percent: 0, completedBytes: 0, totalBytes: state.installPlan?.sizeBytes || 0 };
    setPhase('installing_runtime');
    try {
      await runtime.install({
        signal: installCtrl.signal,
        onProgress: (p) => { state.install = { ...state.install, ...p }; emit(); },
      });
      state.install = null;
      await refreshRuntime();
      await refreshInstalled();
      computePicks();
      state.phase = 'checking';
      decidePhase();
    } catch (err) {
      state.install = null;
      if (/** @type {Error} */ (err).name === 'AbortError') { setPhase('needs_runtime'); }
      else {
        log(`Lokale KI: Installation fehlgeschlagen (${/** @type {any} */ (err).raw || /** @type {Error} */ (err).message})`);
        await refreshRuntime();
        setPhase('needs_runtime', errorInfo(err));
      }
    } finally {
      installCtrl = null;
    }
    return snapshot();
  }

  function cancelInstall() { installCtrl?.abort(); }

  // ---------------- Modelle ----------------

  /**
   * Lädt ein Modell herunter. Die Oberfläche hat vorher Grösse gezeigt und um Bestätigung gebeten.
   * @param {string} id @param {{ select?: boolean }} [opts]
   */
  async function pull(id, { select = true } = {}) {
    if (!/^[\w./-]+:[\w.-]+$|^[\w./-]+$/.test(id)) throw new LocalError('error', 'Ungültiger Modellname.');
    if (pullCtrl) return snapshot();
    if (!state.runtime?.running) await runtime.start().then(refreshRuntime);
    // Schon vorhanden: nicht nochmals laden
    if (state.installed.some((m) => m.id === id)) {
      if (select) await selectModel(id);
      return snapshot();
    }
    // Platz prüfen (mit 10 % + 1 GB Reserve)
    const reg = registry[id];
    const cand = candidates.find((c) => c.id === id);
    const bytes = reg?.sizeBytes || (cand ? cand.sizeGB * 1024 ** 3 : 0);
    const disk = await hardware.diskInfo(runtime.getModelsDir());
    if (bytes && disk?.freeGB !== null && disk?.freeGB !== undefined && disk.freeGB * 1024 ** 3 < bytes * 1.1 + 1024 ** 3) {
      setPhase(state.phase === 'downloading' ? 'needs_model' : state.phase, { code: 'disk_full', model: id, detail: `frei ${disk.freeGB} GB, nötig ${(bytes / 1024 ** 3).toFixed(1)} GB` });
      return snapshot();
    }
    pullCtrl = new AbortController();
    const prevPhase = state.phase;
    /** @type {{t: number, b: number}[]} */
    const samples = [];
    state.download = { id, status: 'start', completedBytes: 0, totalBytes: bytes, percent: 0, speedBps: null, etaSec: null };
    setPhase('downloading');
    try {
      await runtime.pull(id, {
        signal: pullCtrl.signal,
        onProgress: (p) => {
          // Download stockte, Buddy setzt ihn fort: bisherigen Stand behalten, Tempo neu messen
          if (p.status === 'resuming') {
            samples.length = 0;
            state.download = { ...(state.download || { id, completedBytes: 0, totalBytes: bytes, percent: 0 }), status: 'resuming', attempt: p.attempt, speedBps: null, etaSec: null };
            emit();
            return;
          }
          const t = now();
          samples.push({ t, b: p.completedBytes });
          while (samples.length > 2 && t - samples[0].t > 8000) samples.shift();
          const span = samples.length > 1 ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0;
          const speed = span >= 1.5 ? (samples[samples.length - 1].b - samples[0].b) / span : null;
          const remain = p.totalBytes - p.completedBytes;
          state.download = {
            id, status: p.status, completedBytes: p.completedBytes, totalBytes: p.totalBytes || bytes,
            percent: p.percent, speedBps: speed && speed > 0 ? Math.round(speed) : null,
            // Restzeit erst, wenn das Tempo einige Sekunden stabil gemessen ist
            etaSec: speed && speed > 0 && span >= 3 && remain > 0 ? Math.round(remain / speed) : null,
          };
          emit();
        },
      });
      log(`Lokale KI: ${id} heruntergeladen`);
      state.download = null;
      await refreshInstalled();
      computePicks();
      if (select || !getConfig().model) {
        pullCtrl = null;
        await selectModel(id);
      } else {
        state.phase = 'checking';
        decidePhase();
      }
    } catch (err) {
      state.download = null;
      if (/** @type {Error} */ (err).name === 'AbortError') {
        log(`Lokale KI: Download von ${id} abgebrochen`);
        state.phase = prevPhase === 'downloading' ? 'needs_model' : prevPhase;
        decidePhase();
      } else {
        log(`Lokale KI: Download von ${id} fehlgeschlagen (${/** @type {any} */ (err).raw || /** @type {Error} */ (err).message})`);
        state.phase = 'checking';
        decidePhase();
        state.error = errorInfo(err, id);
        emit();
      }
    } finally {
      pullCtrl = null;
    }
    return snapshot();
  }

  function cancelPull() { pullCtrl?.abort(); }

  /** @param {string} id */
  async function removeModel(id) {
    // Colibrì-Modelle verwaltet Colibrì selbst (eigener Ordner); Buddy löscht dort nichts
    if (isColibri(id)) throw new LocalError('manual', 'Colibrì-Modelle werden in Colibrì verwaltet.');
    if (state.loaded?.id === id) { await runtime.unload(id); state.loaded = null; if (loadedByBuddy === id) loadedByBuddy = null; }
    await runtime.remove(id);
    shown.delete(id);
    if (getConfig().model === id) setConfig({ model: null });
    await refreshInstalled();
    computePicks();
    state.phase = 'checking';
    decidePhase();
    return snapshot();
  }

  /** Modell wählen und gleich laden @param {string} id */
  async function selectModel(id) {
    // Gibt es dasselbe Modell in Colibrì und ist es dort gemessen schneller: automatisch Colibrì
    const auto = autoColibriFor(id);
    if (auto) {
      log(`Lokale KI: ${id} → Colibrì (schneller auf diesem PC)`);
      id = auto;
    }
    const prev = state.loaded?.id;
    setConfig({ model: id });
    state.model = id;
    // Nie zwei Modelle gleichzeitig: das vorherige zuerst freigeben (auch über Laufzeiten hinweg)
    if (prev && prev !== id) {
      if (isColibri(prev)) await colibri?.stop().catch(() => {});
      else await runtime.unload(prev).catch(() => {});
      if (loadedByBuddy === prev) loadedByBuddy = null;
      state.loaded = null;
    }
    await ensureLoaded(id).catch(() => {});
    return snapshot();
  }

  /** Fähigkeiten (aus Ollama, sonst Katalog) @param {string} id */
  async function info(id) {
    if (shown.has(id)) return shown.get(id);
    try {
      const s = await runtime.show(id);
      shown.set(id, s);
      return s;
    } catch {
      return null;
    }
  }

  /** Fähigkeiten ohne Wartezeit (für models.capabilities) @param {string} id */
  function capsOf(id) {
    if (isColibri(id)) {
      const c = colibri?.capabilities() || { tools: false, vision: false };
      return { tools: c.tools, vision: c.vision, thinking: false, alwaysThinks: false };
    }
    const s = shown.get(id);
    const c = candidates.find((x) => x.id === id);
    const caps = s ? s.caps : c ? c.caps : [];
    return { tools: caps.includes('tools'), vision: caps.includes('vision'), thinking: caps.includes('thinking'), alwaysThinks: Boolean(c?.alwaysThinks) };
  }

  /** Plan für ein (installiertes) Modell: Kontextlänge und Gerät @param {string} id */
  async function planOf(id) {
    const h = hw || await refreshHardware();
    const s = await info(id);
    const inst = state.installed.find((m) => m.id === id);
    const base = candidates.find((c) => c.id === id);
    const kv = kvMBPer1kFromShow(s);
    /** @type {Candidate} */
    const cand = {
      ...(base || { id, name: id, family: s?.family || '', maker: '', params: s?.paramCount ? s.paramCount / 1e9 : (inst?.sizeBytes || 4e9) / 0.6e9, sizeGB: 4, quality: { chat: 50, german: 50, coding: 50, reasoning: 50, tools: 50 }, caps: [], strengths: [], limits: [] }),
      sizeGB: inst?.sizeBytes ? inst.sizeBytes / 1024 ** 3 : base?.sizeGB || 4,
      ctxMax: s?.contextLength || base?.ctxMax || 8192,
      // Vorsichtiger Wert aus dem echten Aufbau; bei Hybrid-Modellen (nicht jede Schicht hat
      // Aufmerksamkeit) ist der Katalogwert genauer, darum der kleinere von beiden
      kvMBPer1k: kv && base ? Math.min(kv, Math.max(base.kvMBPer1k, kv / 4)) : kv || base?.kvMBPer1k || 160,
    };
    const adv = cleanAdvanced(getConfig().advanced);
    /** @type {Hardware} */
    const effective = adv.gpu === 'cpu' && h ? { ...h, primary: null } : /** @type {Hardware} */ (h);
    const plan = catalog.planFor(cand, effective, { sizeBytes: inst?.sizeBytes || null, quant: inst?.quant || null, ctx: adv.ctx });
    return { plan, cand };
  }

  function keepAliveValue() {
    const k = cleanAdvanced(getConfig().advanced).keepAlive;
    if (k === 'forever') return -1;
    if (k !== 'auto') return k;
    // Wenig Arbeitsspeicher: früher freigeben
    return (hw?.ram.totalGB || 16) <= 16 ? '10m' : '30m';
  }

  /** Ollama-Optionen für ein Modell (identisch für Laden und Chat, sonst lädt Ollama neu) @param {string} id */
  async function optionsFor(id) {
    if (isColibri(id)) {
      const ctx = colibri?.capabilities().contextTokens || 8192;
      return { options: { num_ctx: ctx }, plan: /** @type {any} */ ({ ctx, device: 'colibri', fits: true }) };
    }
    const { plan } = await planOf(id);
    const adv = cleanAdvanced(getConfig().advanced);
    /** @type {Record<string, number>} */
    const options = { num_ctx: plan.ctx || 4096 };
    if (adv.gpu === 'cpu') options.num_gpu = 0;
    if (adv.threads) options.num_thread = adv.threads;
    if (adv.batch) options.num_batch = adv.batch;
    return { options, plan };
  }

  /**
   * Stellt sicher, dass das Modell geladen ist: Speicher prüfen, laden, kurz testen.
   * @param {string} [id]
   */
  async function ensureLoaded(id = getConfig().model || '') {
    if (!id) throw new LocalError('no_model', 'Kein lokales Modell gewählt.');
    if (isColibri(id)) return ensureColibri(id);
    if (state.loaded?.id === id && state.phase === 'ready') {
      // Ollama kann es nach keep_alive selbst entladen haben: billig nachsehen
      const still = await runtime.ps().then((l) => l.some((m) => m.id === id)).catch(() => false);
      if (still) return state.loaded;
      state.loaded = null;
    }
    if (loading) return loading;
    loading = (async () => {
      setPhase('loading');
      try {
        if (!(await runtime.version())) {
          await runtime.start();
          await refreshRuntime();
        }
        if (!state.installed.some((m) => m.id === id)) await refreshInstalled();
        if (!state.installed.some((m) => m.id === id)) throw new LocalError('not_found', `Modell ${id} ist nicht installiert.`);
        // Freier Arbeitsspeicher jetzt (nicht nur beim Start): nicht laden, wenn es sicher nicht reicht
        if (!hw) await refreshHardware();
        if (hw) { hw.ram.freeGB = (deps.freeRamGB || hardware.freeRamGB)(); state.hardware = { ...state.hardware, freeRamGB: hw.ram.freeGB }; }
        const { options, plan } = await optionsFor(id);
        if (!plan.fits) throw new LocalError('out_of_memory', `Zu wenig Speicher: nötig etwa ${plan.needGB} GB`);
        const cpuPartGB = plan.device === 'cpu' ? plan.needGB : plan.device === 'partial' ? plan.weightsGB * (1 - plan.gpuShare) + 0.5 : 0.5;
        if (hw && hw.ram.freeGB + 1 < cpuPartGB) throw new LocalError('low_ram', `Frei ${hw.ram.freeGB} GB, nötig etwa ${cpuPartGB.toFixed(1)} GB`);
        // Andere von Buddy geladene Modelle zuerst freigeben
        const loaded = await runtime.ps().catch(() => []);
        for (const m of loaded) if (m.id !== id && m.id === loadedByBuddy) await runtime.unload(m.id);
        const keepAlive = keepAliveValue();
        const r = await runtime.load(id, { keepAlive, options });
        loadedByBuddy = id;
        // Kurzer Test: antwortet das Modell wirklich?
        const s = await info(id);
        const c = candidates.find((x) => x.id === id);
        const think = s?.caps?.includes('thinking') ? (c?.alwaysThinks ? (/gpt-oss/.test(id) ? 'low' : null) : false) : null;
        const test = await runtime.chat({ model: id, messages: [{ role: 'user', content: 'Reply with: OK' }], options: { ...options, num_predict: 8, temperature: 0 }, think, keepAlive, idleMs: 120000 });
        const ps = await runtime.ps().catch(() => []);
        const p = ps.find((m) => m.id === id);
        const gpuShare = p && p.sizeBytes ? p.vramBytes / p.sizeBytes : 0;
        state.loaded = {
          id,
          device: gpuShare > 0.95 ? 'gpu' : gpuShare > 0.05 ? 'partial' : 'cpu',
          gpuPercent: Math.round(gpuShare * 100),
          sizeBytes: p?.sizeBytes || null,
          vramBytes: p?.vramBytes || 0,
          ctx: p?.ctx || options.num_ctx,
          planned: plan.device,
          loadMs: r.loadMs,
          testOk: Boolean(test.content.trim() || test.evalTokens),
        };
        state.perf = { model: id, loadMs: r.loadMs, firstTokenMs: test.timings.firstTokenMs, tokensPerSecond: null, at: now() };
        log(`Lokale KI: ${id} geladen in ${r.loadMs} ms, ${state.loaded.gpuPercent} % auf der Grafikkarte, Kontext ${state.loaded.ctx}`);
        state.model = id;
        setPhase('ready');
        return state.loaded;
      } catch (err) {
        log(`Lokale KI: Laden von ${id} fehlgeschlagen (${/** @type {any} */ (err).code || ''} ${/** @type {any} */ (err).raw || /** @type {Error} */ (err).message})`);
        state.loaded = null;
        await refreshRuntime().catch(() => {});
        setPhase('error', errorInfo(err, id));
        throw err;
      }
    })().finally(() => { loading = null; });
    return loading;
  }

  /** Colibrì-Server starten (oder einen laufenden mitbenutzen) @param {string} id */
  async function ensureColibri(id) {
    if (!colibri) throw new LocalError('runtime_missing', 'Colibrì ist nicht verfügbar.');
    if (state.loaded?.id === id && state.phase === 'ready') {
      const d = await colibri.detect();
      if (d.running) return state.loaded;
      state.loaded = null;
    }
    if (loading) return loading;
    loading = (async () => {
      setPhase('loading');
      colibriCtrl = new AbortController();
      try {
        await refreshColibri();
        if (!state.colibri?.configured || `${COLIBRI}${state.colibri.model?.id}` !== id) throw new LocalError('not_found', `${id} ist in Colibrì nicht eingerichtet.`);
        // Ein von Buddy geladenes Ollama-Modell freigeben: Colibrì braucht den Arbeitsspeicher
        if (loadedByBuddy) { await runtime.unload(loadedByBuddy).catch(() => {}); loadedByBuddy = null; }
        const r = await colibri.start({
          signal: colibriCtrl.signal,
          onProgress: (p) => { state.download = null; state.install = { phase: `colibri_${p.phase}`, elapsedMs: p.elapsedMs }; emit(); },
        });
        state.install = null;
        await colibri.detect().then((d) => { state.colibri = { ...state.colibri, ...d }; });
        const backend = state.colibri?.backend || 'cpu';
        state.loaded = {
          id, runtime: 'colibri', backend,
          // Colibrì verteilt das Modell auf Grafikkarte, Arbeitsspeicher und SSD: «Grafikkarte» nur
          // behaupten, wenn Colibrì mit einem Grafik-Backend läuft, und dann als «teilweise»
          device: backend === 'cpu' ? 'cpu' : 'partial', gpuPercent: null,
          sizeBytes: null, vramBytes: null, ctx: colibri.capabilities().contextTokens, planned: 'colibri',
          loadMs: r.loadMs, reused: r.reused, testOk: null,
        };
        state.perf = { model: id, loadMs: r.loadMs, firstTokenMs: null, tokensPerSecond: null, at: now() };
        log(`Lokale KI: Colibrì ${id} bereit (${r.reused ? 'lief schon' : `geladen in ${r.loadMs} ms`}, ${backend})`);
        state.model = id;
        setPhase('ready');
        return state.loaded;
      } catch (err) {
        state.install = null;
        state.loaded = null;
        if (/** @type {Error} */ (err).name === 'AbortError') { setPhase('idle'); throw err; }
        log(`Lokale KI: Colibrì-Start fehlgeschlagen (${/** @type {any} */ (err).code || ''} ${/** @type {any} */ (err).raw || /** @type {Error} */ (err).message})`);
        setPhase('error', errorInfo(err, id));
        throw err;
      } finally {
        colibriCtrl = null;
      }
    })().finally(() => { loading = null; });
    return loading;
  }

  /** Laden abbrechen (nur Colibrì kann während des Ladens abgebrochen werden) */
  function cancelLoad() { if (state.phase === 'loading') colibriCtrl?.abort(); }

  /** Nach einem Chat: Messwerte merken (nur Zahlen, keine Inhalte) @param {string} id @param {any} timings */
  function recordPerf(id, timings) {
    if (!timings) return;
    state.perf = { model: id, loadMs: timings.loadMs, firstTokenMs: timings.firstTokenMs, tokensPerSecond: timings.tokensPerSecond, at: now() };
    emit();
  }

  /** Fehler aus einem Chat: Zustand anpassen, damit die Oberfläche nichts Falsches zeigt @param {any} err */
  async function noteChatError(err) {
    const code = err?.code;
    if (['unreachable', 'runner_crashed', 'gpu_error', 'out_of_memory', 'timeout'].includes(code)) {
      state.loaded = null;
      if (isColibri(getConfig().model)) await refreshColibri().catch(() => {});
      else await refreshRuntime().catch(() => {});
      setPhase('error', errorInfo(err, getConfig().model || undefined));
    }
  }

  // ---------------- Speicherort ----------------

  /**
   * Neuer Ordner für Modelle. Vorhandene Modelle bleiben am alten Ort, ausser `move` ist gesetzt.
   * @param {string|null} dir @param {{ move?: boolean }} [opts]
   */
  async function setModelsDir(dir, { move = false } = {}) {
    const oldDir = runtime.getModelsDir();
    const target = dir ? path.resolve(dir) : null;
    if (target) fs.mkdirSync(target, { recursive: true });
    if (move && target && path.resolve(oldDir) !== target) {
      for (const sub of ['blobs', 'manifests']) {
        const from = path.join(oldDir, sub);
        if (!fs.existsSync(from)) continue;
        await fs.promises.cp(from, path.join(target, sub), { recursive: true, force: false, errorOnExist: false });
      }
    }
    setConfig({ modelsDir: target });
    runtime.setModelsDir(target);
    // Damit auch die Ollama-App (falls sie den Server stellt) den Ordner benutzt
    const envOk = deps.setUserEnv ? await deps.setUserEnv('OLLAMA_MODELS', target) : false;
    const wasManaged = runtime.isManaged();
    if (wasManaged) {
      await runtime.stop();
      await runtime.start();
    }
    if (move && target && path.resolve(oldDir) !== target) {
      // Erst löschen, wenn die Modelle am neuen Ort sichtbar sind
      const ok = !wasManaged || (await runtime.list().catch(() => [])).length >= state.installed.length;
      if (ok) for (const sub of ['blobs', 'manifests']) { try { await fs.promises.rm(path.join(oldDir, sub), { recursive: true, force: true }); } catch { /* bleibt */ } }
    }
    await refreshRuntime();
    await refreshInstalled();
    computePicks();
    state.phase = 'checking';
    decidePhase();
    return { ...snapshot(), needsRestart: !wasManaged && Boolean(state.runtime?.running), envOk };
  }

  // ---------------- Diagnose und Ende ----------------

  async function diagnostics() {
    const full = hw || await refreshHardware();
    const [rt, ps] = await Promise.all([runtime.detect(), runtime.ps().catch(() => [])]);
    return {
      hardware: full,
      runtime: rt,
      devices: runtime.computeDevices(),
      loaded: ps,
      perf: state.perf,
      state: state.phase,
      error: state.error,
      catalog: catalogInfo,
      registryChecked: registryAt ? new Date(registryAt).toISOString() : null,
      log: runtime.logTail(60),
      colibri: colibri ? await colibri.detect().catch(() => null) : null,
      colibriLog: colibri && state.colibri?.installed ? await colibri.logs(30).catch(() => '') : '',
    };
  }

  /** Beim Beenden von Buddy: eigenes Modell freigeben, eigenen Server beenden */
  async function shutdown() {
    pullCtrl?.abort();
    installCtrl?.abort();
    try {
      if (loadedByBuddy && getConfig().unloadOnExit !== false) await runtime.unload(loadedByBuddy);
    } catch { /* egal */ }
    await runtime.stop().catch(() => {});
    colibriCtrl?.abort();
    colibri?.cancelSetup();
    if (getConfig().unloadOnExit !== false) await colibri?.stop().catch(() => {});
  }

  return {
    init,
    snapshot,
    onChange: (/** @type {(s: any) => void} */ fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    refresh: async () => { await refreshHardware(); await refreshRuntime(); await refreshColibri(); await refreshInstalled(); computePicks(); decidePhase(); return snapshot(); },
    refreshRegistry: async () => { await refreshRegistry({ force: true }); computePicks(); emit(); return snapshot(); },
    installRuntime, cancelInstall,
    pull, cancelPull, removeModel, selectModel,
    ensureLoaded, optionsFor, keepAliveValue, capsOf, info, recordPerf, noteChatError,
    setModelsDir, diagnostics, shutdown, cancelLoad,
    colibriCatalog, colibriPlan, colibriInstall, colibriSetup, colibriAuto, maybeAutoColibri, cancelColibri, refreshColibri,
    isColibri, colibri,
    candidates: () => candidates,
    hardware: () => hw,
    runtime,
  };
}

module.exports = { createLocalManager, cleanAdvanced, kvMBPer1kFromShow, ADVANCED_DEFAULTS, COLIBRI, isColibri };
