'use strict';
// Rate-Limit im Speicher (Token-Bucket). Reicht für eine Railway-Instanz.
// Bei mehreren Instanzen braucht es einen gemeinsamen Speicher (z. B. Redis) – siehe README.

const { AppError } = require('../lib/errors');

/**
 * @param {{ capacity: number, refillPerSec: number, key: (req: any) => string, name: string, now?: () => number }} opts
 */
function rateLimit({ capacity, refillPerSec, key, name, now = Date.now }) {
  /** @type {Map<string, { tokens: number, at: number }>} */
  const buckets = new Map();
  let sweep = now();
  const middleware = (req, res) => {
    const t = now();
    if (t - sweep > 60000) {
      sweep = t;
      for (const [k, b] of buckets) if (t - b.at > 600000) buckets.delete(k);
    }
    const k = `${name}:${key(req)}`;
    const b = buckets.get(k) || { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec);
    b.at = t;
    if (b.tokens < 1) {
      buckets.set(k, b);
      const wait = Math.ceil((1 - b.tokens) / refillPerSec);
      throw new AppError(429, 'rate_limited', 'Zu viele Anfragen. Bitte kurz warten.', { retryAfter: wait });
    }
    b.tokens -= 1;
    buckets.set(k, b);
    res.setHeader('x-ratelimit-remaining', String(Math.floor(b.tokens)));
  };
  middleware.reset = () => buckets.clear();
  return middleware;
}

const byIp = (req) => req.ip || 'unknown';
const byUser = (req) => req.user?.id || req.ip || 'unknown';

module.exports = { rateLimit, byIp, byUser };
