// @ts-check
// Gemeinsamer Fehlertyp aller Anbieter: klassifiziert jeden Fehler (Kategorie, Stufe,
// Herkunft, Wiederholbarkeit), nennt immer den richtigen Anbieter und das Modell und
// liefert eine sichere Diagnose ohne Keys oder Inhalte.
const { t } = require('../i18n');

/**
 * @typedef {'auth'|'permission'|'model'|'endpoint'|'request'|'capability'|'rate_limit'|'quota'|'network'|'timeout'|'server'|'overloaded'|'parse'|'continuation'|'local'|'unknown'} ErrorCategory
 * @typedef {'key'|'models'|'connect'|'request'|'stream'|'parse'|'adapter'|'local'} ErrorStage
 * @typedef {{ providerId?: string, model?: string, endpoint?: string, apiVersion?: string, stage?: ErrorStage, code?: string }} ErrorContext
 */

class ProviderError extends Error {
  /**
   * @param {number} status HTTP-Status (0 = keine Antwort vom Anbieter)
   * @param {string} [raw] Fehlermeldung des Anbieters
   * @param {string} [type] Fehlertyp/-code des Anbieters
   * @param {string} [providerName] z. B. «Claude», «OpenAI», «Gemini»
   * @param {ErrorContext} [ctx]
   */
  constructor(status, raw, type, providerName = 'Claude', ctx = {}) {
    const category = classify(status, raw, type);
    super(friendlyMessage(status, raw, type, providerName, category));
    this.status = status;
    this.raw = raw || '';
    this.type = type || '';
    this.provider = providerName;
    this.category = category;
    this.providerId = ctx.providerId || '';
    this.model = ctx.model || '';
    this.endpoint = ctx.endpoint || '';
    this.apiVersion = ctx.apiVersion || '';
    this.code = ctx.code || type || '';
    /** @type {ErrorStage} */
    this.stage = ctx.stage || (category === 'local' ? 'local' : status ? 'request' : 'connect');
    /** @type {number|undefined} */
    this.retryAfterMs = undefined;
    /** Wie oft Buddy diese Anfrage schon automatisch wiederholt hat */
    this.retries = 0;
  }

  /** Vorübergehend (Überlastung, Rate-Limit, Serverfehler, Netz): später oder mit anderem Modell kann es klappen */
  get transient() {
    return isTransient(this);
  }

  /** Lokal entstanden (Buddy, Netzwerk) oder vom Anbieter gemeldet */
  get origin() {
    if (this.category === 'local' || this.stage === 'adapter' || this.stage === 'parse') return 'local';
    if (this.status === 0) return 'network';
    return 'provider';
  }

  get retryable() {
    return isRetryable(this);
  }
}

/**
 * Ordnet einen Fehler einer Kategorie zu. Reihenfolge ist wichtig (Spezielles zuerst).
 * @param {number} status @param {string} [raw] @param {string} [type]
 * @returns {ErrorCategory}
 */
function classify(status, raw = '', type = '') {
  const text = `${raw} ${type}`.toLowerCase();
  if (type === 'local_error') return 'local';
  if (type === 'parse_error') return 'parse';
  if (type === 'timeout_error') return 'timeout';
  if (type === 'stream_incomplete') return 'network';
  // Gemini meldet auch Minuten- und Tageslimits pro Modell mit «exceeded your current quota».
  // Der Adapter erkennt sie an der quotaId; ein anderes Modell oder etwas Warten hilft dort.
  if (type === 'rate_limit_minute' || type === 'rate_limit_day') return 'rate_limit';
  // Status 0 ohne Angaben = keine Antwort; mit Angaben = Fehler mitten im Stream
  if (status === 0 && !raw && !type) return 'network';
  if (/must be verified to stream|stream(ing)? is not supported|does not support stream/.test(text)) return 'capability';
  if (/thought_signature|thought signature|tool_call_id|tool_use_id|tool_use. ids|function call .* missing|functionresponse|function response|tool_calls. must be followed|tool result/.test(text)) return 'continuation';
  if (/credit balance|insufficient_quota|billing|exceeded your current quota|quota exceeded|payment required/.test(text) || status === 402) return 'quota';
  if (status === 401 || /authentication_error|api key not valid|api_key_invalid|invalid_api_key|incorrect api key|unauthenticated|invalid x-api-key|no api key/.test(text)) return 'auth';
  if (status === 403 || /permission_error|permission_denied|forbidden/.test(text)) return 'permission';
  if (/model_not_found|model .*(not found|does not exist|not supported for generatecontent|is not supported)|models\/\S+ is not found|unknown model|no such model|invalid model/.test(text)) return 'model';
  if (status === 404) return /model/.test(text) ? 'model' : 'endpoint';
  if (status === 413 || /context length|context_length|too many tokens|prompt is too long|maximum context/.test(text)) return 'request';
  if (status === 429 || /rate_limit|rate limit|resource_exhausted|too many requests/.test(text)) return 'rate_limit';
  if (status === 529 || /overloaded/.test(text)) return 'overloaded';
  if (status === 503 || /unavailable/.test(text)) return 'overloaded';
  if (status >= 500) return 'server';
  if (/does not support (tools|function|images|vision|image input)|tools? (are|is) not supported|function calling is not enabled|image input is not supported/.test(text)) return 'capability';
  if (status === 400 || status === 422 || /invalid_request|invalid_argument|invalid json payload|unknown name|bad request/.test(text)) return 'request';
  return status === 0 ? 'server' : 'unknown';
}

