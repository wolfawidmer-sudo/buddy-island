'use strict';
// Stripe: Pay as you go (Paket oder eigener Betrag in USD), Abo mit Monats-Credits,
// Kundenportal, Webhooks, Rückerstattungen.
// Gutschrift NUR nach geprüftem Webhook (Signatur) UND Nachprüfung des Zahlungsstatus direkt
// bei Stripe. Eine geöffnete Erfolgsseite schreibt nie etwas gut.

const crypto = require('node:crypto');
const { AppError, badRequest, unavailable } = require('../lib/errors');
const { dollarsToCents, centsToDollars } = require('../lib/decimal');
const { UUID } = require('../middleware/validation');

const TOLERANCE_SEC = 300;
const CURRENCY = 'usd';
const ACTIVE = ['active', 'trialing', 'past_due'];
const ENDED = ['canceled', 'unpaid', 'incomplete_expired'];

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

const trimCredits = (c) => String(c).replace(/\.?0+$/, '');
const idOf = (x) => (typeof x === 'string' ? x : x?.id || null);
const toTs = (sec) => (Number.isFinite(Number(sec)) && Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null);

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

  // AGB-Häkchen im Checkout. Die AGB-URL ist im Stripe-Dashboard hinterlegt (Öffentliche Daten).
  // Der Text deckt den Verzicht auf das EU-Widerrufsrecht bei digitalen Inhalten ab.
  const TERMS = {
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: 'Ich akzeptiere die [AGB](https://buddy-island.top/agb.html) und die [Datenschutzerklärung](https://buddy-island.top/privacy.html). '
          + 'Ich will, dass Buddy Island sofort liefert, und weiss, dass ich damit mein Widerrufsrecht verliere. Es gibt keine Rückerstattung.',
      },
    },
  };

  // ---------------- Pay as you go ----------------

  /**
   * Checkout für ein Paket ODER einen eigenen Betrag (USD). Preis und Credits kommen aus der
   * Datenbank (Paket) bzw. werden dort berechnet (eigener Betrag), nie vom Client übernommen.
   * @param {{ id: string, email?: string }} user @param {{ packageId?: string, amount?: string }} input
   */
  async function createCheckout(user, { packageId, amount }) {
    if (Boolean(packageId) === Boolean(amount)) throw badRequest('Entweder ein Paket oder einen Betrag angeben');
    const purchase = packageId
      ? await supabase.rpc('create_purchase', { p_user_id: user.id, p_package_id: packageId })
      : await supabase.rpc('create_custom_purchase', { p_user_id: user.id, p_amount: amount });
    const session = await api('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      client_reference_id: purchase.id,
      customer_email: user.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: dollarsToCents(purchase.amount),
          product_data: { name: `${trimCredits(purchase.credits_purchased)} Buddy Credits` },
        },
      }],
      metadata: { purchase_id: purchase.id, kind: 'credits' },
      payment_intent_data: { metadata: { purchase_id: purchase.id } },
      ...TERMS,
      success_url: sc.successUrl,
      cancel_url: sc.cancelUrl,
    }, `checkout-${purchase.id}`);
    await supabase.rpc('attach_checkout', { p_purchase_id: purchase.id, p_checkout_id: session.id });
    return { purchaseId: purchase.id, checkoutUrl: session.url, amount: purchase.amount, currency: CURRENCY, credits: purchase.credits_purchased };
  }

  async function completePayment(s) {
    if (s.payment_status !== 'paid') {
      logger.info('checkout_not_paid_yet', { checkout: s.id, paymentStatus: s.payment_status });
      return 'pending';
    }
    const purchaseId = s.metadata?.purchase_id || s.client_reference_id;
    if (!purchaseId) return 'ignored';
    const p = await supabase.rpc('confirm_purchase', {
      p_purchase_id: purchaseId,
      p_checkout_id: s.id,
      p_payment_id: idOf(s.payment_intent),
      p_amount: centsToDollars(s.amount_total),
      p_currency: s.currency,
    });
    logger.info('purchase_completed', { purchaseId: p.id, status: p.status });
    return p.status;
  }

  // ---------------- Abo ----------------

  async function plan(planId) {
    if (!UUID.test(String(planId))) throw badRequest('Ungültiger Plan');
    const rows = await supabase.select('subscription_plans', `id=eq.${planId}&active=is.true&select=id,name,price,currency,monthly_credits`);
    if (!rows[0]) throw new AppError(404, 'plan_not_found', 'Dieses Abo gibt es nicht.');
    return rows[0];
  }

  async function currentSubscription(userId) {
    const rows = await supabase.select('subscriptions', `user_id=eq.${userId}&select=status,stripe_customer_id,stripe_subscription_id`);
    return rows[0] || null;
  }

  /** Abo abschliessen: Stripe Checkout im Abo-Modus (monatlich) */
  async function createSubscriptionCheckout(user, planId) {
    const p = await plan(planId);
    const existing = await currentSubscription(user.id);
    if (existing && ACTIVE.includes(existing.status)) {
      throw new AppError(409, 'already_subscribed', 'Du hast schon ein Abo. Verwalten kannst du es im Kundenportal.');
    }
    const session = await api('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      client_reference_id: user.id,
      ...(existing?.stripe_customer_id ? { customer: existing.stripe_customer_id } : { customer_email: user.email || undefined }),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: dollarsToCents(p.price),
          recurring: { interval: 'month' },
          product_data: { name: `${p.name} (${trimCredits(p.monthly_credits)} Buddy Credits pro Monat)` },
        },
      }],
      metadata: { kind: 'subscription', user_id: user.id, plan_id: p.id },
      subscription_data: { metadata: { user_id: user.id, plan_id: p.id } },
      ...TERMS,
      success_url: sc.successUrl,
      cancel_url: sc.cancelUrl,
    });
    return { checkoutUrl: session.url, plan: { id: p.id, name: p.name, price: p.price, currency: p.currency, monthlyCredits: p.monthly_credits } };
  }

  /** Kundenportal: kündigen, Zahlungsart ändern, Rechnungen */
  async function createPortal(user) {
    const s = await currentSubscription(user.id);
    if (!s?.stripe_customer_id) throw new AppError(404, 'no_subscription', 'Du hast noch kein Abo.');
    const portal = await api('POST', '/v1/billing_portal/sessions', { customer: s.stripe_customer_id, return_url: 'https://buddy-island.top' });
    return { portalUrl: portal.url };
  }

  /** Abo-Zustand direkt bei Stripe holen und übernehmen. Gibt { sub, userId, planId } zurück. */
  async function syncSubscription(subscriptionId, eventId) {
    const sub = await api('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const userId = sub.metadata?.user_id;
    const planId = sub.metadata?.plan_id;
    if (!UUID.test(String(userId))) {
      logger.warn('subscription_without_user', { subscription: sub.id });
      return null;
    }
    const periodEnd = toTs(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);
    await supabase.rpc('upsert_subscription', {
      p_user_id: userId,
      p_plan_id: UUID.test(String(planId)) ? planId : null,
      p_customer_id: idOf(sub.customer),
      p_subscription_id: sub.id,
      p_status: sub.status,
      p_period_end: periodEnd,
      p_cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    });
    if (ENDED.includes(sub.status)) {
      await supabase.rpc('end_subscription_credits', { p_user_id: userId, p_reference: `end:${sub.id}:${eventId || sub.status}` });
    }
    return { sub, userId, planId, periodEnd };
  }

  /** Bezahlte Abo-Rechnung → Monats-Credits (Rest der Vorperiode verfällt) */
  async function grantForInvoice(invoiceObj) {
    const inv = await api('GET', `/v1/invoices/${encodeURIComponent(invoiceObj.id)}`);
    if (inv.status !== 'paid') return 'pending';
    if (String(inv.currency).toLowerCase() !== CURRENCY) return 'ignored';
    const subscriptionId = idOf(inv.subscription) || idOf(inv.parent?.subscription_details?.subscription);
    if (!subscriptionId) return 'ignored';
    const synced = await syncSubscription(subscriptionId, inv.id);
    if (!synced || !UUID.test(String(synced.planId))) return 'ignored';
    const p = (await supabase.select('subscription_plans', `id=eq.${synced.planId}&select=monthly_credits`))[0];
    if (!p) return 'ignored';
    const lineEnd = toTs(inv.lines?.data?.[0]?.period?.end);
    const periodEnd = lineEnd || synced.periodEnd;
    if (!periodEnd) return 'ignored';
    await supabase.rpc('grant_subscription_credits', { p_user_id: synced.userId, p_invoice_id: inv.id, p_credits: p.monthly_credits, p_period_end: periodEnd });
    logger.info('subscription_credits_granted', { subscription: subscriptionId });
    return 'granted';
  }

  // ---------------- Webhook ----------------

  /** Geprüftes Webhook-Ereignis verarbeiten. Idempotent (Datenbankfunktionen). */
  async function handleEvent(event) {
    // Live-Modus: voller Secret Key (sk_live_) oder eingeschränkter Key (rk_live_)
    const live = /^(sk|rk)_live_/.test(sc.secretKey);
    if (Boolean(event.livemode) !== live) {
      logger.warn('stripe_mode_mismatch', { eventId: event.id, livemode: event.livemode });
      return 'ignored';
    }
    const obj = event.data?.object || {};
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        // Status direkt bei Stripe nachprüfen (nicht nur dem Ereignis glauben)
        const s = await api('GET', `/v1/checkout/sessions/${encodeURIComponent(obj.id)}`);
        if (s.mode === 'subscription') {
          if (s.subscription) await syncSubscription(idOf(s.subscription), event.id);
          return 'subscription_synced'; // Credits kommen mit invoice.paid
        }
        return completePayment(s);
      }
      case 'checkout.session.async_payment_failed':
        if (obj.mode === 'subscription') return 'ignored';
        await supabase.rpc('mark_purchase', { p_checkout_id: obj.id, p_status: 'failed' });
        return 'failed';
      case 'checkout.session.expired':
        if (obj.mode === 'subscription') return 'ignored';
        await supabase.rpc('mark_purchase', { p_checkout_id: obj.id, p_status: 'expired' });
        return 'expired';
      case 'invoice.paid':
        return grantForInvoice(obj);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(obj.id, event.id);
        return 'subscription_synced';
      case 'charge.refunded': {
        if (String(obj.currency).toLowerCase() !== CURRENCY || !obj.payment_intent) return 'ignored';
        try {
          const p = await supabase.rpc('refund_payment', { p_payment_id: idOf(obj.payment_intent), p_refunded_total: centsToDollars(obj.amount_refunded) });
          logger.info('purchase_refunded', { purchaseId: p.id, status: p.status });
          return p.status;
        } catch (err) {
          // Rückerstattung einer Abo-Rechnung: kein Einzelkauf. Abo-Credits laufen mit der Periode aus.
          if (/** @type {any} */ (err).code === 'purchase_not_found') return 'ignored';
          throw err;
        }
      }
      default:
        return 'ignored';
    }
  }

  return {
    createCheckout, createSubscriptionCheckout, createPortal, handleEvent,
    verify: (raw, header) => verifySignature(raw, header, sc.webhookSecret),
  };
}

module.exports = { createStripeService, verifySignature, form };
