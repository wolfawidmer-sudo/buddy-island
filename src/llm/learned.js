// @ts-check
// Was ein Modell nicht kennt, merkt sich Buddy bis zum Neustart (z. B. «minimal» als Denkstufe).
// So kostet eine abgelehnte Einstellung nur einmal eine Extra-Runde, nicht bei jeder Nachricht.

/** @type {Map<string, any>} */
const memo = new Map();

/** @param {string} provider @param {string} model @param {string} what */
const key = (provider, model, what) => `${provider}|${String(model || '').replace(/^models\//, '')}|${what}`;

module.exports = {
  /** @param {string} provider @param {string} model @param {string} what */
  get: (provider, model, what) => memo.get(key(provider, model, what)),
  /** @param {string} provider @param {string} model @param {string} what @param {any} value */
  set: (provider, model, what, value) => { memo.set(key(provider, model, what), value); },
  /** Nur für Tests */
  clear: () => memo.clear(),
};