/**
 * @param {number} status @param {string} [raw] @param {string} [type] @param {string} [name]
 * @param {ErrorCategory} [category]
 */
function friendlyMessage(status, raw = '', type = '', name = 'Claude', category = classify(status, raw, type)) {
  const text = `${raw} ${type}`.toLowerCase();
  if (text.includes('workspace') && category !== 'model') return t('Dein Key braucht eine Workspace-ID. Trag sie in den Einstellungen ein oder erstelle einen Key für einen bestimmten Workspace.');
  switch (category) {
    case 'quota': return t('Dein API-Guthaben bei {name} ist aufgebraucht.', { name });
    case 'auth': return t('{name} hat den API-Key abgelehnt. Prüfe ihn in den Einstellungen.', { name });
    case 'permission': return t('Dein {name}-Key hat keinen Zugriff darauf (z. B. auf dieses Modell oder in deiner Region).', { name });
    case 'model': return t('{name} kennt dieses Modell nicht oder bietet es dir nicht an. Wähle in den Einstellungen ein anderes.', { name });
    case 'endpoint': return t('Buddy hat bei {name} eine falsche Adresse angefragt. Das ist ein Fehler in Buddy, bitte melden.', { name });
    case 'request':
      if (status === 413 || /context|too long|too many tokens/.test(text)) return t('Die Unterhaltung ist zu lang. Starte einen neuen Chat.');
      return t('{name} hat die Anfrage abgelehnt (ungültiges Format).', { name });
    case 'capability': return t('Dieses Modell von {name} kann das nicht (z. B. Streaming, Werkzeuge oder Bilder).', { name });
    case 'continuation': return t('{name} hat die Fortsetzung nach einem Werkzeug-Aufruf abgelehnt.', { name });
    case 'rate_limit':
      if (type === 'rate_limit_day') return t('Das Tageslimit deines {name}-Kontos für dieses Modell ist erreicht. Ein anderes Modell geht eventuell noch.', { name });
      return t('Zu viele Anfragen an {name}. Warte kurz und versuch es nochmals.', { name });
    case 'overloaded': return t('{name} ist gerade überlastet (das liegt beim Anbieter, nicht an deinem Key). Versuch es gleich nochmals oder wähle ein anderes Modell.', { name });
    case 'server': return t('Bei {name} ist ein Fehler aufgetreten. Versuch es nochmals.', { name });
    case 'timeout': return t('{name} antwortet gerade nicht (Zeitüberschreitung). Versuch es gleich nochmals.', { name });
    case 'network':
      if (type === 'stream_incomplete') return t('Die Verbindung zu {name} ist mitten in der Antwort abgebrochen. Versuch es nochmals.', { name });
      return t('Keine Verbindung zu {name}. Bist du online?', { name });
    case 'parse': return t('Buddy konnte die Antwort von {name} nicht lesen.', { name });
    case 'local': return raw || t('Lokaler Fehler.');
    default: return t('Unbekannter Fehler bei {name} ({status}).', { name, status });
  }
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/** @param {unknown} err */
function isRetryable(err) {
  if (!(err instanceof ProviderError)) return false;
  if (['auth', 'permission', 'model', 'endpoint', 'request', 'capability', 'quota', 'continuation', 'local', 'parse'].includes(err.category)) return false;
  return err.status === 0 || RETRY_STATUS.has(err.status) || err.type === 'overloaded_error' || err.type === 'api_error' || err.category === 'timeout' || err.category === 'network';
}

// Fehler, die nicht am Key, am Modell oder an Buddy liegen, sondern vorübergehend beim Anbieter
// oder im Netz. Nur bei diesen lohnt sich Warten oder ein Ausweichmodell. Aufgebrauchtes
// Guthaben (quota) gehört nicht dazu: ein anderes Modell desselben Kontos hilft da nicht.
const TRANSIENT = new Set(['rate_limit', 'overloaded', 'server', 'timeout', 'network']);

/** @param {unknown} err */
function isTransient(err) {
  return err instanceof ProviderError && TRANSIENT.has(err.category);
}

/**
 * Wartezeit vor Wiederholung `attempt` (0 = erste Wiederholung): exponentiell mit Jitter,
 * damit viele Buddys nach einer Störung nicht im Gleichtakt wieder anfragen.
 * Nennt der Anbieter eine Wartezeit (Retry-After), gilt mindestens diese.
 * @param {number} attempt
 * @param {{ baseMs?: number, maxMs?: number, retryAfterMs?: number, random?: () => number }} [opts]
 */
function backoffDelay(attempt, { baseMs = 1000, maxMs = 12000, retryAfterMs, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  // «Equal jitter»: halbe Zeit fest, halbe Zeit zufällig
  const jittered = exp / 2 + random() * (exp / 2);
  if (retryAfterMs && retryAfterMs > 0) return Math.min(Math.max(retryAfterMs, jittered), Math.max(maxMs, retryAfterMs));
  return Math.round(jittered);
}

/**
 * Wie ein Fehler im Verbindungstest erscheint:
 * unavailable = vorübergehend beim Anbieter, config = Key/Konto/Modellwahl,
 * unsupported = das Modell kann das nicht, error = Fehler in Buddy oder im Protokoll.
 * @param {any} err
 * @returns {'unavailable'|'config'|'unsupported'|'error'}
 */
function testStatusOf(err) {
  const category = err instanceof ProviderError ? err.category : err?.category;
  if (TRANSIENT.has(category)) return 'unavailable';
  if (['auth', 'permission', 'quota', 'model'].includes(category)) return 'config';
  if (category === 'capability') return 'unsupported';
  return 'error';
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

// ---------- Sichere Diagnose ----------

// Alles, was wie ein Schlüssel aussieht, wird ersetzt (auch in Fehlermeldungen der Anbieter)
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, /sk-(proj-|admin-)?[A-Za-z0-9_-]{16,}/g, /xai-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g, /hf_[A-Za-z0-9]{16,}/g, /(key|token|api_key|apikey)=([^&\s"']+)/gi, /Bearer\s+[A-Za-z0-9._-]{12,}/g,
];

/** @param {string} text */
function redact(text) {
  let out = String(text || '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, a) => (a && /=/.test(m) ? `${a}=…` : '[entfernt]'));
  return out;
}

/** Adresse ohne Query (dort könnte ein Key stehen) @param {string} url */
function safeEndpoint(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return redact(String(url || '').split('?')[0]);
  }
}

const STAGE_LABEL = {
  key: 'API-Key', models: 'Modellliste', connect: 'Verbindung', request: 'Anfrage', stream: 'Antwort-Stream',
  parse: 'Antwort lesen', adapter: 'Buddy-Adapter', local: 'Lokal',
};

/**
 * Für Oberfläche und IPC: nur ungefährliche Felder.
 * @param {any} err
 */
function publicError(err) {
  const e = err instanceof ProviderError ? err : null;
  return {
    message: String(err?.message || err || ''),
    provider: e?.provider || '',
    providerId: e?.providerId || '',
    model: e?.model || '',
    status: e?.status || 0,
    code: e ? redact(e.code).slice(0, 80) : '',
    category: e?.category || 'unknown',
    stage: e?.stage || '',
    origin: e?.origin || 'local',
    retryable: Boolean(e?.retryable),
    transient: Boolean(e?.transient),
    retries: e?.retries || 0,
    apiVersion: e?.apiVersion || '',
    endpoint: e ? safeEndpoint(e.endpoint) : '',
    detail: e ? errorDetail(e) : '',
    providerMessage: e ? redact(e.raw).slice(0, 300) : '',
  };
}

/** Kurze Zeile unter der Fehlermeldung, z. B. «Gemini · gemini-2.5-flash · HTTP 400 · Anfrage» @param {ProviderError} e */
function errorDetail(e) {
  return [e.provider, e.model, e.status ? `HTTP ${e.status}` : e.origin === 'network' ? t('keine Antwort') : '', t(STAGE_LABEL[e.stage] || e.stage), e.code && e.code !== String(e.status) ? redact(e.code).slice(0, 40) : '']
    .filter(Boolean).join(' · ');
}

/** Eine Logzeile ohne Keys und ohne Inhalte @param {any} err */
function diagnosticLine(err) {
  const p = publicError(err);
  return `KI-Fehler provider=${p.providerId || p.provider} model=${p.model} endpoint=${p.endpoint} status=${p.status} code=${p.code} category=${p.category} stage=${p.stage} origin=${p.origin} retry=${p.retryable} retries=${p.retries} msg="${p.providerMessage || redact(p.message).slice(0, 200)}"`;
}

module.exports = {
  ProviderError, friendlyMessage, classify, isRetryable, isTransient, backoffDelay, testStatusOf, TRANSIENT, abortError, wait, RETRY_STATUS,
  publicError, diagnosticLine, errorDetail, redact, safeEndpoint,
};
