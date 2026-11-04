// @ts-check
// Modellkatalog, Speicherabschätzung und Empfehlung für die lokale KI.
//
// Der Katalog (models.json) nennt nur Kandidaten. Ob es ein Modell wirklich gibt, wie gross
// der Download ist, welche Quantisierung und welche Lizenz es hat, fragt Buddy direkt bei der
// Ollama-Registry nach (registryInfo). Nicht bestätigte Modelle werden nicht angeboten.
//
// Speicherbedarf = Modellgewichte (≈ Download-Grösse, schon quantisiert)
//                + Kontextspeicher (KV-Cache, wächst mit der Kontextlänge)
//                + Rechenpuffer der Laufzeit (≈ 0.4 GB + 5 % der Gewichte).
// Auf der Grafikkarte bleibt eine Reserve für Windows und andere Programme frei, im
// Arbeitsspeicher ebenso. Tempo wird nur in groben Stufen angegeben, nie als Zahl.

const fs = require('fs');
const path = require('path');

/** @typedef {import('./hardware').Hardware} Hardware */
/**
 * @typedef {{
 *   id: string, name: string, family: string, maker: string, params: number, active?: number,
 *   sizeGB: number, ctxMax: number, kvMBPer1k: number, alwaysThinks?: boolean,
 *   quality: { chat: number, german: number, coding: number, reasoning: number, tools: number },
 *   caps: string[], strengths: string[], limits: string[],
 * }} Candidate
 */
/** @typedef {'very_fast'|'fast'|'smooth'|'slow'|'very_slow'} Speed */
/**
 * @typedef {{
 *   device: 'gpu'|'partial'|'cpu'|'none', ctx: number, needGB: number, weightsGB: number, kvGB: number,
 *   gpuShare: number, fits: boolean, speed: Speed|null, reason: string|null,
 * }} Plan
 */
/** @typedef {{ available: boolean|null, sizeBytes: number|null, quant: string|null, license: string|null, requires: string|null, checkedAt: number, error?: string }} RegistryInfo */

const BUNDLED = require('./models.json');
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/;
const SPEED_ORDER = ['very_fast', 'fast', 'smooth', 'slow', 'very_slow'];
const CTX_STEPS = [32768, 16384, 8192, 4096, 2048];
const REMOTE_URL = 'https://raw.githubusercontent.com/wolfawidmer-sudo/buddy-island/main/src/local/models.json';
const REGISTRY = 'https://registry.ollama.ai';
const DAY = 24 * 3600 * 1000;

const round1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;

/** Prüft einen Katalog streng (er kann aus dem Netz kommen) @param {any} data @returns {Candidate[]|null} */
function validateCatalog(data) {
  if (!data || data.schema !== 1 || !Array.isArray(data.models)) return null;
  /** @type {Candidate[]} */
  const out = [];
  const num = (/** @type {any} */ x, /** @type {number} */ max) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= max;
  const words = (/** @type {any} */ a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && /^[a-z_]{2,32}$/.test(x)).slice(0, 8) : []);
  for (const m of data.models) {
    if (!m || typeof m.id !== 'string' || !ID_RE.test(m.id)) continue;
    if (!num(m.params, 2000) || !num(m.sizeGB, 1000) || !num(m.ctxMax, 10_000_000) || !num(m.kvMBPer1k, 10000)) continue;
    const q = m.quality || {};
    const score = (/** @type {any} */ x) => (typeof x === 'number' && x >= 0 && x <= 100 ? x : 0);
    out.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name.slice(0, 60) : m.id,
      family: typeof m.family === 'string' ? m.family.slice(0, 40) : '',
      maker: typeof m.maker === 'string' ? m.maker.slice(0, 40) : '',
      params: m.params,
      ...(num(m.active, 2000) && m.active < m.params ? { active: m.active } : {}),
      sizeGB: m.sizeGB,
      ctxMax: m.ctxMax,
      kvMBPer1k: m.kvMBPer1k,
      ...(m.alwaysThinks === true ? { alwaysThinks: true } : {}),
      quality: { chat: score(q.chat), german: score(q.german), coding: score(q.coding), reasoning: score(q.reasoning), tools: score(q.tools) },
      caps: words(m.caps),
      strengths: words(m.strengths),
      limits: words(m.limits),
    });
  }
  return out.length ? out : null;
}

