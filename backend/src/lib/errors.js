'use strict';
// Einheitliche Fehler. Antwortformat wie bei OpenAI, damit der bestehende Adapter der App
// (src/llm/openai-responses.js) sie ohne Änderung versteht: { error: { message, code, type } }.

class AppError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (message, extra) => new AppError(400, 'invalid_request', message, extra);
const unauthorized = (message = 'Anmeldung erforderlich', code = 'unauthorized') => new AppError(401, code, message);
const forbidden = (message = 'Nicht erlaubt') => new AppError(403, 'forbidden', message);
const notFound = (message = 'Nicht gefunden') => new AppError(404, 'not_found', message);
const unavailable = (message, code = 'service_unavailable') => new AppError(503, code, message);

// Fehlercodes der Datenbankfunktionen → HTTP
const DB_CODES = {
  insufficient_credits: [402, 'Nicht genug Buddy Credits.'],
  billing_not_configured: [503, 'Die Abrechnung ist noch nicht eingerichtet.'],
  unknown_model_pricing: [400, 'Dieses Modell ist in Buddy Cloud nicht verfügbar.'],
  reservation_not_found: [404, 'Reservierung nicht gefunden.'],
  request_id_conflict: [409, 'Anfrage-ID schon vergeben.'],
  purchase_not_found: [404, 'Kauf nicht gefunden.'],
  package_not_found: [404, 'Dieses Paket gibt es nicht.'],
  amount_mismatch: [400, 'Betrag stimmt nicht.'],
  invalid_amount: [400, 'Ungültiger Betrag.'],
  invalid_status: [400, 'Ungültiger Status.'],
  immutable_record: [409, 'Buchungen können nicht geändert werden.'],
};

/** Datenbankfehler (PostgREST) in AppError übersetzen. @param {any} body */
function fromDatabase(body, status) {
  const message = String(body?.message || '');
  const code = Object.keys(DB_CODES).find((k) => message === k || message.startsWith(`${k}`));
  if (code) {
    const [s, text] = DB_CODES[code];
    return new AppError(s, code, text);
  }
  return new AppError(502, 'database_error', 'Datenbankfehler', { upstreamStatus: status });
}

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, unavailable, fromDatabase };
