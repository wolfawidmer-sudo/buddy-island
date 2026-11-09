// @ts-check
// Google-Anmeldung für die Desktop-App (OAuth 2.0 für installierte Apps, RFC 8252):
// System-Browser + Loopback-Rückkehr auf 127.0.0.1 + PKCE (S256) + state + nonce.
//
// Sicherheit:
// - state: 32 Zufallsbytes, Vergleich in konstanter Zeit; falscher state wird ignoriert.
// - PKCE: Verifier bleibt im Hauptprozess, nur der S256-Hash geht an Google.
// - nonce: 32 Zufallsbytes; an Google geht der SHA-256-Hash, an Supabase der Rohwert.
//   So gehört das ID-Token genau zu diesem Anmeldeversuch.
// - Der Loopback-Server lauscht nur auf 127.0.0.1, nur auf /callback, nimmt genau EINEN
//   gültigen Rückruf an und schliesst sofort danach (kein Replay). Zeitlimit 5 Minuten.
// - Das Client-Secret ist NICHT in der App. Den Code tauscht das Backend.
// - Codes und Tokens werden nie geloggt.

const http = require('node:http');
const crypto = require('node:crypto');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (/** @type {Buffer} */ b) => b.toString('base64url');

function createPkce() {
  const verifier = b64url(crypto.randomBytes(48)); // 64 Zeichen, erlaubt 43–128
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const PAGE = (/** @type {string} */ title, /** @type {string} */ text) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Buddy Island</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px/1.5 "Segoe UI",system-ui,sans-serif;background:#0b0b0c;color:#f2f2f7;display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{color:#a1a1aa;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

/**
 * Startet die Anmeldung und wartet auf den Rückruf.
 * @param {{ clientId: string, openExternal: (url: string) => Promise<void>|void, timeoutMs?: number, signal?: AbortSignal, texts?: { ok: [string,string], fail: [string,string] } }} opts
 * @returns {Promise<{ code: string, codeVerifier: string, redirectUri: string, nonce: string }>}
 */
function authorize({ clientId, openExternal, timeoutMs = TIMEOUT_MS, signal, texts }) {
  if (!clientId || !/\.apps\.googleusercontent\.com$/.test(clientId)) return Promise.reject(new Error('google_not_configured'));
  const state = b64url(crypto.randomBytes(32));
  const nonce = b64url(crypto.randomBytes(32));
  const hashedNonce = crypto.createHash('sha256').update(nonce).digest('hex');
  const pkce = createPkce();
  const ok = texts?.ok || ['Angemeldet', 'Du kannst dieses Fenster schliessen und zu Buddy zurückkehren.'];
  const fail = texts?.fail || ['Anmeldung abgebrochen', 'Du kannst dieses Fenster schliessen. Versuch es in Buddy nochmals.'];

  return new Promise((resolve, reject) => {
    let done = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      if (req.method !== 'GET' || url.pathname !== '/callback' || done || claimed) {
        res.writeHead(404);
        res.end();
        return;
      }
      const gotState = url.searchParams.get('state') || '';
      // Fremder Aufruf (falscher state): ignorieren und weiter auf den echten warten
      if (!safeEqual(gotState, state)) {
        res.writeHead(400);
        res.end(PAGE(fail[0], fail[1]));
        return;
      }
      const code = url.searchParams.get('code') || '';
      const error = url.searchParams.get('error') || '';
      // Ab hier zählt nur dieser eine Rückruf; abschliessen, sobald die Seite gesendet ist
      claimed = true;
      const failed = Boolean(error || !code);
      res.setHeader('connection', 'close');
      res.writeHead(failed ? 400 : 200);
      res.end(failed ? PAGE(fail[0], fail[1]) : PAGE(ok[0], ok[1]), () => {
        finish(failed ? new Error(error === 'access_denied' ? 'google_cancelled' : 'google_failed') : null, code);
      });
    });
    let claimed = false;

    /** @param {Error|null} err @param {string} [code] */
    function finish(err, code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.close();
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolve({ code: /** @type {string} */ (code), codeVerifier: pkce.verifier, redirectUri: redirect, nonce });
    }
    const onAbort = () => finish(new Error('google_cancelled'));
    let redirect = '';

    server.on('error', (e) => finish(e));
    server.listen(0, '127.0.0.1', async () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      redirect = `http://127.0.0.1:${addr.port}/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce: hashedNonce,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      timer = setTimeout(() => finish(new Error('google_timeout')), timeoutMs);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort);
      try {
        await openExternal(`${AUTH_ENDPOINT}?${params}`);
      } catch {
        finish(new Error('browser_failed'));
      }
    });
  });
}

module.exports = { authorize, createPkce, safeEqual, AUTH_ENDPOINT };