/**
 * Katalog laden: eingebaut, ersetzt durch eine geprüfte neuere Fassung aus dem Repo.
 * @param {{ cacheFile?: string, fetchImpl?: typeof fetch, log?: (m: string) => void, now?: () => number }} [opts]
 */
async function loadCatalog({ cacheFile, fetchImpl, log = () => {}, now = Date.now } = {}) {
  let list = validateCatalog(BUNDLED) || [];
  let source = 'bundled';
  let updated = BUNDLED.updated || '';
  /** @type {any} */
  let cached = null;
  if (cacheFile) {
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cached = null; }
  }
  const useCached = (/** @type {any} */ c) => {
    const v = validateCatalog(c?.data);
    // Nur übernehmen, wenn sie nicht älter als die eingebaute ist
    if (v && String(c.data.updated || '') >= String(updated)) { list = v; source = 'remote'; updated = c.data.updated; }
  };
  if (cached) useCached(cached);
  if (fetchImpl && cacheFile && (!cached || now() - Number(cached.at || 0) > DAY)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetchImpl(REMOTE_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        if (text.length < 256 * 1024) {
          const data = JSON.parse(text);
          if (validateCatalog(data)) {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify({ at: now(), data }));
            useCached({ data });
          }
        }
      }
    } catch (err) {
      log(`Lokale KI: Katalog nicht aktualisiert (${/** @type {Error} */ (err).message})`);
    }
  }
  return { models: list, source, updated };
}

/** Lizenzname aus dem Lizenztext der Registry @param {string} text */
function licenseName(text) {
  const head = String(text || '').slice(0, 600);
  if (/apache license/i.test(head)) return 'Apache 2.0';
  if (/\bMIT License\b/i.test(head)) return 'MIT';
  if (/gemma terms of use/i.test(head)) return 'Gemma Terms of Use';
  const llama = /llama\s*([\d.]+)\s*community license/i.exec(head);
  if (llama) return `Llama ${llama[1]} Community License`;
  if (/qwen research license/i.test(head)) return 'Qwen Research License';
  if (/qwen license/i.test(head)) return 'Qwen License';
  if (/mistral research license/i.test(head)) return 'Mistral Research License';
  const first = head.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return first ? first.slice(0, 60) : null;
}

/**
 * Fragt die Ollama-Registry: gibt es das Modell, wie gross ist es, welche Quantisierung.
 * @param {string} id z. B. "qwen3.5:4b" @param {typeof fetch} fetchImpl @param {{ timeoutMs?: number, withLicense?: boolean }} [opts]
 * @returns {Promise<RegistryInfo>}
 */
