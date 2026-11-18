'use strict';
// Anmeldung über Supabase Auth (GoTrue): E-Mail/Passwort, Code-Bestätigung, Passwort-Reset,
// Sitzung erneuern, Abmelden und Google (Desktop-Client, PKCE, Code-Tausch hier im Backend).
//
// Google-Ablauf (Variante C, siehe docs/cloud/AUTH.md):
// 1. App erzeugt state, PKCE-Verifier und nonce, öffnet den System-Browser mit
//    redirect_uri http://127.0.0.1:<Port>/callback (Loopback, für Desktop-Clients vorgesehen).
// 2. App prüft state, schickt code + code_verifier + redirect_uri + nonce hierher.
// 3. Backend tauscht den Code bei Google (mit Client-Secret, das nie in der App liegt).
// 4. Backend gibt das ID-Token an Supabase (grant_type=id_token). Supabase prüft Signatur,
//    Audience (Client-ID in «Client IDs» eingetragen) und nonce und stellt die Sitzung aus.

const crypto = require('node:crypto');
const { AppError, badRequest, unauthorized, unavailable } = require('../lib/errors');

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{2,5})\/callback$/;

/** GoTrue-Fehler → verständliche Fehler (ohne interne Details) */
function authError(r) {
  const d = r.data || {};
  const code = String(d.error_code || d.code || d.error || '');
  const msg = String(d.msg || d.message || d.error_description || '');
  if (r.status === 429 || /rate_limit/.test(code)) return new AppError(429, 'rate_limited', 'Zu viele Versuche. Bitte später nochmals.', { retryAfter: 60 });
  if (/invalid_credentials|invalid_grant/.test(code) || /invalid login/i.test(msg)) return new AppError(401, 'invalid_credentials', 'E-Mail oder Passwort stimmt nicht.');
  if (/email_not_confirmed/.test(code)) return new AppError(403, 'email_not_confirmed', 'Bitte bestätige zuerst deine E-Mail-Adresse.');
  if (/weak_password/.test(code)) return new AppError(400, 'weak_password', 'Das Passwort ist zu schwach.');
  if (/user_already_exists|email_exists/.test(code)) return new AppError(409, 'user_already_exists', 'Für diese E-Mail gibt es schon ein Konto.');
  if (/otp_expired|invalid_otp|token.*expired/i.test(code) || /expired|invalid/i.test(msg) && r.status === 403) return new AppError(400, 'invalid_code', 'Der Code ist ungültig oder abgelaufen.');
  if (/refresh_token_not_found|refresh_token_already_used|session_not_found|session_expired/.test(code)) return new AppError(401, 'session_expired', 'Die Sitzung ist abgelaufen. Bitte neu anmelden.');
  if (/provider_disabled|validation_failed/.test(code) && /provider/i.test(msg)) return new AppError(503, 'provider_disabled', 'Google-Anmeldung ist in Supabase noch nicht eingeschaltet.');
  if (/bad_jwt|nonce/i.test(code + msg)) return new AppError(401, 'google_token_rejected', 'Google-Anmeldung wurde abgelehnt. Bitte nochmals versuchen.');
  if (r.status >= 500) return unavailable('Anmeldung ist gerade nicht erreichbar');
  return new AppError(400, 'auth_failed', 'Anmeldung fehlgeschlagen.');
}

/** Nur das, was die App braucht */
function toSession(data) {
  if (!data?.access_token || !data?.refresh_token) return null;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Number(data.expires_at) || Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
    user: { id: data.user?.id, email: data.user?.email, provider: data.user?.app_metadata?.provider || null },
  };
}

/**
 * @param {{ supabase: any, google: { clientId: string, clientSecret: string }, fetchImpl?: typeof fetch, logger: any, now?: () => number }} opts
 */
