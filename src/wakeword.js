// Eigenes Wakeword («Hey Buddy», «Jarvis», «Hallo Kiwi» …)
// Erkannt wird es von der Windows-Spracherkennung mit einer festen Wortliste (siehe src/voice.js).
// Hier wird die Eingabe geprüft und daraus die Liste der Varianten gebaut.

const DEFAULT_WAKE_WORD = 'Hey Buddy';
const MAX_LEN = 32;
const MAX_WORDS = 4;
const GREETINGS = ['hey', 'hallo', 'hi', 'he', 'okay', 'ok'];

// Nur Buchstaben (alle Sprachen), Leerzeichen, Apostroph und Bindestrich
const ALLOWED = /^[\p{L}][\p{L}' -]*$/u;

/**
 * Prüft ein Wakeword und bringt es in eine saubere Form.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function cleanWakeWord(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Bitte ein Wakeword eingeben.' };
  const value = input.normalize('NFC').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: 'Bitte ein Wakeword eingeben.' };
  if (value.length > MAX_LEN) return { ok: false, error: `Höchstens ${MAX_LEN} Zeichen.` };
  if (!ALLOWED.test(value)) return { ok: false, error: 'Nur Buchstaben, Leerzeichen und Bindestrich.' };
  if (value.split(' ').length > MAX_WORDS) return { ok: false, error: `Höchstens ${MAX_WORDS} Wörter.` };
  const letters = value.replace(/[^\p{L}]/gu, '');
  if (letters.length < 4) return { ok: false, error: 'Mindestens 4 Buchstaben, sonst reagiert Buddy zu oft.' };
  return { ok: true, value };
}

// Gespeicherten Wert lesen; Ungültiges fällt auf «Hey Buddy» zurück
function wakeWordOf(settings) {
  const res = cleanWakeWord(settings?.wakeWord ?? DEFAULT_WAKE_WORD);
  return res.ok ? res.value : DEFAULT_WAKE_WORD;
}

/**
 * Varianten, auf die Buddy hört (klein geschrieben, ohne Duplikate).
 * Ein einzelnes Wort bekommt zusätzlich die üblichen Begrüssungen davor,
 * damit «Hey Jarvis» genauso klappt wie «Jarvis».
 */
function wakePhrases(word) {
  const w = (cleanWakeWord(word).ok ? cleanWakeWord(word).value : DEFAULT_WAKE_WORD).toLowerCase();
  const parts = w.split(' ');
  const out = [w];
  if (parts.length === 1) {
    for (const g of GREETINGS) out.push(`${g} ${w}`);
  } else if (GREETINGS.includes(parts[0])) {
    const rest = parts.slice(1).join(' ');
    for (const g of GREETINGS) out.push(`${g} ${rest}`);
  }
  return [...new Set(out)];
}

// Ein einzelnes Wort ohne Begrüssung fällt im normalen Gespräch leichter: strengere Schwelle
function minConfidence(word) {
  const w = cleanWakeWord(word).ok ? cleanWakeWord(word).value : DEFAULT_WAKE_WORD;
  return w.includes(' ') ? 0.6 : 0.75;
}

// Für den PowerShell-Helfer: Liste als Base64-JSON (nur A–Z, a–z, 0–9, +, /, =), damit
// nichts aus der Eingabe als Befehl gelesen werden kann
function encodePhrases(phrases) {
  return Buffer.from(JSON.stringify(phrases), 'utf8').toString('base64');
}

module.exports = { DEFAULT_WAKE_WORD, cleanWakeWord, wakeWordOf, wakePhrases, minConfidence, encodePhrases };
