'use strict';
// Lesen von Profil, Guthaben, Buchungen, Nutzung und Käufen. Immer gefiltert mit der
// geprüften Nutzer-ID aus dem Token. Beträge bleiben Strings (exakte Dezimalzahlen aus Postgres).
// Rohe Anbieterkosten (USD, Tokenpreise) gehen nicht an die App.

const { UUID } = require('../middleware/validation');
const { badRequest } = require('../lib/errors');
const { add } = require('../lib/decimal');

const VISIBLE_TYPES = ['purchase', 'usage', 'refund', 'adjustment', 'subscription_grant', 'subscription_expiry'];

/** @param {{ supabase: any }} deps */
function createWalletService({ supabase }) {
  const uid = (id) => {
    if (!UUID.test(String(id))) throw badRequest('Ungültige Nutzer-ID');
    return id;
  };

  // available = alles, was man jetzt ausgeben kann (Abo + gekauft)
  const toWallet = (w) => ({
    available: add(w.available_credits, w.subscription_credits || '0'),
    purchased: w.available_credits,
    subscription: { credits: w.subscription_credits || '0.000000', expiresAt: w.subscription_expires_at || null },
    reserved: w.reserved_credits,
    lifetimePurchased: w.lifetime_purchased,
    lifetimeConsumed: w.lifetime_consumed,
    updatedAt: w.updated_at,
  });

  async function wallet(userId) {
    const w = await supabase.rpc('get_wallet', { p_user_id: uid(userId) });
    return toWallet(w);
  }

  async function profile(userId) {
    const rows = await supabase.select('profiles', `id=eq.${uid(userId)}&select=id,display_name,avatar_url,created_at`);
    const p = rows[0] || { id: userId, display_name: null, avatar_url: null, created_at: null };
    return { id: p.id, displayName: p.display_name, avatarUrl: p.avatar_url, createdAt: p.created_at };
  }

  async function updateProfile(userId, { displayName }) {
    const rows = await supabase.update('profiles', `id=eq.${uid(userId)}`, { display_name: displayName || null });
    const p = rows[0];
    return p ? { id: p.id, displayName: p.display_name, avatarUrl: p.avatar_url, createdAt: p.created_at } : profile(userId);
  }

  async function transactions(userId, limit = 50) {
    const rows = await supabase.select('wallet_transactions',
      `user_id=eq.${uid(userId)}&transaction_type=in.(${VISIBLE_TYPES.join(',')})&select=id,transaction_type,amount,balance_after,description,created_at&order=created_at.desc&limit=${limit}`);
    return rows.map((r) => ({ id: r.id, type: r.transaction_type, amount: r.amount, balanceAfter: r.balance_after, description: r.description, createdAt: r.created_at }));
  }

  async function usage(userId, limit = 50) {
    const rows = await supabase.select('usage_events',
      `user_id=eq.${uid(userId)}&select=id,model,input_tokens,output_tokens,cached_tokens,credits_charged,status,created_at&order=created_at.desc&limit=${limit}`);
    return rows.map((r) => ({ id: r.id, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cachedTokens: r.cached_tokens, credits: r.credits_charged, status: r.status, createdAt: r.created_at }));
  }

  async function purchases(userId, limit = 50) {
    const rows = await supabase.select('purchases',
      `user_id=eq.${uid(userId)}&status=neq.pending&select=id,amount,currency,kind,credits_purchased,refunded_amount,credits_refunded,status,created_at,completed_at&order=created_at.desc&limit=${limit}`);
    return rows.map((r) => ({ id: r.id, amount: r.amount, currency: r.currency, kind: r.kind, credits: r.credits_purchased, refundedAmount: r.refunded_amount, creditsRefunded: r.credits_refunded, status: r.status, createdAt: r.created_at, completedAt: r.completed_at }));
  }

  async function packages() {
    const rows = await supabase.select('credit_packages', 'active=is.true&select=id,name,price,currency,credits,display_order&order=display_order.asc');
    return rows.map((r) => ({ id: r.id, name: r.name, price: r.price, currency: r.currency, credits: r.credits }));
  }

  async function plans() {
    const rows = await supabase.select('subscription_plans', 'active=is.true&select=id,name,price,currency,monthly_credits,display_order&order=display_order.asc');
    return rows.map((r) => ({ id: r.id, name: r.name, price: r.price, currency: r.currency, monthlyCredits: r.monthly_credits, interval: 'month' }));
  }

  async function subscription(userId) {
    const rows = await supabase.select('subscriptions',
      `user_id=eq.${uid(userId)}&select=status,current_period_end,cancel_at_period_end,plan_id,subscription_plans(name,price,currency,monthly_credits)`);
    const s = rows[0];
    if (!s) return null;
    const p = s.subscription_plans || {};
    return {
      status: s.status,
      active: ['active', 'trialing', 'past_due'].includes(s.status),
      currentPeriodEnd: s.current_period_end,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      plan: s.plan_id ? { id: s.plan_id, name: p.name, price: p.price, currency: p.currency, monthlyCredits: p.monthly_credits } : null,
    };
  }

  /** Öffentliche Kaufregeln (Mindest-/Höchstbetrag, Umrechnung) */
  async function billingConfig() {
    const rows = await supabase.select('billing_settings', 'id=is.true&select=credits_per_usd,min_purchase,max_purchase');
    const s = rows[0] || {};
    return { currency: 'usd', creditsPerUsd: s.credits_per_usd ?? null, minPurchase: s.min_purchase ?? '5.00', maxPurchase: s.max_purchase ?? '500.00', ready: s.credits_per_usd != null };
  }

  return { wallet, profile, updateProfile, transactions, usage, purchases, packages, plans, subscription, billingConfig };
}

module.exports = { createWalletService };
