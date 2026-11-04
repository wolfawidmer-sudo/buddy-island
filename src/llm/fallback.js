// @ts-check
// Ausweichmodell bei vorübergehenden Störungen (Überlastung, Rate-Limit, Serverfehler).
//
// Regeln:
// - Nur bei vorübergehenden Fehlern. Nie bei ungültigem Key, fehlender Berechtigung,
//   aufgebrauchtem Guthaben, falschem Format oder Fehlern in Buddy.
// - Kandidaten kommen aus der Modellliste, die der Anbieter für diesen Key liefert
//   (dynamisch), nie aus einer festen Liste. Ohne Liste gibt es kein Ausweichen.
// - Zuerst eine andere Stufe (eine überlastete Familie ist meist als Ganzes überlastet),
//   die leichtere vor der schwereren: Flash → Flash-Lite → Pro.
// - Das gewählte Modell wird nie überschrieben: Ausweichen gilt nur für die laufende Aufgabe.
//   Eine kurze «Abkühlzeit» (learned «busyUntil», auch von llm/index.js bei jeder Überlastung
//   gesetzt) sorgt dafür, dass ein manuell gewähltes Modell beim nächsten Mal ohne lange
//   Wiederholungen versucht wird (es wird trotzdem immer zuerst gefragt) und die automatische
//   Modellwahl es ein paar Minuten meidet (models.resolveTiers).

const models = require('../models');
const learned = require('./learned');
const { isTransient } = require('./errors');

/** @typedef {import('./types').ProviderId} ProviderId */
/** @typedef {import('./types').Tier} Tier */

const COOLDOWN_MS = 3 * 60 * 1000;
/** Höchstens so viele Ausweichmodelle pro Anfrage, danach ehrliche Fehlermeldung */
const MAX_FALLBACKS = 2;

/** Modell hatte gerade eine vorübergehende Störung @param {string} providerId @param {string} model @param {number} [ms] */
function markBusy(providerId, model, ms = COOLDOWN_MS, now = Date.now()) {
  if (model) learned.set(providerId, model, 'busyUntil', now + ms);
}

/** @param {string} providerId @param {string} model */
function isBusy(providerId, model, now = Date.now()) {
  return (learned.get(providerId, model, 'busyUntil') || 0) > now;
}

/** Nur für Tests */
function reset() {
  learned.clear();
}

/**
 * Darf bei diesem Fehler auf ein anderes Modell ausgewichen werden?
 * @param {any} err
 */
function canFallback(err) {
  return isTransient(err);
}

/**
 * Geordnete Ausweichmodelle für ein vorübergehend gestörtes Modell.
 * @param {{
 *   providerId: ProviderId,
 *   failed: string,
 *   available: Array<string|{id: string}>,
 *   tier?: Tier|null,
 *   needTools?: boolean,
 *   needVision?: boolean,
 *   needComputer?: boolean,
 *   preferred?: string[],
 *   exclude?: string[],
 *   maxTier?: Tier|null,
 * }} opts
 * @returns {string[]}
 */
function candidates({ providerId, failed, available, tier, needTools = false, needVision = false, needComputer = false, preferred = [], exclude = [], maxTier = null }) {
  const ids = (available || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean).map((id) => String(id).replace(/^models\//, ''));
  if (!ids.length) return [];
  const failedId = String(failed || '').replace(/^models\//, '');
  const skip = new Set([failedId, ...exclude.map((x) => String(x).replace(/^models\//, ''))]);
  const ok = (/** @type {string} */ id) => {
    if (!id || skip.has(id) || !ids.includes(id)) return false;
    if (models.providerOf(id) !== providerId && !(providerId === 'gemini' && /gemini/i.test(id))) return false;
    if (learned.get(providerId, id, 'unavailable')) return false;
    const caps = models.capabilities(id);
    if (needTools && !caps.tools) return false;
    if (needVision && !caps.vision) return false;
    if (needComputer && !caps.computerUse) return false;
    if (maxTier && models.tierRank(models.info(id).tier) > models.tierRank(maxTier)) return false;
    return true;
  };
  /** @type {string[]} */
  const out = [];
  const add = (/** @type {string|undefined} */ id) => { if (id && ok(id) && !out.includes(id)) out.push(id); };

  // 1. Vom Nutzer in den Einstellungen festgelegte Ausweichmodelle (falls vorhanden und verfügbar)
  for (const id of preferred || []) add(String(id).replace(/^models\//, ''));

  // 2. Andere Stufen aus der echten Modellliste, nächstgelegene zuerst, bei Gleichstand die leichtere
  const failedTier = tier || models.info(failedId).tier;
  const rest = ids.filter((id) => id !== failedId);
  const tiers = models.resolveTiers(rest.map((id) => ({ id })), providerId);
  const rank = models.tierRank(failedTier);
  const order = [...models.TIERS]
    .filter((t) => t !== failedTier)
    .sort((a, b) => Math.abs(models.tierRank(a) - rank) - Math.abs(models.tierRank(b) - rank) || models.tierRank(a) - models.tierRank(b));
  for (const t of order) add(tiers[t]);

  // Modelle in der Abkühlzeit ans Ende (sie sind gerade selbst gestört)
  return [...out.filter((id) => !isBusy(providerId, id)), ...out.filter((id) => isBusy(providerId, id))].slice(0, MAX_FALLBACKS);
}

/**
 * Wie viele Wiederholungen das gewählte Modell bekommt: steht ein Ausweichmodell bereit,
 * wartet Buddy nicht lange auf ein überlastetes Modell (einmal, nach einer Störung gar nicht).
 * Ohne Ausweichmodell gilt der Standard des Adapters.
 * @param {{ providerId: string, model: string, hasFallback: boolean }} opts
 * @returns {number|undefined}
 */
function retriesFor({ providerId, model, hasFallback }) {
  if (!hasFallback) return undefined;
  return isBusy(providerId, model) ? 0 : 1;
}

module.exports = { candidates, canFallback, markBusy, isBusy, retriesFor, reset, COOLDOWN_MS, MAX_FALLBACKS };
