'use strict';
// Buddy Credits: Schätzen, Reservieren, Abrechnen, Freigeben.
// Alle Geldrechnungen passieren in Postgres (numeric). Hier werden nur ganze Token-Zahlen
// geschätzt (Integer-Arithmetik) und die Datenbankfunktionen aufgerufen.

const crypto = require('node:crypto');

const IMAGE_TOKENS_ESTIMATE = 2000; // grosszügig je Bild; abgerechnet wird später nach echter Nutzung
const OVERHEAD_TOKENS = 64;

/**
 * Grobe, absichtlich eher zu hohe Schätzung der Eingabe-Tokens (für die Reservierung).
 * Text: 1 Token je 3 UTF-8-Bytes. Bilder: feste Pauschale statt Base64-Länge.
 * @param {unknown} payload
 */
function estimateInputTokens(payload) {
  let bytes = 0;
  let images = 0;
  /** @param {unknown} v @param {number} depth */
  const walk = (v, depth) => {
    if (depth > 40 || v === null || v === undefined) return;
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean') { bytes += 8; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') {
      const o = /** @type {Record<string, unknown>} */ (v);
      if (o.type === 'input_image') { images += 1; return; }
      for (const [k, x] of Object.entries(o)) {
        if (k === 'encrypted_content' && typeof x === 'string') { bytes += Math.ceil(Buffer.byteLength(x) / 2); continue; }
        bytes += k.length;
        walk(x, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return Math.ceil(bytes / 3) + images * IMAGE_TOKENS_ESTIMATE + OVERHEAD_TOKENS;
}

/** @param {{ supabase: any, logger: any, now?: () => number }} deps */
function createBillingService({ supabase, logger, now = Date.now }) {
  /** @type {{ ids: Set<string>, at: number } | null} */
  let modelCache = null;

  /** Modelle mit aktivem Preis = in Buddy Cloud erlaubt */
  async function models() {
    if (modelCache && now() - modelCache.at < 60000) return [...modelCache.ids];
    const rows = await supabase.select('model_pricing', `active=is.true&effective_from=lte.${encodeURIComponent(new Date(now()).toISOString())}&select=model_id`);
    modelCache = { ids: new Set(rows.map((r) => r.model_id)), at: now() };
    return [...modelCache.ids];
  }

  async function isAllowed(model) {
    return (await models()).includes(model);
  }

  /** Credits für eine Anfrage mit diesen Token-Zahlen (String, exakt) */
  async function quote(model, inputTokens, cachedTokens, outputTokens, audio = null) {
    const rows = await supabase.rpc('billing_quote', {
      p_model: model, p_input_tokens: inputTokens, p_cached_tokens: cachedTokens, p_output_tokens: outputTokens, p_audio: audio,
    });
    const q = Array.isArray(rows) ? rows[0] : rows;
    return { providerCost: q.provider_cost, markup: q.markup_amount, totalCost: q.total_cost, credits: q.credits };
  }

  const newRequestId = () => `bc_${crypto.randomUUID()}`;

  async function reserve({ userId, requestId, model, credits }) {
    const rows = await supabase.rpc('reserve_credits', { p_user_id: userId, p_request_id: requestId, p_model: model, p_amount: credits });
    const r = Array.isArray(rows) ? rows[0] : rows;
    return { reservationId: r.reservation_id, amount: r.amount, available: r.available_credits };
  }

  /** @param {string} requestId @param {{ inputTokens: number, cachedTokens: number, outputTokens: number, audio?: any }} usage */
  async function settle(requestId, usage) {
    const e = await supabase.rpc('settle_reservation', {
      p_request_id: requestId,
      p_input_tokens: Math.max(0, Math.trunc(usage.inputTokens || 0)),
      p_cached_tokens: Math.max(0, Math.trunc(usage.cachedTokens || 0)),
      p_output_tokens: Math.max(0, Math.trunc(usage.outputTokens || 0)),
      p_audio: usage.audio || null,
    });
    return { credits: e.credits_charged, status: e.status };
  }

  async function release(requestId, status = 'released', reason = null) {
    try {
      await supabase.rpc('release_reservation', { p_request_id: requestId, p_status: status, p_reason: reason });
    } catch (err) {
      // Nicht still schlucken: abgelaufene Reservierungen gibt die Datenbank später selbst frei
      logger.error('release_failed', { requestId, error: err });
    }
  }

  return { models, isAllowed, quote, reserve, settle, release, newRequestId, estimateInputTokens };
}

module.exports = { createBillingService, estimateInputTokens, IMAGE_TOKENS_ESTIMATE };
