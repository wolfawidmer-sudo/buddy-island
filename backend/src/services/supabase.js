'use strict';
// Zugriff auf Supabase über die offiziellen REST-Schnittstellen (GoTrue /auth/v1, PostgREST /rest/v1).
// Der geheime Schlüssel wird nur für Datenbankaufrufe aus dem Backend benutzt.

const { AppError, fromDatabase, unavailable } = require('../lib/errors');

/**
 * JSON lesen, ohne Dezimalzahlen in Fliesskommazahlen zu verwandeln: Postgres-numeric
 * (Credits, CHF, USD) bleibt als exakter String, ganze Zahlen werden zu Number.
 * @param {string} text
 */
function parseExact(text) {
  return JSON.parse(text, function reviver(_key, value, context) {
    if (typeof value !== 'number') return value;
    const src = context?.source;
    if (typeof src !== 'string') return value;
    return /^-?\d+$/.test(src) && Number.isSafeInteger(value) ? value : src;
  });
}

/** @param {{ url: string, publishableKey: string, secretKey: string, fetchImpl?: typeof fetch, logger: any }} opts */
function createSupabase({ url, publishableKey, secretKey, fetchImpl = globalThis.fetch, logger }) {
  const isJwt = (k) => /^eyJ/.test(k);
  // Neue Schlüssel (sb_secret_/sb_publishable_) gehen nur in «apikey»; alte JWT-Schlüssel zusätzlich als Bearer.
  const serviceHeaders = () => ({ apikey: secretKey, ...(isJwt(secretKey) ? { authorization: `Bearer ${secretKey}` } : {}) });

  async function call(path, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
    if (!url) throw unavailable('Supabase ist nicht eingerichtet', 'not_configured');
    let r;
    try {
      r = await fetchImpl(`${url}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      logger.warn('supabase_unreachable', { path: path.split('?')[0], error: err });
      throw unavailable('Supabase ist gerade nicht erreichbar');
    }
    const text = await r.text();
    let data = null;
    try { data = text ? parseExact(text) : null; } catch { data = { message: text.slice(0, 200) }; }
    return { status: r.status, ok: r.ok, data };
  }

  /** RPC einer Datenbankfunktion (nur service_role) */
  async function rpc(name, args) {
    const r = await call(`/rest/v1/rpc/${name}`, { method: 'POST', headers: serviceHeaders(), body: args });
    if (!r.ok) {
      const e = fromDatabase(r.data, r.status);
      if (e.status >= 500) logger.error('supabase_rpc_failed', { fn: name, status: r.status, dbMessage: r.data?.message });
      throw e;
    }
    return r.data;
  }

  /** Tabelle lesen (service_role); Filter immer serverseitig mit der geprüften Nutzer-ID */
  async function select(table, query) {
    const r = await call(`/rest/v1/${table}?${query}`, { headers: serviceHeaders() });
    if (!r.ok) throw fromDatabase(r.data, r.status);
    return r.data;
  }

  async function update(table, query, patch) {
    const r = await call(`/rest/v1/${table}?${query}`, { method: 'PATCH', headers: { ...serviceHeaders(), prefer: 'return=representation' }, body: patch });
    if (!r.ok) throw fromDatabase(r.data, r.status);
    return r.data;
  }

  /** GoTrue-Aufruf mit dem öffentlichen Schlüssel (wie ein Client) */
  async function auth(path, { method = 'POST', body, accessToken } = {}) {
    const headers = { apikey: publishableKey, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) };
    return call(`/auth/v1${path}`, { method, headers, body });
  }

  /** Admin-Aufruf von GoTrue (geheimer Schlüssel) */
  async function authAdmin(path, { method = 'GET', body } = {}) {
    return call(`/auth/v1${path}`, { method, headers: serviceHeaders(), body });
  }

  return { rpc, select, update, auth, authAdmin, AppError };
}

module.exports = { createSupabase, parseExact };
