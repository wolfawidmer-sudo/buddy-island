// Anbieter, Modelle, Preise und Fähigkeiten an einem Ort.
// Neue Modelle oder Anbieter kommen hier dazu, Router und Agent lesen nur diese Daten.

// Preise in US-Dollar pro 1 Million Tokens (Stand November 2026, Claude API).
// cacheWrite = 5-Minuten-Cache schreiben, cacheRead = aus dem Cache lesen.
const CATALOG = [
  {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    tier: 'haiku',
    name: 'Claude Haiku 5.5',
    short: 'Haiku 5.5',
    price: { in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    // Haiku 5.5 kostet mehr, wenn der Prompt über 100'000 Tokens lang ist
    longContext: { above: 100000, price: { in: 0.50, out: 2.50, cacheWrite: 0.625, cacheRead: 0.05 } },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    computerUse: true,
    structured: true,
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    tier: 'sonnet',
    name: 'Claude Sonnet 5.5',
    short: 'Sonnet 5.5',
    price: { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    computerUse: true,
    structured: true,
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    tier: 'opus',
    name: 'Claude Opus 5.5',
    short: 'Opus 5.5',
    price: { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    computerUse: true,
    structured: true,
  },
];

// Reihenfolge von günstig/einfach nach teuer/stark
const TIERS = ['haiku', 'sonnet', 'opus'];

const TIER_LABEL = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

// Ungefähre Preise für Modelle, die (noch) nicht im Katalog stehen
const TIER_FALLBACK_PRICE = {
  haiku: { in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
  sonnet: { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  opus: { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
  fable: { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};

// Anbieter-Registry. Weitere Anbieter brauchen: Key-Prüfung, Client, Modell-Liste.
const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    keyPrefix: 'sk-ant-',
    keyHint: 'Ein Claude-API-Key beginnt mit «sk-ant-».',
    consoleUrl: 'https://platform.claude.com/settings/keys',
    host: 'api.anthropic.com',
  },
};

function tierOf(modelId) {
  const id = String(modelId || '').toLowerCase();
  const known = CATALOG.find((m) => m.id === id);
  if (known) return known.tier;
  for (const tier of [...TIERS, 'fable']) if (id.includes(tier)) return tier;
  return 'sonnet';
}

function info(modelId) {
  const known = CATALOG.find((m) => m.id === modelId);
  if (known) return known;
  const tier = tierOf(modelId);
  const pretty = String(modelId || 'Modell')
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
  return {
    id: modelId,
    provider: 'anthropic',
    tier,
    name: `Claude ${pretty}`,
    short: pretty,
    price: TIER_FALLBACK_PRICE[tier] || TIER_FALLBACK_PRICE.sonnet,
    efforts: ['low', 'medium', 'high'],
    computerUse: true,
    structured: true,
    estimated: true,
  };
}

// Kosten einer Anfrage in USD aus dem usage-Objekt der API.
// input_tokens zählt nur die nicht gecachten Tokens.
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

// Für jede Stufe das passende verfügbare Modell. `available` kommt aus der
// Modell-Liste des Keys; fehlt sie, gilt der Katalog.
function resolveTiers(available) {
  const ids = (available || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  const result = {};
  for (const tier of TIERS) {
    const preferred = CATALOG.find((m) => m.tier === tier);
    if (!ids.length) {
      result[tier] = preferred.id;
      continue;
    }
    if (ids.includes(preferred.id)) {
      result[tier] = preferred.id;
      continue;
    }
    // Neuestes Modell dieser Stufe nehmen (die Liste der API ist neu → alt sortiert)
    const other = ids.find((id) => tierOf(id) === tier && !/\d{8}$/.test(id)) || ids.find((id) => tierOf(id) === tier);
    if (other) result[tier] = other;
  }
  return result;
}

function nextTier(tier) {
  const i = TIERS.indexOf(tier);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  return i < 0 ? 1 : i;
}

function maxTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}

function minTier(a, b) {
  return tierRank(a) <= tierRank(b) ? a : b;
}

// Nur Aufwand-Stufen schicken, die das Modell kennt.
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
function maxTokensFor(effort, minimum = 4096) {
  const byEffort = { low: 4096, medium: 8192, high: 16000, xhigh: 24000, max: 32000 };
  return Math.max(Number(minimum) || 0, byEffort[effort] || 8192);
}

module.exports = {
  CATALOG,
  TIERS,
  TIER_LABEL,
  PROVIDERS,
  tierOf,
  info,
  costOf,
  resolveTiers,
  nextTier,
  tierRank,
  maxTier,
  minTier,
  supportedEffort,
  maxTokensFor,
};
