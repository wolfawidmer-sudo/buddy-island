// Ende-zu-Ende: HTTP → Backend → echte Datenbankfunktionen (lokales Postgres) → Attrappe OpenAI.
// Prüft, dass Backend und SQL-Funktionen zusammenpassen (Namen, Parameter, Rückgaben).
// Start: BUDDY_TEST_PG="-h /tmp/pg -p 54329 -U postgres" node --test tests/db/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { startApp, signToken, json } = require('../helpers');

const PG = process.env.BUDDY_TEST_PG;
const DB = 'buddy_gateway_test';
const args = (PG || '').split(/\s+/).filter(Boolean);
const root = path.resolve(__dirname, '..', '..', '..');
const SET_RETURNING = new Set(['billing_quote', 'reserve_credits', 'release_reservation']);

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

function psql(sql) {
  return new Promise((resolve) => {
    execFile('psql', [...args, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', `set role service_role; ${sql}`], { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ ok: !error, out: stdout.trim(), err: stderr }));
  });
}

/** PostgREST-ähnliche RPC gegen das echte Postgres */
async function rpc(name, a) {
  const named = Object.entries(a).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const sql = SET_RETURNING.has(name)
    ? `select coalesce(json_agg(to_json(f)), '[]'::json) from public.${name}(${named}) f`
    : `select to_json(f) from public.${name}(${named}) f limit 1`;
  const r = await psql(sql);
  if (!r.ok) {
    const msg = /ERROR:\s+(\S+)/.exec(r.err)?.[1] || 'error';
    return json(400, { message: msg, code: 'P0001' });
  }
  // Roh weitergeben wie PostgREST (Dezimalzahlen bleiben unverändert im JSON-Text)
  return new Response(r.out, { status: 200, headers: { 'content-type': 'application/json' } });
}

test.describe('Gateway gegen echte Datenbank', { skip: !PG && 'BUDDY_TEST_PG nicht gesetzt' }, () => {
  let uid;
  test.before(() => {
    const run = (db, a) => execFileSync('psql', [...args, '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', ...a], { stdio: ['ignore', 'ignore', 'pipe'] });
    run('postgres', ['-c', `drop database if exists ${DB}`]);
    run('postgres', ['-c', `create database ${DB}`]);
    run(DB, ['-f', path.join(__dirname, 'supabase-stub.sql')]);
    const dir = path.join(root, 'supabase', 'migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) run(DB, ['-f', path.join(dir, f)]);
    run(DB, ['-c', `update public.billing_settings set markup_rate = 0.10, credits_per_usd = 80;
      insert into public.model_pricing (model_id, input_price, output_price, cached_input_price, effective_from) values ('gpt-test', 2, 8, 0.5, now() - interval '1 day');`]);
    uid = execFileSync('psql', [...args, '-d', DB, '-qAt', '-c', `insert into auth.users (email) values ('e2e@example.com') returning id`], { encoding: 'utf8' }).trim();
    run(DB, ['-c', `select public.adjust_credits('${uid}', 5, 'e2e-fund', 'Test')`]);
  });

  const handlers = (openai) => ({
    supabaseRpc: (name, a) => rpc(name, a),
    supabaseSelect: async (table) => {
      if (table !== 'model_pricing') return json(200, []);
      const r = await psql(`select coalesce(jsonb_agg(jsonb_build_object('model_id', model_id)), '[]') from public.model_pricing where active`);
      return json(200, JSON.parse(r.out));
    },
    openai,
  });

  test('Anfrage wird mit echter Formel abgerechnet', async () => {
    // 10'000 Eingabe (2'000 gecacht), 1'000 Ausgabe:
    // 8000*2 + 2000*0.5 + 1000*8 = 25'000 / 1M = 0.025 USD; +10 % = 0.0275; *0.8*100 = 2.2 BC
    const app = await startApp({ handlers: handlers(() => json(200, { id: 'r', status: 'completed', output: [], usage: { input_tokens: 10000, input_tokens_details: { cached_tokens: 2000 }, output_tokens: 1000 } })) });
    try {
      const r = await app.call('POST', '/v1/cloud/responses', { token: signToken({ sub: uid }), body: { model: 'gpt-test', input: 'Hallo', max_output_tokens: 2000 } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.headers.get('x-buddy-credits-charged'), '2.200000');
      const w = await psql(`select available_credits, reserved_credits from public.wallets where user_id = '${uid}'`);
      assert.equal(w.out, '2.800000|0.000000');
      const e = await psql(`select provider_cost, markup_amount, credits_charged, status from public.usage_events where user_id = '${uid}'`);
      assert.equal(e.out, '0.02500000|0.00250000|2.200000|settled');
    } finally { await app.close(); }
  });

  test('Viele gleichzeitige Anfragen: nie mehr ausgegeben als vorhanden, Rest bekommt 402', async () => {
    // Reservierung je Anfrage: ~70 Eingabe + 2'000 Ausgabe → ~1.42 BC; 2.8 BC reichen gleichzeitig nur für 1
    const app = await startApp({ handlers: handlers(async () => { await new Promise((r) => setTimeout(r, 150)); return json(200, { id: 'r', status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 100 } }); }) });
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => app.call('POST', '/v1/cloud/responses', { token: signToken({ sub: uid }), body: { model: 'gpt-test', input: 'Hi', max_output_tokens: 2000 } })));
      const ok = results.filter((r) => r.status === 200).length;
      const denied = results.filter((r) => r.status === 402).length;
      assert.equal(ok + denied, 8);
      assert.ok(ok >= 1 && denied >= 1, `ok=${ok} denied=${denied}`);
      const w = await psql(`select available_credits >= 0, reserved_credits from public.wallets where user_id = '${uid}'`);
      assert.equal(w.out, 't|0.000000');
    } finally { await app.close(); }
  });

  test('Stripe Ende-zu-Ende gegen echte Datenbank: eigener Betrag und Abo', async () => {
    const crypto = require('node:crypto');
    const PLAN = '66666666-6666-4666-8666-666666666666';
    await psql(`reset role; insert into public.subscription_plans (id, name, price, monthly_credits) values ('${PLAN}', 'Buddy Plus', 10.00, 1000) on conflict do nothing`);
    const user = (await psql(`reset role; insert into auth.users (email) values ('stripe-e2e@example.com') returning id`)).out;
    let checkout = null;
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    let subStatus = 'active';
    const app = await startApp({
      handlers: {
        supabaseRpc: (name, a) => rpc(name, a),
        supabaseSelect: async (table, query) => {
          if (table === 'subscription_plans') {
            const id = /id=eq\.([0-9a-f-]{36})/.exec(query)?.[1];
            const r = await psql(`select coalesce(json_agg(json_build_object('id', id, 'name', name, 'price', price, 'currency', currency, 'monthly_credits', monthly_credits)), '[]') from public.subscription_plans where active and id = '${id}'`);
            return new Response(r.out, { status: 200 });
          }
          if (table === 'subscriptions') {
            const r = await psql(`select coalesce(json_agg(json_build_object('status', status, 'stripe_customer_id', stripe_customer_id, 'stripe_subscription_id', stripe_subscription_id)), '[]') from public.subscriptions where user_id = '${user}'`);
            return new Response(r.out, { status: 200 });
          }
          return json(200, []);
        },
        stripe: async (method, path, form) => {
          if (method === 'POST' && path === '/v1/checkout/sessions') {
            checkout = Object.fromEntries(form);
            return json(200, { id: form.get('mode') === 'subscription' ? 'cs_e2e_sub' : 'cs_e2e_pay', url: 'https://checkout.stripe.com/c/pay/x' });
          }
          if (path === '/v1/checkout/sessions/cs_e2e_pay') return json(200, { id: 'cs_e2e_pay', mode: 'payment', payment_status: 'paid', amount_total: 1250, currency: 'usd', payment_intent: 'pi_e2e', metadata: { purchase_id: checkout['metadata[purchase_id]'] } });
          if (path === '/v1/subscriptions/sub_e2e') return json(200, { id: 'sub_e2e', status: subStatus, customer: 'cus_e2e', metadata: { user_id: user, plan_id: PLAN }, items: { data: [{ current_period_end: periodEnd }] } });
          if (path === '/v1/invoices/in_e2e') return json(200, { id: 'in_e2e', status: 'paid', currency: 'usd', parent: { subscription_details: { subscription: 'sub_e2e' } }, lines: { data: [{ period: { end: periodEnd } }] } });
          return json(404, {});
        },
      },
    });
    const hook = (event) => {
      const raw = JSON.stringify({ livemode: false, ...event });
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', 'whsec_testsecret000000').update(`${ts}.${raw}`).digest('hex');
      return app.call('POST', '/webhooks/stripe', { raw, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } });
    };
    const bal = async () => (await psql(`select available_credits, subscription_credits from public.wallets where user_id = '${user}'`)).out;
    try {
      const token = signToken({ sub: user, email: 'stripe-e2e@example.com' });
      // eigener Betrag $12.50 → 1000 BC (80 BC/USD)
      const r = await app.call('POST', '/v1/purchases/checkout', { token, body: { amount: '12.50' } });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.credits, '1000.000000');
      assert.equal(checkout['line_items[0][price_data][unit_amount]'], '1250');
      assert.equal((await hook({ id: 'evt_e2e_1', type: 'checkout.session.completed', data: { object: { id: 'cs_e2e_pay' } } })).status, 200);
      await hook({ id: 'evt_e2e_1b', type: 'checkout.session.completed', data: { object: { id: 'cs_e2e_pay' } } }); // doppelt
      assert.equal(await bal(), '1000.000000|0.000000');
      // Abo abschliessen und bezahlen
      assert.equal((await app.call('POST', '/v1/subscription/checkout', { token, body: { planId: PLAN } })).status, 201);
      await hook({ id: 'evt_e2e_2', type: 'customer.subscription.created', data: { object: { id: 'sub_e2e' } } });
      await hook({ id: 'evt_e2e_3', type: 'invoice.paid', data: { object: { id: 'in_e2e' } } });
      await hook({ id: 'evt_e2e_3b', type: 'invoice.paid', data: { object: { id: 'in_e2e' } } }); // doppelt
      assert.equal(await bal(), '1000.000000|1000.000000');
      // zweites Abo abgelehnt
      assert.equal((await app.call('POST', '/v1/subscription/checkout', { token, body: { planId: PLAN } })).status, 409);
      // Kontostand über die API: Summe exakt
      const me = await app.call('GET', '/v1/wallet', { token });
      assert.equal(me.data.wallet.available, '2000.000000');
      assert.equal(me.data.wallet.subscription.credits, '1000.000000');
      // kündigen → Abo-Rest weg, gekaufte bleiben
      subStatus = 'canceled';
      await hook({ id: 'evt_e2e_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_e2e' } } });
      assert.equal(await bal(), '1000.000000|0.000000');
    } finally { await app.close(); }
  });
});
