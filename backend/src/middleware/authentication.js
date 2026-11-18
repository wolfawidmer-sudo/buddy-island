'use strict';
// Prüft Supabase-Access-Tokens bei jeder geschützten Anfrage.
// Neue Supabase-Projekte signieren mit asymmetrischen Schlüsseln (ES256/RS256); die
// öffentlichen Schlüssel kommen von {SUPABASE_URL}/auth/v1/.well-known/jwks.json.
// Alte Projekte mit HS256 brauchen SUPABASE_JWT_SECRET. Die Nutzer-ID stammt immer aus
// dem geprüften Token (sub), nie aus der Anfrage.

const crypto = require('node:crypto');
const { unauthorized } = require('../lib/errors');

const b64url = (s) => Buffer.from(s, 'base64url');

/** @param {{ supabaseUrl: string, jwtSecret?: string, fetchImpl?: typeof fetch, now?: () => number, cacheMs?: number }} opts */
function createTokenVerifier({ supabaseUrl, jwtSecret = '', fetchImpl = globalThis.fetch, now = Date.now, cacheMs = 10 * 60 * 1000 }) {
  const issuer = `${supabaseUrl}/auth/v1`;
  /** @type {{ keys: Map<string, crypto.KeyObject & { alg?: string }>, at: number } | null} */
  let jwks = null;
  /** @type {Promise<void>|null} */
  let loading = null;

  async function loadKeys(force = false) {
    if (!force && jwks && now() - jwks.at < cacheMs) return;
    if (loading) return loading;
    loading = (async () => {
      const r = await fetchImpl(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`jwks ${r.status}`);
      const data = await r.json();
      const keys = new Map();
      for (const jwk of data.keys || []) {
        if (!jwk.kid) continue;
        try {
          const k = crypto.createPublicKey({ key: jwk, format: 'jwk' });
          /** @type {any} */ (k).alg = jwk.alg;
          keys.set(jwk.kid, k);
        } catch { /* unbekannter Schlüsseltyp */ }
      }
      jwks = { keys, at: now() };
    })().finally(() => { loading = null; });
    return loading;
  }

  /** @param {string} token */
  async function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw unauthorized('Ungültige Anmeldung', 'invalid_token');
    let header;
    let payload;
    try {
      header = JSON.parse(b64url(parts[0]).toString('utf8'));
      payload = JSON.parse(b64url(parts[1]).toString('utf8'));
    } catch {
      throw unauthorized('Ungültige Anmeldung', 'invalid_token');
    }
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = b64url(parts[2]);
    let ok = false;
    if (header.alg === 'HS256') {
      if (!jwtSecret) throw unauthorized('Ungültige Anmeldung', 'invalid_token');
      const expected = crypto.createHmac('sha256', jwtSecret).update(data).digest();
      ok = expected.length === sig.length && crypto.timingSafeEqual(expected, sig);
    } else if (header.alg === 'ES256' || header.alg === 'RS256') {
      try {
        await loadKeys();
        if (!jwks?.keys.has(header.kid)) await loadKeys(true); // Schlüsselwechsel
      } catch {
        throw unauthorized('Anmeldung kann gerade nicht geprüft werden', 'auth_unavailable');
      }
      const key = jwks?.keys.get(header.kid);
      if (!key) throw unauthorized('Ungültige Anmeldung', 'invalid_token');
      if (/** @type {any} */ (key).alg && /** @type {any} */ (key).alg !== header.alg) throw unauthorized('Ungültige Anmeldung', 'invalid_token');
      ok = header.alg === 'ES256'
        ? crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
        : crypto.verify('sha256', data, key, sig);
    } else {
      throw unauthorized('Ungültige Anmeldung', 'invalid_token'); // alg "none" & Co.
    }
    if (!ok) throw unauthorized('Ungültige Anmeldung', 'invalid_token');

    const t = Math.floor(now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= t - 5) throw unauthorized('Anmeldung abgelaufen', 'token_expired');
    if (typeof payload.nbf === 'number' && payload.nbf > t + 30) throw unauthorized('Ungültige Anmeldung', 'invalid_token');
    if (payload.iss !== issuer) throw unauthorized('Ungültige Anmeldung', 'invalid_token');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes('authenticated') || payload.role !== 'authenticated') throw unauthorized('Ungültige Anmeldung', 'invalid_token');
    if (typeof payload.sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.sub)) throw unauthorized('Ungültige Anmeldung', 'invalid_token');
    return { id: payload.sub, email: payload.email, role: payload.role, sessionId: payload.session_id, exp: payload.exp };
  }

  return { verify };
}

/** Middleware: setzt req.user oder wirft 401 */
function requireAuth(verifier) {
  return async (req) => {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(h);
    if (!m) throw unauthorized();
    const user = await verifier.verify(m[1]);
    req.user = { ...user, token: m[1] };
  };
}

module.exports = { createTokenVerifier, requireAuth };
