// @ts-check
// Anmeldung pro Anbieter an einem Ort: wie ein Key aussehen darf, wo man ihn bekommt,
// wie er geprüft wird und was ein Fehler beim Prüfen bedeutet.
//
// Grundsatz: Buddy lehnt einen Key nicht wegen seines Präfixes ab. Anbieter ändern ihre
// Formate (Google: «AIza…» → «AQ.…», Anthropic: «sk-ant-api…»), darum entscheidet die
// Prüfung beim Anbieter selbst (kostenlose Modellliste), nicht ein Muster in Buddy.
// Abgelehnt wird vorher nur, was sicher kein Key dieses Anbieters ist: leer, mit
// Leerzeichen, viel zu kurz oder lang, oder eindeutig der Key eines anderen Anbieters.

const { t } = require('../i18n');

/**
 * @typedef {{
 *   id: string,
 *   method: 'api_key',
 *   label: string,
 *   placeholder: string,
 *   where: string,
 *   url: string,
 *   help: string,
 *   notIncluded?: string,
 *   looksLike?: RegExp,
 *   legacy?: { test: RegExp, retired: string },
 * }} AuthSpec
 */

// Eindeutige Erkennungsmerkmale fremder Keys (nur zur Warnung «falscher Anbieter»)
/** @type {{ provider: string, name: string, test: RegExp }[]} */
const FOREIGN = [
  { provider: 'anthropic', name: 'Claude (Anthropic)', test: /^sk-ant-/ },
  { provider: 'gemini', name: 'Google Gemini', test: /^(AIza|AQ\.)/ },
  { provider: 'xai', name: 'xAI Grok', test: /^xai-/ },
  { provider: 'huggingface', name: 'Hugging Face', test: /^hf_/ },
  { provider: 'openai', name: 'OpenAI', test: /^sk-(proj|svcacct|admin)-/ },
];

/** @type {Record<string, AuthSpec>} */
const SPECS = {
  anthropic: {
    id: 'anthropic', method: 'api_key', label: 'API-Key',
    placeholder: 'Claude-API-Key einfügen',
    where: 'Claude Console → Settings → API keys',
    url: 'https://platform.claude.com/settings/keys',
    help: 'Erstelle in der Claude Console einen API-Key und füge ihn hier ein. Abgerechnet wird nach Verbrauch über dein Console-Guthaben.',
    notIncluded: 'Ein Claude-Abo (Pro, Max) enthält keinen API-Zugang.',
    looksLike: /^sk-ant-/,
  },
  openai: {
    id: 'openai', method: 'api_key', label: 'API-Key',
    placeholder: 'OpenAI-API-Key einfügen',
    where: 'OpenAI Platform → API keys',
    url: 'https://platform.openai.com/api-keys',
    help: 'Erstelle auf der OpenAI Platform einen API-Key (Projekt-Key genügt) und füge ihn hier ein. Abgerechnet wird nach Verbrauch.',
    notIncluded: 'Ein ChatGPT-Abo (Plus, Pro) enthält keinen API-Zugang.',
    looksLike: /^sk-/,
  },
  xai: {
    id: 'xai', method: 'api_key', label: 'API-Key',
    placeholder: 'xAI-API-Key einfügen',
    where: 'xAI Console → API Keys',
    url: 'https://console.x.ai',
    help: 'Erstelle in der xAI Console einen API-Key und füge ihn hier ein. Abgerechnet wird nach Verbrauch.',
    notIncluded: 'Ein Grok- oder X-Abo enthält keinen API-Zugang.',
    looksLike: /^xai-/,
  },
  gemini: {
    id: 'gemini', method: 'api_key', label: 'API-Key',
    placeholder: 'Gemini-API-Key aus Google AI Studio einfügen',
    where: 'Google AI Studio → API Keys',
    url: 'https://aistudio.google.com/apikey',
    help: 'Buddy nutzt die Gemini API (Google AI Studio). Erstelle dort einen API-Key und füge ihn hier ein. Zugänge über Vertex AI (Google Cloud mit Dienstkonto oder Anmeldung) unterstützt Buddy nicht.',
    notIncluded: 'Ein Google-One- oder Gemini-Abo enthält keinen API-Zugang.',
    looksLike: /^(AQ\.|AIza)/,
    // Google lehnt Standard-Keys (meist «AIza…») seit September 2026 ab; neue Keys aus
    // AI Studio sind «Auth Keys» (meist «AQ.…»). Quelle: ai.google.dev/gemini-api/docs/api-key
    legacy: { test: /^AIza/, retired: 'Google nimmt ältere Gemini-Keys (Standard-Keys, meist «AIza…») seit September 2026 nicht mehr an. Erstelle in Google AI Studio einen neuen Key und füge ihn hier ein.' },
  },
  anthropicAdmin: {
    id: 'anthropicAdmin', method: 'api_key', label: 'Admin-Zugang',
    placeholder: 'Admin-Key oder persönlichen Key einfügen',
    where: 'Claude Console → Settings → API keys',
    url: 'https://platform.claude.com/settings/keys',
    help: 'Für die Nutzung der ganzen Organisation braucht Buddy einen Key mit Admin-Rechten, der nicht auf einen Workspace beschränkt ist (Admin-Key, persönlicher Key oder Dienstkonto-Key).',
    looksLike: /^sk-ant-/,
  },
  openaiAdmin: {
    id: 'openaiAdmin', method: 'api_key', label: 'Admin-Key',
    placeholder: 'OpenAI-Admin-Key einfügen',
    where: 'OpenAI Platform → Organization → Admin keys',
    url: 'https://platform.openai.com/settings/organization/admin-keys',
    help: 'Für Nutzung und Kosten der ganzen Organisation braucht Buddy einen Admin-Key von OpenAI.',
    looksLike: /^sk-/,
  },
};

