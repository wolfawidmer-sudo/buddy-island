'use strict';
// Kleiner HTTP-Rahmen ohne Fremdpakete: Router, Body-Parser mit Grenze, CORS,
// Sicherheits-Header, Request-ID und zentrale Fehlerbehandlung.

const crypto = require('node:crypto');
const { AppError } = require('./errors');

/**
 * @typedef {import('node:http').IncomingMessage & { id: string, ip: string, path: string, query: URLSearchParams, params: Record<string,string>, rawBody?: Buffer, body?: any, user?: { id: string, email?: string, role?: string, token: string } }} Req
 * @typedef {import('node:http').ServerResponse} Res
 * @typedef {(req: Req, res: Res) => Promise<void>|void} Handler
 */

/** @param {Res} res @param {number} status @param {unknown} body @param {Record<string,string>} [headers] */
function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** @param {Req} req @param {number} limit @returns {Promise<Buffer>} */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(new AppError(413, 'payload_too_large', 'Anfrage zu gross'));
      req.resume();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError(413, 'payload_too_large', 'Anfrage zu gross'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createRouter() {
  /** @type {{ method: string, parts: string[], handlers: Handler[], raw: boolean }[]} */
  const routes = [];
  /**
   * @param {string} method @param {string} pattern
   * @param {...(Handler|{raw:boolean})} handlers
   */
  const add = (method, pattern, ...handlers) => {
    const raw = handlers.some((h) => typeof h === 'object' && h && /** @type {any} */ (h).raw);
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handlers: /** @type {Handler[]} */ (handlers.filter((h) => typeof h === 'function')), raw });
  };
  /** @param {string} method @param {string} path */
  const match = (method, path) => {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of routes) {
      if (r.parts.length !== parts.length) continue;
      /** @type {Record<string,string>} */
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        if (r.parts[i].startsWith(':')) {
          try { params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; break; }
        } else if (r.parts[i] !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return { route: null, params: {}, pathMatched };
  };
  return {
    get: (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    patch: (p, ...h) => add('PATCH', p, ...h),
    delete: (p, ...h) => add('DELETE', p, ...h),
    match,
  };
}

/**
 * @param {{ router: ReturnType<typeof createRouter>, config: any, logger: any }} opts
 */
function createHandler({ router, config, logger }) {
  /** @param {Req} req @param {Res} res */
  function cors(req, res) {
    const origin = req.headers.origin;
    // Die Desktop-App schickt keinen Origin (Node-fetch im Hauptprozess). Browser nur von erlaubten Seiten.
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
  }

  /** @param {Req} req @param {Res} res */
  return async function handle(req, res) {
    const started = Date.now();
    req.id = crypto.randomUUID();
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    req.ip = (config.trustProxy && forwarded) || req.socket.remoteAddress || '';
    const url = new URL(req.url || '/', 'http://localhost');
    req.path = url.pathname;
    req.query = url.searchParams;
    res.setHeader('x-request-id', req.id);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    if (config.production) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    cors(req, res);

    res.on('finish', () => {
      logger.info('request', { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, user: req.user?.id });
    });

    try {
      // HTTPS erzwingen hinter dem Railway-Proxy
      if (config.production && config.trustProxy && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
        throw new AppError(400, 'https_required', 'Nur über HTTPS');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const { route, params, pathMatched } = router.match(req.method || 'GET', req.path);
      if (!route) throw new AppError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found', pathMatched ? 'Methode nicht erlaubt' : 'Nicht gefunden');
      req.params = params;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method || '')) {
        const raw = await readBody(req, config.limits.bodyBytes);
        req.rawBody = raw;
        if (!route.raw && raw.length) {
          const type = String(req.headers['content-type'] || '');
          if (!/^application\/json\b/i.test(type)) throw new AppError(415, 'unsupported_media_type', 'Nur JSON');
          try { req.body = JSON.parse(raw.toString('utf8')); } catch { throw new AppError(400, 'invalid_json', 'Ungültiges JSON'); }
        } else if (!route.raw) req.body = {};
      }
      for (const h of route.handlers) {
        await h(req, res);
        if (res.headersSent || res.writableEnded) break;
      }
      if (!res.headersSent) throw new AppError(500, 'no_response', 'Keine Antwort');
    } catch (err) {
      const e = /** @type {any} */ (err);
      const status = e instanceof AppError ? e.status : 500;
      if (status >= 500) logger.error('request_failed', { requestId: req.id, path: req.path, error: e });
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const body = {
        error: {
          message: e instanceof AppError ? e.message : 'Interner Fehler',
          code: e instanceof AppError ? e.code : 'internal_error',
          type: e instanceof AppError ? e.code : 'internal_error',
          request_id: req.id,
          ...(e instanceof AppError && e.extra?.public ? /** @type {object} */ (e.extra.public) : {}),
        },
      };
      /** @type {Record<string,string>} */
      const headers = {};
      if (e instanceof AppError && e.extra?.retryAfter) headers['retry-after'] = String(e.extra.retryAfter);
      sendJson(res, status, body, headers);
    }
  };
}

module.exports = { createRouter, createHandler, sendJson, readBody };
