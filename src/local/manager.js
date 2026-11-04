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
 *   model: string|null, modelsDir: string|null, tools: boolean, unloadOnExit: boolean,
 *   advanced: { ctx: number|null, temperature: number|null, topP: number|null, maxTokens: number|null, keepAlive: string, gpu: 'auto'|'cpu', threads: number|null, batch: number|null },
 * }} LocalConfig
 */

const ADVANCED_DEFAULTS = { ctx: null, temperature: null, topP: null, maxTokens: null, keepAlive: 'auto', gpu: 'auto', threads: null, batch: null };
const REGISTRY_TTL = 6 * 3600 * 1000;
const KEEP_ALIVE = new Set(['auto', '5m', '30m', '2h', 'forever']);

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
 * }} deps
 */
function createLocalManager(deps) {
  const { runtime, getConfig, setConfig, cacheDir } = deps;
  const log = deps.log || (() => {});
  const lang = deps.lang || (() => 'de');
  const detectHw = deps.detectHardware || hardware.detect;
  const now = deps.now || Date.now;

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
    offline: false,
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
    if (!state.runtime?.running) { state.installed = []; return []; }
    try {
      const list = await runtime.list();
      state.installed = list.map((m) => ({ ...m, catalog: candidates.find((c) => c.id === m.id)?.name || null }));
    } catch (err) {
      log(`Lokale KI: Modellliste nicht lesbar (${/** @type {Error} */ (err).message})`);
    }
    return state.installed;
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
    const [, rt] = await Promise.all([refreshHardware(), refreshRuntime()]);
    // Läuft Ollama nicht, aber ist installiert: still starten (eigener Prozess)
    if (rt.installed && !rt.running) {
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
    refreshRegistry({ force }).then(() => { computePicks(); emit(); }).catch(() => {});
    if (deps.remoteFetch && !state.runtime?.installed) runtime.installPlan().then((p) => { state.installPlan = p; emit(); }).catch(() => {});
    return snapshot();
  }

  /** Phase aus dem aktuellen Wissen ableiten (ohne etwas zu tun) */
  function decidePhase() {
    if (state.phase === 'downloading' || state.phase === 'installing_runtime' || state.phase === 'loading') { emit(); return; }
    const cfg = getConfig();
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
    const prev = state.loaded?.id;
    setConfig({ model: id });
    state.model = id;
    // Nie zwei Modelle gleichzeitig: das vorherige zuerst freigeben
    if (prev && prev !== id) {
      await runtime.unload(prev);
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
      await refreshRuntime().catch(() => {});
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
  }

  return {
    init,
    snapshot,
    onChange: (/** @type {(s: any) => void} */ fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    refresh: async () => { await refreshHardware(); await refreshRuntime(); await refreshInstalled(); computePicks(); decidePhase(); return snapshot(); },
    refreshRegistry: async () => { await refreshRegistry({ force: true }); computePicks(); emit(); return snapshot(); },
    installRuntime, cancelInstall,
    pull, cancelPull, removeModel, selectModel,
    ensureLoaded, optionsFor, keepAliveValue, capsOf, info, recordPerf, noteChatError,
    setModelsDir, diagnostics, shutdown,
    candidates: () => candidates,
    hardware: () => hw,
    runtime,
  };
}

module.exports = { createLocalManager, cleanAdvanced, kvMBPer1kFromShow, ADVANCED_DEFAULTS };