async function registryInfo(id, fetchImpl, { timeoutMs = 8000, withLicense = true } = {}) {
  const [name, tag] = id.split(':');
  const repo = name.includes('/') ? name : `library/${name}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const base = { available: null, sizeBytes: null, quant: null, license: null, requires: null, checkedAt: Date.now() };
  try {
    const res = await fetchImpl(`${REGISTRY}/v2/${repo}/manifests/${tag}`, { headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }, signal: ctrl.signal });
    if (res.status === 404) return { ...base, available: false };
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    const manifest = await res.json();
    const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
    if (!layers.some((l) => /image\.model$/.test(String(l.mediaType)))) return { ...base, available: false };
    const sizeBytes = layers.reduce((s, l) => s + (Number(l.size) || 0), 0) + (Number(manifest.config?.size) || 0);
    /** @type {RegistryInfo} */
    const info = { ...base, available: true, sizeBytes };
    // Konfiguration (Quantisierung, nötige Ollama-Version) und Lizenz: klein, Fehler sind egal
    const blob = (/** @type {string} */ digest) => fetchImpl(`${REGISTRY}/v2/${repo}/blobs/${digest}`, { signal: ctrl.signal });
    try {
      if (manifest.config?.digest && Number(manifest.config.size) < 64 * 1024) {
        const cfg = await (await blob(manifest.config.digest)).json();
        info.quant = typeof cfg.file_type === 'string' ? cfg.file_type : null;
        info.requires = typeof cfg.requires === 'string' ? cfg.requires : null;
      }
    } catch { /* ohne */ }
    const lic = layers.find((l) => /image\.license$/.test(String(l.mediaType)));
    if (withLicense && lic && Number(lic.size) < 256 * 1024) {
      try { info.license = licenseName(await (await blob(lic.digest)).text()); } catch { /* ohne */ }
    }
    return info;
  } catch (err) {
    return { ...base, error: /** @type {Error} */ (err).name === 'AbortError' ? 'timeout' : /** @type {Error} */ (err).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Versionen vergleichen («0.12.3» ≥ «0.12») @param {string} a @param {string} b */
function versionAtLeast(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

// ---------------- Speicher und Tempo ----------------

/** @param {Candidate} c @param {number} ctx @param {number} [weightsGB] */
function memoryNeed(c, ctx, weightsGB = c.sizeGB) {
  const kvGB = (c.kvMBPer1k * (ctx / 1000)) / 1024;
  const overheadGB = 0.4 + weightsGB * 0.05;
  return { weightsGB, kvGB, overheadGB, totalGB: weightsGB + kvGB + overheadGB };
}

/** Wie viel Grafik- und Arbeitsspeicher Buddy für ein Modell einplanen darf @param {Hardware} hw */
function budgets(hw) {
  const g = hw.primary;
  let gpuGB = 0;
  if (g && g.vramGB) {
    const reserve = Math.max(0.8, g.vramGB * 0.1);
    gpuGB = g.vramGB - reserve;
    // Belegt ein Spiel oder ein anderes Programm schon viel, zählt der freie Speicher
    if (g.freeVramGB !== null && g.freeVramGB !== undefined) gpuGB = Math.min(gpuGB, g.freeVramGB - 0.4);
    gpuGB = Math.max(0, gpuGB);
  }
  const total = hw.ram.totalGB || 8;
  const osReserve = total <= 8 ? 3 : total <= 16 ? 6 : total <= 32 ? 8 : 10;
  const ramGB = Math.max(0, Math.min(total * 0.6, total - osReserve));
  return { gpuGB: round1(gpuGB), ramGB: round1(ramGB) };
}

/** @param {Hardware} hw */
function cpuStrength(hw) {
  const strong = hw.cpu.threads >= 16 || hw.ram.totalGB >= 60;
  const weak = hw.cpu.threads <= 4 || hw.cpu.avx2 === false;
  return strong ? 'strong' : weak ? 'weak' : 'normal';
}

/** @param {number} gb Daten pro Token auf dem Prozessor @param {'strong'|'normal'|'weak'} cpu @returns {Speed} */
function cpuSpeed(gb, cpu) {
  const f = cpu === 'strong' ? 1.8 : cpu === 'weak' ? 0.55 : 1;
  if (gb <= 1.3 * f) return 'fast';
  if (gb <= 3.0 * f) return 'smooth';
  if (gb <= 5.5 * f) return 'slow';
  return 'very_slow';
}

/** Bytes pro Parameter je Quantisierung (Q4_K_M ≈ 4.8 Bit) @param {string|null|undefined} quant */
function bytesPerParam(quant) {
  const q = String(quant || 'Q4_K_M').toUpperCase();
  if (/F16|BF16/.test(q)) return 2;
  if (/F32/.test(q)) return 4;
  if (/Q8/.test(q)) return 1.06;
  if (/Q6/.test(q)) return 0.82;
  if (/Q5/.test(q)) return 0.7;
  if (/MXFP4|Q3|IQ3/.test(q)) return 0.55;
  return 0.6;
}

/**
 * Daten, die pro erzeugtem Token gelesen werden (bestimmt das Tempo). Bei MoE-Modellen nur die
 * aktiven Experten, Bild- und Tonteile zählen nicht mit.
 * @param {Candidate} c @param {string|null} [quant]
 */
function perTokenGB(c, quant) {
  return (c.active || c.params) * bytesPerParam(quant);
}

/**
 * Wo und wie ein Modell auf diesem PC läuft.
 * @param {Candidate} c @param {Hardware} hw
 * @param {{ sizeBytes?: number|null, quant?: string|null, ctx?: number|null, maxCtx?: number }} [opts] ctx: fest gewünschte Länge (erweiterte Einstellungen)
 * @returns {Plan}
 */
function planFor(c, hw, opts = {}) {
  const weightsGB = opts.sizeBytes ? opts.sizeBytes / 1024 ** 3 : c.sizeGB;
  const { gpuGB, ramGB } = budgets(hw);
  const activeGB = perTokenGB(c, opts.quant);
  const cpu = cpuStrength(hw);
  const ctxCap = Math.min(c.ctxMax || 8192, opts.maxCtx || 32768);
  const steps = opts.ctx ? [Math.min(opts.ctx, c.ctxMax || opts.ctx)] : CTX_STEPS.filter((x) => x <= ctxCap);
  const fit = (/** @type {number} */ budget, /** @type {number} */ cap) => {
    for (const ctx of steps) {
      if (ctx > cap) continue;
      const need = memoryNeed(c, ctx, weightsGB);
      if (need.totalGB <= budget) return { ctx, need };
    }
    return null;
  };
  // 1) Ganz auf der Grafikkarte (bis 16k Kontext als Standard)
  if (gpuGB > 0) {
    const r = fit(gpuGB, 16384);
    if (r && (r.ctx >= 4096 || opts.ctx)) {
      const speed = activeGB <= 4.5 ? 'very_fast' : activeGB <= 12 ? 'fast' : 'smooth';
      return { device: 'gpu', ctx: r.ctx, needGB: round1(r.need.totalGB), weightsGB: round1(weightsGB), kvGB: round1(r.need.kvGB), gpuShare: 1, fits: true, speed, reason: null };
    }
    // 2) Teilweise: mindestens die Hälfte der Gewichte auf der Grafikkarte
    const r2 = fit(gpuGB + ramGB, 8192);
    if (r2 && (r2.ctx >= 4096 || opts.ctx)) {
      const onGpu = Math.max(0, gpuGB - r2.need.kvGB - r2.need.overheadGB);
      const share = Math.min(1, onGpu / weightsGB);
      if (share >= 0.35) {
        // Was auf dem Prozessor bleibt, bremst: höchstens «flüssig»
        const cpuPart = activeGB * (1 - share) * (cpu === 'strong' ? 0.6 : cpu === 'weak' ? 1.8 : 1);
        /** @type {Speed} */
        const speed = cpuPart <= 1.5 ? 'smooth' : cpuPart <= 3 ? 'slow' : 'very_slow';
        return { device: 'partial', ctx: r2.ctx, needGB: round1(r2.need.totalGB), weightsGB: round1(weightsGB), kvGB: round1(r2.need.kvGB), gpuShare: round1(share), fits: true, speed, reason: 'partial_offload' };
      }
    }
  }
  // 3) Nur Prozessor (Standard bis 8k Kontext)
  const r3 = fit(ramGB, 8192);
  if (r3 && (r3.ctx >= 4096 || opts.ctx)) {
    const speed = cpuSpeed(activeGB, cpu);
    return { device: 'cpu', ctx: r3.ctx, needGB: round1(r3.need.totalGB), weightsGB: round1(weightsGB), kvGB: round1(r3.need.kvGB), gpuShare: 0, fits: true, speed, reason: hw.primary ? 'too_big_for_gpu' : null };
  }
  const need = memoryNeed(c, 4096, weightsGB);
  return { device: 'none', ctx: 0, needGB: round1(need.totalGB), weightsGB: round1(weightsGB), kvGB: round1(need.kvGB), gpuShare: 0, fits: false, speed: null, reason: 'not_enough_memory' };
}

/** Qualität für den Einsatzzweck @param {Candidate} c @param {string} useCase @param {string} lang */
function qualityFor(c, useCase = 'chat', lang = 'de') {
  const q = c.quality;
  const local = lang === 'en' ? q.chat : (q.chat + q.german) / 2;
  switch (useCase) {
    case 'coding': return q.coding * 0.7 + local * 0.3;
    case 'reasoning': return q.reasoning * 0.7 + local * 0.3;
    case 'tools': return q.tools * 0.6 + local * 0.4;
    default: return local * 0.85 + q.tools * 0.15;
  }
}

/** @param {Speed|null} s */
const speedFactor = (s) => ({ very_fast: 1, fast: 1, smooth: 0.88, slow: 0.55, very_slow: 0.2 }[s || 'very_slow'] ?? 0.2);

/**
 * Empfehlungen für diesen PC: «Empfohlen», «Am schnellsten», «Beste Qualität».
 * @param {Hardware} hw
 * @param {Candidate[]} catalog
 * @param {{ registry?: Record<string, RegistryInfo>, installed?: string[], useCase?: string, lang?: string, runtimeVersion?: string|null }} [opts]
 */
function recommend(hw, catalog, opts = {}) {
  const registry = opts.registry || {};
  const installed = new Set(opts.installed || []);
  const lang = opts.lang || 'de';
  const rated = catalog.map((c) => {
    const reg = registry[c.id];
    const plan = planFor(c, hw, { sizeBytes: reg?.sizeBytes || null, quant: reg?.quant || null });
    const tooNew = Boolean(reg?.requires && opts.runtimeVersion && !versionAtLeast(opts.runtimeVersion, reg.requires));
    // Verfügbar: bestätigt, oder schon installiert. Unbekannt (offline) zählt nicht als bestätigt.
    const available = installed.has(c.id) || reg?.available === true;
    const usable = plan.fits && plan.speed !== 'very_slow' && !tooNew;
    const quality = qualityFor(c, opts.useCase, lang);
    return {
      ...c,
      plan,
      available,
      availability: installed.has(c.id) ? 'installed' : reg?.available === true ? 'confirmed' : reg?.available === false ? 'missing' : 'unknown',
      installed: installed.has(c.id),
      downloadBytes: reg?.sizeBytes || Math.round(c.sizeGB * 1024 ** 3),
      sizeExact: Boolean(reg?.sizeBytes),
      quant: reg?.quant || null,
      license: reg?.license || null,
      tooNew,
      usable,
      quality,
      score: quality * speedFactor(plan.speed) + (c.caps.includes('tools') ? 3 : 0) - (plan.device === 'partial' ? 5 : 0) - (c.alwaysThinks ? 12 : 0) + (installed.has(c.id) ? 2 : 0),
    };
  });
  const pool = rated.filter((r) => r.available && r.usable);
  const byScore = [...pool].sort((a, b) => b.score - a.score);
  const recommended = byScore.find((r) => !r.alwaysThinks) || byScore[0] || null;

  // Am schnellsten: wenig Daten pro Token und kurze Ladezeit, brauchbare Qualität, ohne Denkmodelle.
  // Für Deutsch und Französisch keine Modelle, die vor allem Englisch können.
  const latency = (/** @type {any} */ r) => perTokenGB(r, r.quant) + r.plan.weightsGB * 0.1;
  const fastPool = pool.filter((r) => !r.alwaysThinks && r.quality >= 38 && r !== recommended && (lang === 'en' || !r.limits.includes('english_focus')));
  fastPool.sort((a, b) => SPEED_ORDER.indexOf(a.plan.speed || 'very_slow') - SPEED_ORDER.indexOf(b.plan.speed || 'very_slow') || Math.round(latency(a) * 2) - Math.round(latency(b) * 2) || b.quality - a.quality);
  /** @type {typeof fastPool[number]|null} */
  let fastest = fastPool[0] || null;
  if (fastest && recommended && latency(fastest) > latency(recommended) * 0.8) fastest = null;

  // Beste Qualität: stärkstes Modell, das noch mindestens flüssig läuft; reicht das nicht
  // über die Empfehlung hinaus, darf es (deutlich gekennzeichnet) langsam sein
  const better = (/** @type {typeof rated[number]} */ r) => !recommended || r.quality > recommended.quality + 3;
  const thinkingOk = opts.useCase === 'reasoning' || opts.useCase === 'coding';
  const qualityPool = pool.filter((r) => r !== recommended && r !== fastest && better(r) && (thinkingOk || !r.alwaysThinks));
  const smooth = qualityPool.filter((r) => SPEED_ORDER.indexOf(r.plan.speed || 'very_slow') <= SPEED_ORDER.indexOf('smooth'));
  const best = [...(smooth.length ? smooth : qualityPool)].sort((a, b) => b.quality - a.quality)[0] || null;

  const { gpuGB, ramGB } = budgets(hw);
  return {
    recommended,
    fastest,
    best,
    all: rated,
    budget: { gpuGB, ramGB },
    mode: hw.primary && gpuGB >= 2 ? 'gpu' : 'cpu',
    nothingFits: !pool.length,
  };
}

module.exports = {
  BUNDLED, REMOTE_URL, REGISTRY, SPEED_ORDER, CTX_STEPS,
  validateCatalog, loadCatalog, registryInfo, licenseName, versionAtLeast,
  memoryNeed, budgets, planFor, qualityFor, recommend, cpuSpeed, perTokenGB, bytesPerParam,
};
