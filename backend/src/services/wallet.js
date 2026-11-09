'use strict';
// Lesen von Profil, Guthaben, Buchungen, Nutzung und Käufen. Immer gefiltert mit der
// geprüften Nutzer-ID aus dem Token. Beträge bleiben Strings (exakte Dezimalzahlen aus Postgres).
// Rohe Anbieterkosten (USD, Tokenpreise) gehen nicht an die App.

const { UUID } = require('../middleware/validation');
const { badRequest } = require('../lib/errors');

const VISIBLE_TYPES = ['purchase', 'usage', 'refund', 'adjustment'];

/** @param {{ supabase: any }} deps */
function createWalletService({ supabase }) {
  const uid = (id) => {
    if (!UUID.test(String(id))) throw badRequest('Ungültige Nutzer-ID');
    return id;
  };

  const toWallet = (w) => ({
    available: w.available_credits,
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
      `user_id=eq.${uid(userId)}&status=neq.pending&select=id,amount_chf,credits_purchased,refunded_chf,credits_refunded,status,created_at,completed_at&order=created_at.desc&limit=${limit}`);
    return rows.map((r) => ({ id: r.id, amountChf: r.amount_chf, credits: r.credits_purchased, refundedChf: r.refunded_chf, creditsRefunded: r.credits_refunded, status: r.status, createdAt: r.created_at, completedAt: r.completed_at }));
  }

  async function packages() {
    const rows = await supabase.select('credit_packages', 'active=is.true&select=id,name,price_chf,credits,display_order&order=display_order.asc');
    return rows.map((r) => ({ id: r.id, name: r.name, priceChf: r.price_chf, credits: r.credits }));
  }

  return { wallet, profile, updateProfile, transactions, usage, purchases, packages };
}

module.exports = { createWalletService };
