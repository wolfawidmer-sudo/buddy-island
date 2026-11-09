'use strict';
// Stripe: Checkout erstellen, Webhooks prüfen, Käufe gutschreiben, Rückerstattungen.
// Gutschrift NUR nach geprüftem Webhook (Signatur) UND bestätigtem Zahlungsstatus bei Stripe.
// Eine geöffnete Erfolgsseite schreibt nie etwas gut.

const crypto = require('node:crypto');
const { AppError, badRequest, unavailable } = require('../lib/errors');

const TOLERANCE_SEC = 300;

/** "12.50" → 1250 (Rappen), ohne Fliesskommazahlen */
function chfToRappen(chf) {
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(String(chf));
  if (!m) throw new Error(`Ungültiger CHF-Betrag: ${chf}`);
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

/** 1250 → "12.50" */
function rappenToChf(rappen) {
  const r = Number(rappen);
  if (!Number.isSafeInteger(r) || r < 0) throw new Error('Ungültiger Betrag');
  return `${Math.trunc(r / 100)}.${String(r % 100).padStart(2, '0')}`;
}

/**
 * Stripe-Signatur prüfen (Header «Stripe-Signature»: t=…,v1=…).
 * @param {Buffer} raw @param {string} header @param {string} secret @param {number} nowSec
 */
function verifySignature(raw, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) throw unavailable('Stripe ist nicht eingerichtet', 'not_configured');
  const parts = String(header || '').split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length) throw new AppError(400, 'invalid_signature', 'Ungültige Signatur');
  if (Math.abs(nowSec - t) > TOLERANCE_SEC) throw new AppError(400, 'invalid_signature', 'Signatur abgelaufen');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const ok = sigs.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
  if (!ok) throw new AppError(400, 'invalid_signature', 'Ungültige Signatur');
  return JSON.parse(raw.toString('utf8'));
}

/** Formular-Kodierung für die Stripe-API (verschachtelte Schlüssel) */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/** @param {{ config: any, supabase: any, logger: any, fetchImpl?: typeof fetch }} deps */
function createStripeService({ config, supabase, logger, fetchImpl = globalThis.fetch }) {
  const sc = config.stripe;

  async function api(method, path, params, idempotencyKey) {
    if (!sc.secretKey) throw unavailable('Zahlungen sind noch nicht eingerichtet.', 'not_configured');
    let r;
    try {
      r = await fetchImpl(`${sc.apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${sc.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: params ? form(params).toString() : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      logger.warn('stripe_unreachable', { error: err });
      throw unavailable('Zahlungen sind gerade nicht erreichbar.');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.error('stripe_api_error', { path: path.split('?')[0], status: r.status, stripeCode: data?.error?.code });
      throw new AppError(502, 'payment_provider_error', 'Fehler beim Zahlungsanbieter.');
    }
    return data;
  }

  /** Checkout für ein Credit-Paket. Preis und Credits kommen aus der Datenbank, nie vom Client. */
  async function createCheckout(user, packageId) {
    const purchase = await supabase.rpc('create_purchase', { p_user_id: user.id, p_package_id: packageId });
    const rappen = chfToRappen(purchase.amount_chf);
    const session = await api('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      client_reference_id: purchase.id,
      customer_email: user.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'chf',
          unit_amount: rappen,
          product_data: { name: `${String(purchase.credits_purchased).replace(/\.?0+$/, '')} Buddy Credits` },
        },
      }],
      metadata: { purchase_id: purchase.id },
      payment_intent_data: { metadata: { purchase_id: purchase.id } },
      success_url: sc.successUrl,
      cancel_url: sc.cancelUrl,
    }, `checkout-${purchase.id}`);
    await supabase.rpc('attach_checkout', { p_purchase_id: purchase.id, p_checkout_id: session.id });
    return { purchaseId: purchase.id, checkoutUrl: session.url, amountChf: purchase.amount_chf, credits: purchase.credits_purchased };
  }

  async function completeFromSession(sessionObj) {
    // Zahlungsstatus direkt bei Stripe nachprüfen (nicht nur dem Ereignis glauben)
    const s = await api('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionObj.id)}`);
    if (s.payment_status !== 'paid') {
      logger.info('checkout_not_paid_yet', { checkout: s.id, paymentStatus: s.payment_status });
      return 'pending';
    }
    const purchaseId = s.metadata?.purchase_id || s.client_reference_id;
    if (!purchaseId) throw badRequest('Kauf ohne Zuordnung');
    const p = await supabase.rpc('complete_purchase', {
      p_purchase_id: purchaseId,
      p_checkout_id: s.id,
      p_payment_id: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id,
      p_amount_chf: rappenToChf(s.amount_total),
      p_currency: s.currency,
    });
    logger.info('purchase_completed', { purchaseId: p.id, status: p.status });
    return p.status;
  }

  /** Geprüftes Webhook-Ereignis verarbeiten. Idempotent (Datenbankfunktionen). */
  async function handleEvent(event) {
    const live = /^sk_live_/.test(sc.secretKey);
    if (Boolean(event.livemode) !== live) {
      logger.warn('stripe_mode_mismatch', { eventId: event.id, livemode: event.livemode });
      return 'ignored';
    }
    const obj = event.data?.object || {};
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return completeFromSession(obj);
      case 'checkout.session.async_payment_failed':
        await supabase.rpc('mark_purchase', { p_checkout_id: obj.id, p_status: 'failed' });
        return 'failed';
      case 'checkout.session.expired':
        await supabase.rpc('mark_purchase', { p_checkout_id: obj.id, p_status: 'expired' });
        return 'expired';
      case 'charge.refunded': {
        if (String(obj.currency).toLowerCase() !== 'chf' || !obj.payment_intent) return 'ignored';
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent.id;
        try {
          const p = await supabase.rpc('refund_purchase', { p_payment_id: pi, p_refunded_total_chf: rappenToChf(obj.amount_refunded) });
          logger.info('purchase_refunded', { purchaseId: p.id, status: p.status });
          return p.status;
        } catch (err) {
          if (/** @type {any} */ (err).code === 'purchase_not_found') return 'ignored'; // nicht von Buddy
          throw err;
        }
      }
      default:
        return 'ignored';
    }
  }

  return { createCheckout, handleEvent, verify: (raw, header) => verifySignature(raw, header, sc.webhookSecret) };
}

module.exports = { createStripeService, verifySignature, chfToRappen, rappenToChf, form };
