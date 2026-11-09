// @ts-check
const learned = require('./llm/learned');
// Anbieter, Modelle, Preise und Fähigkeiten an einem Ort.
// Router, Agent und Adapter lesen nur diese Daten. Ein neuer Anbieter braucht
// hier einen Eintrag in PROVIDERS, seine Modelle im CATALOG und einen Adapter in src/llm/.

/** @typedef {import('./llm/types').ProviderId} ProviderId */
/** @typedef {import('./llm/types').ModelInfo} ModelInfo */
/** @typedef {import('./llm/types').ProviderInfo} ProviderInfo */
/** @typedef {import('./llm/types').Tier} Tier */

// Preise in US-Dollar pro 1 Million Tokens.
// Claude: Preisliste von Anthropic (November 2026). Andere Anbieter: Stand Oktober 2026
// aus öffentlichen Preisübersichten, darum als Schätzung markiert (priceEstimated).
// cacheWrite = Cache schreiben, cacheRead = aus dem Cache lesen.
/** @type {ModelInfo[]} */
const CATALOG = [
  // ---- Anthropic ----
  {
    id: 'claude-haiku-5-5', provider: 'anthropic', tier: 'haiku', name: 'Claude Haiku 5.5', short: 'Haiku 5.5',
    price: { in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    longContext: { above: 100000, price: { in: 0.50, out: 2.50, cacheWrite: 0.625, cacheRead: 0.05 } },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], caps: { vision: true, tools: true, computerUse: true, structured: true },
  },
  {
    id: 'claude-sonnet-5-5', provider: 'anthropic', tier: 'sonnet', name: 'Claude Sonnet 5.5', short: 'Sonnet 5.5',
    price: { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], caps: { vision: true, tools: true, computerUse: true, structured: true },
  },
  {
    id: 'claude-opus-5-5', provider: 'anthropic', tier: 'opus', name: 'Claude Opus 5.5', short: 'Opus 5.5',
    price: { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], caps: { vision: true, tools: true, computerUse: true, structured: true },
  },
  // ---- OpenAI ----
  // Aktuelle Modelle laut developers.openai.com/api/docs/models (November 2026). GPT-4o, GPT-4o mini
  // und GPT-5 sind abgekündigt (Abschaltung 11.12.2026 bzw. 14.1.2027). Gecachte Eingabe: Schätzung.
  {
    id: 'gpt-6-luna', provider: 'openai', tier: 'haiku', name: 'GPT-6 Luna', short: 'GPT-6 Luna',
    price: { in: 0.10, out: 0.50, cacheWrite: 0.10, cacheRead: 0.01 }, priceEstimated: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortParam: 'reasoning_effort', reasoningNone: true,
    caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  {
    id: 'gpt-6.1-terra', provider: 'openai', tier: 'sonnet', name: 'GPT-6.1 Terra', short: 'GPT-6.1 Terra',
    price: { in: 1, out: 5, cacheWrite: 1, cacheRead: 0.1 }, priceEstimated: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortParam: 'reasoning_effort', reasoningNone: true,
    caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  {
    id: 'gpt-6.1-sol', provider: 'openai', tier: 'opus', name: 'GPT-6.1 Sol', short: 'GPT-6.1 Sol',
    price: { in: 2, out: 10, cacheWrite: 2, cacheRead: 0.2 }, priceEstimated: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortParam: 'reasoning_effort',
    caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  // ---- xAI ----
  // docs.x.ai (Release Notes, Migration 15.5.2026): grok-4.3 ist das aktuelle Standardmodell
  // (1.25 / 2.50 USD), grok-4.6 und grok-4.7 die grösseren. Preise von 4.6/4.7: Schätzung.
  {
    id: 'grok-4.3', provider: 'xai', tier: 'haiku', name: 'Grok 4.3', short: 'Grok 4.3',
    price: { in: 1.25, out: 2.5, cacheWrite: 1.25, cacheRead: 0.2 },
    efforts: ['low', 'medium', 'high'], effortParam: 'reasoning_effort', caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  {
    id: 'grok-4.6', provider: 'xai', tier: 'sonnet', name: 'Grok 4.6', short: 'Grok 4.6',
    price: { in: 2, out: 6, cacheWrite: 2, cacheRead: 0.5 }, priceEstimated: true,
    efforts: ['low', 'medium', 'high'], effortParam: 'reasoning_effort', caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  {
    id: 'grok-4.7', provider: 'xai', tier: 'opus', name: 'Grok 4.7', short: 'Grok 4.7',
    price: { in: 2, out: 6, cacheWrite: 2, cacheRead: 0.5 }, priceEstimated: true,
    efforts: ['low', 'medium', 'high', 'xhigh'], effortParam: 'reasoning_effort', caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  // ---- Google ----
  // Google zieht ältere Versionen für neue Konten zurück (404 «no longer available to new users»).
  // Darum stehen hier die offiziellen Aliase, die immer auf die aktuelle Version zeigen; mit
  // Modellliste nimmt Buddy ohnehin die neueste verfügbare Version (siehe pickGemini).
  {
    id: 'gemini-flash-lite-latest', provider: 'gemini', tier: 'haiku', name: 'Gemini Flash-Lite', short: 'Gemini Flash-Lite',
    price: { in: 0.10, out: 0.40, cacheWrite: 0.10, cacheRead: 0.01 }, priceEstimated: true,
    efforts: [], caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  {
    id: 'gemini-flash-latest', provider: 'gemini', tier: 'sonnet', name: 'Gemini Flash', short: 'Gemini Flash',
    price: { in: 0.30, out: 2.5, cacheWrite: 0.30, cacheRead: 0.03 }, priceEstimated: true,
    efforts: [], caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
  {
    id: 'gemini-pro-latest', provider: 'gemini', tier: 'opus', name: 'Gemini Pro', short: 'Gemini Pro',
    price: { in: 1.25, out: 10, cacheWrite: 1.25, cacheRead: 0.125 }, priceEstimated: true,
    efforts: [], caps: { vision: true, tools: true, computerUse: false, structured: true },
  },
];

// Abgekündigte Modelle mit Abschaltdatum laut Anbieter (developers.openai.com/api/docs/deprecations).
// Buddy ersetzt ein manuell gewähltes Modell nie selbst, zeigt aber einen Hinweis.
/** @type {Record<string, { until: string, replacement: string }>} */
const DEPRECATED = {
  'gpt-5': { until: '2026-12-11', replacement: 'gpt-6.1-sol' },
  'gpt-5-mini': { until: '2026-12-11', replacement: 'gpt-6.1-terra' },
  'gpt-5-nano': { until: '2026-12-11', replacement: 'gpt-6-luna' },
  o3: { until: '2026-12-11', replacement: 'gpt-6.1-sol' },
  'o3-pro': { until: '2026-12-11', replacement: 'gpt-6.1-sol' },
  'gpt-4o': { until: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-4o-mini': { until: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-4.1': { until: '2027-01-14', replacement: 'gpt-6-luna' },
  'gpt-4.1-mini': { until: '2027-01-14', replacement: 'gpt-6-luna' },
};
/** Früher eingebaute Standardmodelle (nicht vom Nutzer gewählt, dürfen ersetzt werden) */
const OLD_DEFAULTS = new Set(['gpt-4o-mini', 'gpt-4o', 'gpt-5']);

// Reihenfolge von günstig/einfach nach teuer/stark (Namen historisch von Claude)
/** @type {Tier[]} */
const TIERS = ['haiku', 'sonnet', 'opus'];

const TIER_LABEL = { haiku: 'Schnell', sonnet: 'Ausgewogen', opus: 'Stark' };

const TIER_FALLBACK_PRICE = {
  haiku: { in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
  sonnet: { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  opus: { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
  fable: { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};
const ZERO_PRICE = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };

/** @type {Record<ProviderId, ProviderInfo>} */
const PROVIDERS = {
  // Wie man sich anmeldet (Key-Hilfe, Prüfung, Fehlerdeutung) steht pro Anbieter in src/llm/auth.js
  anthropic: {
    id: 'anthropic', kind: 'anthropic', name: 'Anthropic Claude', consoleUrl: 'https://platform.claude.com/settings/keys',
    host: 'api.anthropic.com', baseUrl: 'https://api.anthropic.com/v1', needsKey: true,
  },
  // OpenAI über die Responses API: nur dort gehen Werkzeuge zusammen mit Denken bei GPT-6
  openai: {
    id: 'openai', kind: 'openai-responses', name: 'OpenAI', consoleUrl: 'https://platform.openai.com/api-keys',
    host: 'api.openai.com', baseUrl: 'https://api.openai.com/v1', needsKey: true, family: /^(gpt-|o\d|chatgpt-)/i,
  },
  xai: {
    id: 'xai', kind: 'openai', name: 'xAI Grok', consoleUrl: 'https://console.x.ai',
    host: 'api.x.ai', baseUrl: 'https://api.x.ai/v1', needsKey: true, family: /^grok/i,
  },
  gemini: {
    id: 'gemini', kind: 'gemini', name: 'Google Gemini', consoleUrl: 'https://aistudio.google.com/apikey',
    host: 'generativelanguage.googleapis.com', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, family: /^(models\/)?gemini/i,
  },
  // Buddy Cloud: OpenAI über das Buddy-Island-Backend, bezahlt mit Buddy Credits (kein eigener Key).
  // Gleiches Protokoll wie OpenAI (Responses API), nur andere Adresse und Anmeldung mit dem Buddy-Konto.
  buddy: {
    id: 'buddy', kind: 'openai-responses', name: 'Buddy Cloud', consoleUrl: 'https://buddy-island.top',
    host: 'buddy-cloud', get baseUrl() { return cloudBase(); }, needsKey: false, account: true, modelPrefix: 'cloud:',
  },
  local: {
    id: 'local', kind: 'local', name: 'Lokal auf diesem PC', consoleUrl: 'https://ollama.com',
    host: '127.0.0.1', baseUrl: 'http://127.0.0.1:11434', needsKey: false, local: true,
  },
  huggingface: {
    id: 'huggingface', kind: 'huggingface', name: 'Hugging Face (lokal)', consoleUrl: 'https://huggingface.co/settings/tokens',
    host: 'huggingface.co', baseUrl: '', needsKey: false, local: true,
  },
};

const HF_PREFIX = 'hf:';
const LOCAL_PREFIX = 'local:';
const CLOUD_PREFIX = 'cloud:';

/** Basis-Adresse des Cloud-Gateways (leer, wenn Buddy Cloud nicht eingerichtet ist) */
function cloudBase() {
  const api = require('./cloud/config').apiUrl();
  return api ? `${api}/v1/cloud` : '';
}

// Fähigkeiten lokaler Modelle kennt erst die Laufzeit (Ollama meldet tools/vision/thinking).
/** @type {(id: string) => { tools: boolean, vision: boolean } | null} */
let localCaps = () => null;
/** @type {(id: string) => string|null} */
let localName = () => null;
/** @param {{ caps?: typeof localCaps, name?: typeof localName }} r */
function setLocalResolver(r) {
  if (r.caps) localCaps = r.caps;
  if (r.name) localName = r.name;
}

/** @param {string} modelId @returns {ProviderId} */
function providerOf(modelId) {
  const id = String(modelId || '');
  const known = CATALOG.find((m) => m.id === id);
  if (known) return known.provider;
  if (id.startsWith(HF_PREFIX)) return 'huggingface';
  if (id.startsWith(LOCAL_PREFIX)) return 'local';
  if (id.startsWith(CLOUD_PREFIX)) return 'buddy';
  if (/^claude/i.test(id)) return 'anthropic';
  for (const p of /** @type {ProviderInfo[]} */ (Object.values(PROVIDERS))) if (p.family && p.family.test(id)) return p.id;
  return 'anthropic';
}

/** @param {string} modelId @returns {Tier|'fable'} */
function tierOf(modelId) {
  const id = String(modelId || '').toLowerCase().replace(/^cloud:/, '');
  const known = CATALOG.find((m) => m.id === id);
  if (known) return known.tier;
  for (const tier of [...TIERS, 'fable']) if (id.includes(tier)) return /** @type {Tier} */ (tier);
  if (/(^|[-_.\s])(mini|nano|lite|luna|small|fast)([-_.\s]|$)/.test(id)) return 'haiku';
  if (/(^|[-_.\s])(pro|astra|large|heavy)([-_.\s]|$)/.test(id)) return 'opus';
  return 'sonnet';
}

/**
 * Denkmodelle mit reasoning_effort: GPT-5.x, o-Serie, Grok-Mini. «chat»- und «non-reasoning»-Varianten denken nicht.
 * @param {string|undefined} provider @param {string} id
 */
function isReasoningModel(provider, id) {
  if (/non-reasoning|chat-latest|-chat\b/i.test(id)) return false;
  if (provider === 'openai') return /^(gpt-[5-9]|o[1-9])/i.test(id);
  if (provider === 'xai') return /^grok-(3-mini|4\.[3-9]|4\.\d{2}|[5-9])/i.test(id);
  return false;
}

/** @param {string} modelId @returns {ModelInfo} */
function info(modelId) {
  const known = CATALOG.find((m) => m.id === modelId);
  if (known) return known;
  const provider = providerOf(modelId);
  if (provider === 'buddy') {
    // Gleiche Fähigkeiten wie das OpenAI-Modell; Preis 0 hier, weil Buddy Cloud in Buddy Credits
    // auf dem Server abrechnet (die lokale USD-Schätzung und das Monatslimit zählen es nicht).
    const raw = String(modelId).slice(CLOUD_PREFIX.length);
    const base = CATALOG.find((m) => m.id === raw) || info(raw);
    return { ...base, id: modelId, provider: 'buddy', price: ZERO_PRICE, priceEstimated: false, cloud: true };
  }
  if (provider === 'local') {
    const raw = String(modelId).slice(LOCAL_PREFIX.length);
    const c = localCaps(raw) || { tools: false, vision: false };
    const short = localName(raw) || raw;
    return {
      id: modelId, provider, tier: 'sonnet', name: `${short} (lokal)`, short, price: ZERO_PRICE,
      efforts: [], caps: { vision: Boolean(c.vision), tools: Boolean(c.tools), computerUse: false, structured: true }, local: true,
    };
  }
  if (provider === 'huggingface') {
    const name = String(modelId).slice(HF_PREFIX.length);
    const short = name.split(/[\\/]/).filter(Boolean).pop() || 'Lokales Modell';
    return {
      id: modelId, provider, tier: 'sonnet', name: `${short} (lokal)`, short, price: ZERO_PRICE,
      efforts: [], caps: { vision: false, tools: false, computerUse: false, structured: false }, local: true,
    };
  }
  const tier = tierOf(modelId);
  const pretty = String(modelId || 'Modell')
    .replace(/^claude-/, '')
    .replace(/^models\//, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
  const isClaude = provider === 'anthropic';
  const reasoning = isReasoningModel(provider, String(modelId || ''));
  return {
    id: modelId,
    provider,
    tier: tier === 'fable' ? 'opus' : tier,
    name: isClaude ? `Claude ${pretty}` : pretty,
    short: pretty,
    price: TIER_FALLBACK_PRICE[tier] || TIER_FALLBACK_PRICE.sonnet,
    priceEstimated: true,
    // Gemini ab Version 3 steuert das Denken über thinkingLevel (der Adapter übersetzt low/medium/high),
    // Denkmodelle von OpenAI und xAI über reasoning_effort
    efforts: isClaude || (provider === 'gemini' && /gemini-([3-9]|\d{2})/i.test(String(modelId))) || reasoning ? ['low', 'medium', 'high'] : [],
    ...(reasoning ? { effortParam: /** @type {'reasoning_effort'} */ ('reasoning_effort') } : {}),
    caps: { vision: true, tools: true, computerUse: isClaude, structured: true },
    estimated: true,
  };
}

// ---------- Metadaten aus der Modellliste des Anbieters ----------
// Manche Anbieter sagen pro Modell, was es kann (Gemini: «thinking», Tokenlimits).
// Buddy merkt sich das beim Laden der Liste und richtet die Fähigkeiten danach.
/** @type {Map<string, import('./llm/types').ModelMeta>} */
const META = new Map();
const bare = (/** @type {string} */ id) => String(id || '').replace(/^models\//, '');

/** @param {ProviderId} providerId @param {string} modelId @param {import('./llm/types').ModelMeta} meta */
function rememberMeta(providerId, modelId, meta) {
  if (!modelId || !meta) return;
  META.set(`${providerId}|${bare(modelId)}`, { ...META.get(`${providerId}|${bare(modelId)}`), ...meta });
}

/** @param {string} modelId @returns {import('./llm/types').ModelMeta|undefined} */
function metaOf(modelId) {
  return META.get(`${providerOf(modelId)}|${bare(modelId)}`);
}

/**
 * Was ein Modell kann (nicht der Anbieter!). Grundlage ist der Katalog bzw. die Schätzung aus
 * dem Namen, ergänzt um die Angaben aus der Modellliste. Fehlt eine Fähigkeit, ist das Modell
 * nicht «kaputt», es kann diese Sache einfach nicht (z. B. lokale Modelle ohne Werkzeuge).
 * @param {string} modelId
 * @returns {import('./llm/types').FullCapabilities}
 */
function capabilities(modelId) {
  const i = info(modelId);
  const base = i.caps;
  const meta = metaOf(modelId) || {};
  const thinks = meta.thinking === true || (meta.thinking !== false && (i.efforts || []).length > 0);
  return {
    chat: true,
    streaming: base.streaming ?? true,
    history: true,
    vision: base.vision,
    tools: base.tools,
    parallelTools: base.parallelTools ?? (base.tools && i.provider !== 'huggingface'),
    computerUse: base.computerUse,
    structured: base.structured,
    json: base.json ?? base.structured,
    reasoning: base.reasoning ?? thinks,
  };
}

// Kosten einer Anfrage in USD. input_tokens zählt nur die nicht gecachten Tokens.
/** @param {string} modelId @param {Partial<import('./llm/types').Usage>} usage */
function costOf(modelId, usage = {}) {
  const m = info(modelId);
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const write = Number(usage.cache_creation_input_tokens) || 0;
  const read = Number(usage.cache_read_input_tokens) || 0;
  const prompt = input + write + read;
  const p = m.longContext && prompt > m.longContext.above ? m.longContext.price : m.price;
  return (input * p.in + output * p.out + write * p.cacheWrite + read * p.cacheRead) / 1e6;
}

// Für jede Stufe das passende verfügbare Modell eines Anbieters. `available` kommt
// aus der Modell-Liste des Keys; fehlt sie, gilt der Katalog.
/**
 * @param {Array<string|{id:string}>} [available]
 * @param {ProviderId} [providerId]
 * @returns {Partial<Record<Tier,string>>}
 */
function resolveTiers(available, providerId = 'anthropic') {
  const ids = (available || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
    .filter((id) => providerId === 'huggingface' || providerOf(id) === providerId || (providerId === 'gemini' && /gemini/i.test(id)))
    // Vom Anbieter abgelehnte Modelle (404, «nicht mehr verfügbar») überspringen
    .filter((id) => !learned.get(providerId, id, 'unavailable'));
  // Gerade überlastete Modelle nach hinten: nur nehmen, wenn es sonst nichts gibt
  const busy = (id) => (learned.get(providerId, id, 'busyUntil') || 0) > Date.now();
  if (ids.some(busy) && ids.some((id) => !busy(id))) {
    const free = ids.filter((id) => !busy(id));
    const result = resolveTiers(free, providerId);
    if (Object.keys(result).length) return result;
  }
  /** @type {Partial<Record<Tier,string>>} */
  const result = {};
  if (providerId === 'huggingface' || providerId === 'local') {
    if (ids[0]) for (const tier of TIERS) result[tier] = ids[0];
    return result;
  }
  // Buddy Cloud bietet die OpenAI-Modelle an (mit Präfix «cloud:»)
  const own = providerId === 'buddy'
    ? CATALOG.filter((m) => m.provider === 'openai').map((m) => ({ ...m, id: CLOUD_PREFIX + m.id }))
    : CATALOG.filter((m) => m.provider === providerId);
  for (const tier of TIERS) {
    const preferred = own.find((m) => m.tier === tier);
    // Abgelehntes Katalogmodell: Nachfolger nehmen, den der Anbieter in der Fehlermeldung nannte
    const replacement = preferred && learned.get(providerId, preferred.id, 'unavailable') ? learned.get(providerId, preferred.id, 'replacement') : null;
    if (!ids.length) {
      if (replacement) result[tier] = replacement;
      else if (preferred && !learned.get(providerId, preferred.id, 'unavailable')) result[tier] = preferred.id;
      continue;
    }
    if (providerId === 'gemini') {
      const pick = pickGemini(ids, tier);
      if (pick) result[tier] = pick;
      continue;
    }
    if (preferred && ids.includes(preferred.id)) {
      result[tier] = preferred.id;
      continue;
    }
    // Neuestes Modell dieser Stufe nehmen (die Listen sind meist neu → alt sortiert)
    const usable = ids.filter((id) => !/(embedding|tts|whisper|dall-e|image|audio|realtime|moderation|transcribe|search|veo|imagen)/i.test(id));
    const candidates = usable.filter((id) => tierOf(id) === tier);
    // Für die schnelle Stufe Varianten ohne Denken bevorzugen (z. B. «…-fast-non-reasoning»)
    const ordered = tier === 'haiku' ? [...candidates.filter((id) => /non-reasoning/i.test(id)), ...candidates.filter((id) => !/non-reasoning/i.test(id))] : candidates;
    const other = ordered.find((id) => !/\d{8}$/.test(id)) || ordered[0];
    if (other) result[tier] = other;
  }
  // Fehlende Stufen bleiben leer: der Router nimmt dann die nächste vorhandene,
  // und eine Eskalation auf «dasselbe» Modell wird so vermieden.
  return result;
}

// Gemini: offizielles «-latest»-Alias oder die höchste Versionsnummer der passenden Familie
// (Flash-Lite, Flash, Pro). Stabile Versionen vor Vorschauen, Spezialvarianten (Bild, Ton, Live …) nie.
/** @param {string[]} ids @param {Tier} tier */
function pickGemini(ids, tier) {
  const fam = tier === 'haiku' ? 'flash-lite' : tier === 'sonnet' ? 'flash' : 'pro';
  const clean = ids.map((id) => String(id).replace(/^models\//, ''));
  const alias = `gemini-${fam}-latest`;
  if (clean.includes(alias)) return alias;
  const special = /(image|tts|audio|live|embedding|robotics|computer-use|native|learnlm|aqa|gemma|customtools)/i;
  const re = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${fam}(?:-(.*))?$`, 'i');
  const found = [];
  for (const id of clean) {
    if (special.test(id)) continue;
    const m = id.match(re);
    if (!m) continue;
    const rest = m[2] || '';
    if (fam === 'flash' && /^lite/i.test(rest)) continue;
    found.push({ id, v: parseFloat(m[1]), preview: /preview|exp/i.test(rest) ? 1 : 0, extra: rest ? 1 : 0 });
  }
  found.sort((a, b) => b.v - a.v || a.preview - b.preview || a.extra - b.extra || a.id.length - b.id.length);
  return found[0]?.id;
}

/** @param {Tier} tier @returns {Tier|null} */
function nextTier(tier) {
  const i = TIERS.indexOf(tier);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

/** @param {string} tier */
function tierRank(tier) {
  const i = TIERS.indexOf(/** @type {Tier} */ (tier));
  return i < 0 ? 1 : i;
}

/** @param {Tier} a @param {Tier} b @returns {Tier} */
function maxTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** @param {Tier} a @param {Tier} b @returns {Tier} */
function minTier(a, b) {
  return tierRank(a) <= tierRank(b) ? a : b;
}

// Nur Aufwand-Stufen schicken, die das Modell kennt.
/** @param {string} modelId @param {string|null|undefined} effort */
function supportedEffort(modelId, effort) {
  if (!effort || effort === 'auto') return null;
  const list = info(modelId).efforts || [];
  if (list.includes(effort)) return effort;
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  const wanted = order.indexOf(effort);
  for (let i = wanted; i >= 0; i -= 1) if (list.includes(order[i])) return order[i];
  return null;
}

// Wie viele Tokens eine Antwort höchstens haben darf (Denken zählt mit).
/** @param {string|null|undefined} effort @param {number} [minimum] */
function maxTokensFor(effort, minimum = 4096) {
  /** @type {Record<string, number>} */
  const byEffort = { low: 4096, medium: 8192, high: 16000, xhigh: 24000, max: 32000 };
  return Math.max(Number(minimum) || 0, byEffort[effort || ''] || 8192);
}

module.exports = {
  CATALOG,
  DEPRECATED,
  OLD_DEFAULTS,
  TIERS,
  TIER_LABEL,
  PROVIDERS,
  HF_PREFIX,
  LOCAL_PREFIX,
  CLOUD_PREFIX,
  setLocalResolver,
  providerOf,
  tierOf,
  info,
  capabilities,
  rememberMeta,
  metaOf,
  costOf,
  resolveTiers,
  nextTier,
  tierRank,
  maxTier,
  minTier,
  supportedEffort,
  maxTokensFor,
};
