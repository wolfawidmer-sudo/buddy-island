'use strict';
// Strukturiertes Logging als JSON-Zeilen. Entfernt alles, was nach Geheimnis aussieht.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /(authorization|password|secret|token|apikey|api_key|code|verifier|cookie|signature|refresh|access|id_token|nonce|key)$/i;
const SECRET_VALUES = [
  /\bsk-[A-Za-z0-9_-]{10,}/g, // OpenAI
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{10,}/g,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g, // Google Client-Secret
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b4\/0[A-Za-z0-9_-]{20,}/g, // Google Autorisierungscode
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

/** @param {unknown} value @param {number} depth @returns {unknown} */
function redact(value, depth = 0) {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') {
    let s = value;
    for (const re of SECRET_VALUES) s = s.replace(re, '[redacted]');
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1), code: /** @type {any} */ (value).code };
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) && k !== 'requestId' ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

function createLogger({ level = 'info', write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  /** @param {keyof typeof LEVELS} lvl @param {string} msg @param {Record<string, unknown>} [fields] */
  const log = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: redact(msg), ...(/** @type {object} */ (redact(fields))) }));
  };
  return {
    debug: (msg, f) => log('debug', msg, f),
    info: (msg, f) => log('info', msg, f),
    warn: (msg, f) => log('warn', msg, f),
    error: (msg, f) => log('error', msg, f),
  };
}

module.exports = { createLogger, redact };