function createAuthService({ supabase, google, fetchImpl = globalThis.fetch, logger, now = Date.now }) {
  /** Schon benutzte Google-Codes (Hash) – zusätzlicher Schutz gegen Wiederholung */
  const usedCodes = new Map();
  const seen = (code) => {
    const t = now();
    for (const [k, at] of usedCodes) if (t - at > 15 * 60 * 1000) usedCodes.delete(k);
    const h = crypto.createHash('sha256').update(code).digest('hex');
    if (usedCodes.has(h)) return true;
    usedCodes.set(h, t);
    return false;
  };

  async function signup({ email, password, displayName }) {
    const r = await supabase.auth('/signup', { body: { email, password, data: displayName ? { full_name: displayName } : {} } });
    if (!r.ok) throw authError(r);
    const session = toSession(r.data);
    // Mit E-Mail-Bestätigung gibt es noch keine Sitzung, nur den Hinweis «Code prüfen»
    return session ? { session, confirmationRequired: false } : { session: null, confirmationRequired: true };
  }

  async function login({ email, password }) {
    const r = await supabase.auth('/token?grant_type=password', { body: { email, password } });
    if (!r.ok) throw authError(r);
    return toSession(r.data);
  }

  async function refresh({ refreshToken }) {
    const r = await supabase.auth('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
    if (!r.ok) throw r.status === 400 || r.status === 401 ? new AppError(401, 'session_expired', 'Die Sitzung ist abgelaufen. Bitte neu anmelden.') : authError(r);
    return toSession(r.data);
  }

  async function logout({ accessToken }) {
    const r = await supabase.auth('/logout?scope=local', { accessToken });
    if (!r.ok && r.status !== 401 && r.status !== 404) throw authError(r);
  }

  /** E-Mail-Code bestätigen (Registrierung) → Sitzung */
  async function verifyEmail({ email, code }) {
    const r = await supabase.auth('/verify', { body: { type: 'email', email, token: code } });
    if (!r.ok) throw authError(r);
    return toSession(r.data);
  }

  async function resendConfirmation({ email }) {
    const r = await supabase.auth('/resend', { body: { type: 'signup', email } });
    if (!r.ok && r.status !== 400) throw authError(r); // 400 = schon bestätigt: nichts verraten
  }

  async function requestPasswordReset({ email }) {
    const r = await supabase.auth('/recover', { body: { email } });
    // Immer gleich antworten, damit niemand prüfen kann, ob eine Adresse ein Konto hat
    if (!r.ok && r.status >= 500) throw authError(r);
  }

  /** Code aus der Reset-Mail + neues Passwort → neue Sitzung */
  async function resetPassword({ email, code, password }) {
    const v = await supabase.auth('/verify', { body: { type: 'recovery', email, token: code } });
    if (!v.ok) throw authError(v);
    const session = toSession(v.data);
    if (!session) throw new AppError(400, 'invalid_code', 'Der Code ist ungültig oder abgelaufen.');
    const u = await supabase.auth('/user', { method: 'PUT', accessToken: session.accessToken, body: { password } });
    if (!u.ok) throw authError(u);
    return session;
  }

  function googleConfig() {
    if (!google.clientId) throw unavailable('Google-Anmeldung ist nicht eingerichtet', 'not_configured');
    return {
      clientId: google.clientId,
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      scopes: ['openid', 'email', 'profile'],
      redirect: 'http://127.0.0.1:<port>/callback',
    };
  }

  async function google_({ code, codeVerifier, redirectUri, nonce }) {
    if (!google.clientId || !google.clientSecret) throw unavailable('Google-Anmeldung ist nicht eingerichtet', 'not_configured');
    const port = Number(LOOPBACK.exec(redirectUri)?.[1]);
    if (!port || port < 1024 || port > 65535) throw badRequest('Ungültige Rückkehr-Adresse');
    if (seen(code)) throw unauthorized('Dieser Anmelde-Code wurde schon benutzt.', 'code_replayed');

    let tr;
    try {
      tr = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: google.clientId,
          client_secret: google.clientSecret,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      logger.warn('google_unreachable', { error: err });
      throw unavailable('Google ist gerade nicht erreichbar');
    }
    const tokens = await tr.json().catch(() => ({}));
    if (!tr.ok || !tokens.id_token) {
      logger.warn('google_token_exchange_failed', { status: tr.status, googleError: tokens.error });
      throw unauthorized('Google-Anmeldung fehlgeschlagen. Bitte nochmals versuchen.', 'google_exchange_failed');
    }
    // Vorprüfung (die verbindliche Prüfung der Signatur macht Supabase):
    let claims = {};
    try { claims = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString('utf8')); } catch { /* unten abgelehnt */ }
    const expectedNonce = crypto.createHash('sha256').update(nonce).digest('hex');
    if (claims.aud !== google.clientId || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.nonce !== expectedNonce) {
      logger.warn('google_claims_mismatch', { audOk: claims.aud === google.clientId, issOk: Boolean(claims.iss), nonceOk: claims.nonce === expectedNonce });
      throw unauthorized('Google-Anmeldung wurde abgelehnt.', 'google_token_rejected');
    }
    if (claims.email && claims.email_verified === false) throw unauthorized('Die E-Mail-Adresse bei Google ist nicht bestätigt.', 'google_email_unverified');

    const r = await supabase.auth('/token?grant_type=id_token', {
      body: { provider: 'google', id_token: tokens.id_token, access_token: tokens.access_token, nonce },
    });
    if (!r.ok) {
      logger.warn('supabase_id_token_failed', { status: r.status, gotrueCode: r.data?.error_code || r.data?.code });
      throw authError(r);
    }
    return toSession(r.data);
  }

  return { signup, login, refresh, logout, verifyEmail, resendConfirmation, requestPasswordReset, resetPassword, googleConfig, google: google_ };
}

module.exports = { createAuthService, toSession, authError, LOOPBACK };
