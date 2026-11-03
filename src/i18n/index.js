// @ts-check
// Übersetzungen für Buddy Island. Quelltexte sind Deutsch (Schweizer Schreibweise),
// die Wörterbücher übersetzen den deutschen Text in die Systemsprache. Fehlt eine
// Übersetzung, bleibt der deutsche Text stehen (nie ein leerer Text).
// Platzhalter: {name}, {n} … werden in jeder Sprache ersetzt.

/** @typedef {'de'|'en'|'fr'} Lang */

/** @type {Record<Lang, {name: string, dict: Record<string,string>}>} */
const LANGS = {
  de: { name: 'Deutsch', dict: {} },
  en: { name: 'English', dict: require('./en') },
  fr: { name: 'Français', dict: require('./fr') },
};

/** @type {Lang} */
let current = 'de';

/**
 * Wählt aus den bevorzugten Sprachen des Systems die erste unterstützte.
 * @param {string[]} preferred z. B. ['de-CH', 'en-US']
 * @returns {Lang}
 */
function detect(preferred) {
  for (const tag of preferred || []) {
    const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
    if (base in LANGS) return /** @type {Lang} */ (base);
  }
  // Unbekannte Sprache: Englisch als internationale Ausweichsprache
  return preferred && preferred.length ? 'en' : 'de';
}

/** @param {string} lang */
function setLanguage(lang) {
  current = /** @type {Lang} */ (lang in LANGS ? lang : 'de');
  return current;
}

function language() {
  return current;
}

/**
 * Übersetzt einen deutschen Quelltext.
 * @param {string} text
 * @param {Record<string, string|number>} [vars]
 */
function t(text, vars) {
  const dict = LANGS[current].dict;
  let out = (current !== 'de' && dict[text]) || text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

/** Wörterbuch für das Fenster (der Renderer übersetzt damit selbst) */
function dictionary() {
  return { lang: current, name: LANGS[current].name, dict: current === 'de' ? {} : LANGS[current].dict, locale: localeOf(current) };
}

/** @param {Lang} lang */
function localeOf(lang = current) {
  return { de: 'de-CH', en: 'en-GB', fr: 'fr-CH' }[lang] || 'de-CH';
}

function languages() {
  return Object.entries(LANGS).map(([id, l]) => ({ id, name: l.name }));
}

module.exports = { t, detect, setLanguage, language, dictionary, languages, localeOf, LANGS };
