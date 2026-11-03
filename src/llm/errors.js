// @ts-check
// Gemeinsamer Fehlertyp aller Anbieter mit verständlichen Meldungen.
const { t } = require('../i18n');

class ProviderError extends Error {
  /**
   * @param {number} status HTTP-Status (0 = keine Verbindung)
   * @param {string} [raw] Fehlermeldung des Anbieters
   * @param {string} [type] Fehlertyp des Anbieters
   * @param {string} [providerName] z. B. «Claude», «OpenAI»
   */
  constructor(status, raw, type, providerName = 'Claude') {
    super(friendlyMessage(status, raw, type, providerName));
    this.status = status;
    this.raw = raw || '';
    this.type = type || '';
    this.provider = providerName;
    /** @type {number|undefined} */
    this.retryAfterMs = undefined;
  }
}

/**
 * @param {number} status
 * @param {string} [raw]
 * @param {string} [type]
 * @param {string} [name]
 */
function friendlyMessage(status, raw = '', type = '', name = 'Claude') {
  const text = `${raw} ${type}`.toLowerCase();
  if (text.includes('workspace')) return t('Dein Key braucht eine Workspace-ID. Trag sie in den Einstellungen ein oder erstelle einen Key für einen bestimmten Workspace.');
  if (text.includes('credit balance') || text.includes('insufficient_quota') || text.includes('quota')) return t('Dein API-Guthaben bei {name} ist aufgebraucht.', { name });
  if (status === 401 || type === 'authentication_error' || text.includes('api key not valid') || text.includes('invalid_api_key')) return t('Der API-Key ist ungültig. Prüfe ihn in den Einstellungen.');
  if (status === 403 || type === 'permission_error') return t('Dieser Key hat keinen Zugriff darauf (z. B. auf dieses Modell).');
  if (status === 404 || type === 'not_found_error' || text.includes('model_not_found')) return t('Das Modell wurde nicht gefunden. Wähle in den Einstellungen ein anderes.');
  if (status === 413) return t('Die Unterhaltung ist zu lang. Starte einen neuen Chat.');
  if (status === 429 || type === 'rate_limit_error') return t('Zu viele Anfragen. Warte kurz und versuch es nochmals.');
  if (status === 529 || type === 'overloaded_error') return t('{name} ist gerade überlastet. Versuch es gleich nochmals.', { name });
  if (status >= 500) return t('Bei {name} ist ein Fehler aufgetreten. Versuch es nochmals.', { name });
  if (type === 'timeout_error') return t('{name} antwortet gerade nicht (Zeitüberschreitung). Versuch es gleich nochmals.', { name });
  if (type === 'local_error') return raw;
  if (status === 0 && !raw) return t('Keine Verbindung zu {name}. Bist du online?', { name });
  return raw || t('Unbekannter Fehler ({status})', { status });
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/** @param {unknown} err */
function isRetryable(err) {
  return err instanceof ProviderError && (err.status === 0 || RETRY_STATUS.has(err.status) || err.type === 'overloaded_error' || err.type === 'api_error');
}

function abortError() {
  return Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
}

/** @param {number} ms @param {AbortSignal} [signal] */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

module.exports = { ProviderError, friendlyMessage, isRetryable, abortError, wait, RETRY_STATUS };