/** Für welchen Anbieter ist die Spezifikation? (Admin-Keys gehören zum Haupt-Anbieter) @param {string} id */
const ownerOf = (id) => (id === 'anthropicAdmin' ? 'anthropic' : id === 'openaiAdmin' ? 'openai' : id);

/**
 * Prüft nur, was sicher falsch ist. Kein Präfix-Zwang.
 * @param {string} providerId @param {string} raw
 * @returns {{ ok: true, key: string, notice?: string } | { ok: false, error: string, code: string }}
 */
function checkFormat(providerId, raw) {
  const spec = SPECS[providerId];
  const key = String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');
  if (!key) return { ok: false, code: 'empty', error: t('Bitte einen Key einfügen.') };
  if (/\s/.test(key)) return { ok: false, code: 'whitespace', error: t('Der Key enthält Leerzeichen oder Zeilenumbrüche. Kopiere ihn nochmals aus der Console.') };
  if (key.length < 20) return { ok: false, code: 'short', error: t('Der Key ist zu kurz. Kopiere ihn vollständig.') };
  if (key.length > 512) return { ok: false, code: 'long', error: t('Der Key ist zu lang. Kopiere nur den Key selbst.') };
  const owner = ownerOf(providerId);
  const foreign = FOREIGN.find((f) => f.provider !== owner && f.test.test(key));
  // «sk-…» allein ist zu allgemein; nur eindeutige Merkmale zählen
  if (foreign) return { ok: false, code: 'wrong_provider', error: t('Das sieht nach einem Key von {name} aus. Wähle oben den passenden Anbieter oder füge den richtigen Key ein.', { name: foreign.name }) };
  /** @type {{ ok: true, key: string, notice?: string }} */
  const out = { ok: true, key };
  if (spec?.legacy?.test.test(key)) out.notice = t(spec.legacy.retired);
  return out;
}

/**
 * Macht aus einem Fehler bei der Prüfung oder Nutzung eine klare Meldung (ohne Key).
 * Unterscheidet ungültigen Key, fehlende Rechte, Netz, Rate-Limit und Guthaben.
 * @param {string} providerId @param {string} key @param {any} err
 * @returns {{ code: 'invalid_key'|'retired_key'|'permission'|'network'|'rate_limit'|'quota'|'unknown', message: string, reauth: boolean }}
 */
function explain(providerId, key, err) {
  const spec = SPECS[providerId];
  const cat = err?.category;
  const legacy = spec?.legacy && spec.legacy.test.test(String(key || '')) ? spec.legacy : null;
  if ((cat === 'auth' || cat === 'permission' || (cat === 'request' && /api key/i.test(String(err?.raw || '')))) && legacy) {
    return { code: 'retired_key', message: t(legacy.retired), reauth: true };
  }
  if (cat === 'auth') return { code: 'invalid_key', message: err.message, reauth: true };
  if (cat === 'permission') return { code: 'permission', message: err.message, reauth: false };
  if (cat === 'network' || cat === 'timeout') return { code: 'network', message: err.message, reauth: false };
  if (cat === 'rate_limit' || cat === 'overloaded') return { code: 'rate_limit', message: err.message, reauth: false };
  if (cat === 'quota') return { code: 'quota', message: err.message, reauth: false };
  return { code: 'unknown', message: err?.message || t('Unbekannter Fehler.'), reauth: false };
}

/** Öffentliche Angaben für die Oberfläche (ohne Muster) @param {string} providerId */
function publicSpec(providerId) {
  const s = SPECS[providerId];
  if (!s) return null;
  return { method: s.method, label: t(s.label), placeholder: t(s.placeholder), where: s.where, url: s.url, help: t(s.help), notIncluded: s.notIncluded ? t(s.notIncluded) : '' };
}

// Muster zum Schwärzen in Protokollen und Fehlermeldungen (alle bekannten Formate, alt und neu)
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, /sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, /xai-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g, /AQ\.[A-Za-z0-9_.-]{20,}/g, /hf_[A-Za-z0-9]{16,}/g,
];

module.exports = { SPECS, FOREIGN, checkFormat, explain, publicSpec, ownerOf, SECRET_PATTERNS };
