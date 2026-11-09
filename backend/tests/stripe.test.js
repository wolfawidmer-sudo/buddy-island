'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, signToken, json, USER_A } = require('./helpers');
const { verifySignature } = require('../src/services/stripe');
const { dollarsToCents, centsToDollars, add } = require('../src/lib/decimal');

const SECRET = 'whsec_testsecret000000';
const PURCHASE = '33333333-3333-4333-8333-333333333333';
const PACKAGE = '44444444-4444-4444-8444-444444444444';
const PLAN = '55555555-5555-4555-8555-555555555555';

function signed(event, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { raw, header: `t=${t},v1=${sig}` };
}

function setup({ paymentStatus = 'paid', existingSub = null, invoiceStatus = 'paid', subStatus = 'active', subUser = USER_A } = {}) {
  const rpc = [];
  const stripeCalls = [];
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    rpc,
    stripeCalls,
    periodEnd,
    handlers: {
      supabaseRpc: (name, a) => {
        rpc.push({ name, a });
        if (name === 'create_purchase') return json(200, { id: PURCHASE, amount: '10.00', currency: 'usd', credits_purchased: '1000.000000', status: 'pending' });
        if (name === 'create_custom_purchase') {
          if (a.p_amount === '4.99') return json(400, { message: 'invalid_amount' });
          return json(200, { id: PURCHASE, amount: a.p_amount, currency: 'usd', credits_purchased: '1234.000000', status: 'pending' });
        }
        if (name === 'attach_checkout') return json(200, { id: PURCHASE });
        if (name === 'confirm_purchase') return json(200, { id: PURCHASE, status: 'completed' });
        if (name === 'refund_payment') return json(200, { id: PURCHASE, status: 'partially_refunded' });
        if (name === 'mark_purchase') return json(200, { id: PURCHASE, status: a.p_status });
        if (name === 'upsert_subscription') return json(200, { id: 'sub-row' });
        if (name === 'grant_subscription_credits') return json(200, { id: 'w' });
        if (name === 'end_subscription_credits') return json(200, { id: 'w' });
        return json(404, {});
      },
      supabaseSelect: (table, query) => {
        if (table === 'subscription_plans') return json(200, query.includes(PLAN) ? [{ id: PLAN, name: 'Buddy Plus', price: '10.00', currency: 'usd', monthly_credits: '1000.000000' }] : []);
        if (table === 'subscriptions') return json(200, existingSub ? [existingSub] : []);
        return json(200, []);
      },
      stripe: (method, path, form, headers) => {
        stripeCalls.push({ method, path, form: Object.fromEntries(form), headers });
        if (method === 'POST' && path === '/v1/checkout/sessions') return json(200, { id: form.get('mode') === 'subscription' ? 'cs_sub_1' : 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
        if (method === 'GET' && path === '/v1/checkout/sessions/cs_test_1') {
          return json(200, { id: 'cs_test_1', mode: 'payment', payment_status: paymentStatus, amount_total: 1000, currency: 'usd', payment_intent: 'pi_1', metadata: { purchase_id: PURCHASE }, client_reference_id: PURCHASE });
        }
        if (method === 'GET' && path === '/v1/checkout/sessions/cs_sub_1') return json(200, { id: 'cs_sub_1', mode: 'subscription', subscription: 'sub_1', payment_status: 'paid' });
        if (method === 'GET' && path === '/v1/subscriptions/sub_1') {
          return json(200, { id: 'sub_1', status: subStatus, customer: 'cus_1', cancel_at_period_end: false, metadata: { user_id: subUser, plan_id: PLAN }, items: { data: [{ current_period_end: periodEnd }] } });
        }
        if (method === 'GET' && path === '/v1/invoices/in_1') {
          return json(200, { id: 'in_1', status: invoiceStatus, currency: 'usd', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { end: periodEnd } }] } });
        }
        if (method === 'POST' && path === '/v1/billing_portal/sessions') return json(200, { url: 'https://billing.stripe.com/p/session/x' });
        return json(404, { error: { code: 'resource_missing' } });
      },
    },
  };
}

const post = (app, event) => {
  const { raw, header } = signed(event);
  return app.call('POST', '/webhooks/stripe', { raw, headers: { 'stripe-signature': header, 'content-type': 'application/json' } });
};
const completedEvent = { id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_1', mode: 'payment' } } };

test.describe('Stripe: Pay as you go (USD)', () => {
  test('Paket: Preis aus der Datenbank, USD in Cent, Idempotency-Key, Kauf verknüpft', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const r = await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { packageId: PACKAGE } });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.amount, '10.00');
      assert.equal(r.data.currency, 'usd');
      assert.deepEqual(s.rpc[0], { name: 'create_purchase', a: { p_user_id: USER_A, p_package_id: PACKAGE } });
      const c = s.stripeCalls[0];
      assert.equal(c.form.mode, 'payment');
      assert.equal(c.form['line_items[0][price_data][unit_amount]'], '1000');
      assert.equal(c.form['line_items[0][price_data][currency]'], 'usd');
      assert.equal(c.headers['idempotency-key'], `checkout-${PURCHASE}`);
      // Preis darf nicht vom Client kommen
      assert.equal((await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { packageId: PACKAGE, price: '0.01' } })).status, 400);
    } finally { await app.close(); }
  });

  test('Eigener Betrag: Datenbank rechnet Credits, Stripe bekommt Cent; Regeln geprüft', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const r = await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { amount: '12.34' } });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.deepEqual(s.rpc[0], { name: 'create_custom_purchase', a: { p_user_id: USER_A, p_amount: '12.34' } });
      assert.equal(s.stripeCalls[0].form['line_items[0][price_data][unit_amount]'], '1234');
      assert.equal(s.stripeCalls[0].form['line_items[0][price_data][product_data][name]'], '1234 Buddy Credits');
      // zu klein → Meldung aus der Datenbank
      const small = await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { amount: '4.99' } });
      assert.equal(small.status, 400);
      assert.equal(small.data.error.code, 'invalid_amount');
      // kein Zahlenformat, beides, keins
      app.app.resetLimits();
      assert.equal((await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { amount: '1e3' } })).status, 400);
      assert.equal((await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { amount: 12.5 } })).status, 400);
      assert.equal((await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { amount: '10', packageId: PACKAGE } })).status, 400);
      assert.equal((await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: {} })).status, 400);
    } finally { await app.close(); }
  });

  test('Webhook: Zahlung bei Stripe nachgeprüft, dann gutgeschrieben (USD)', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      assert.equal((await post(app, completedEvent)).status, 200);
      assert.equal(s.stripeCalls[0].path, '/v1/checkout/sessions/cs_test_1');
      assert.deepEqual(s.rpc.find((x) => x.name === 'confirm_purchase').a, { p_purchase_id: PURCHASE, p_checkout_id: 'cs_test_1', p_payment_id: 'pi_1', p_amount: '10.00', p_currency: 'usd' });
    } finally { await app.close(); }
  });

  test('Ungültige, abgelaufene oder veränderte Signatur → 400, nichts gutgeschrieben', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const bad = signed(completedEvent, { secret: 'whsec_falsch' });
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: bad.raw, headers: { 'stripe-signature': bad.header } })).status, 400);
      const old = signed(completedEvent, { t: Math.floor(Date.now() / 1000) - 3600 });
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: old.raw, headers: { 'stripe-signature': old.header } })).status, 400);
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: JSON.stringify(completedEvent) })).status, 400);
      const ok = signed(completedEvent);
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: ok.raw.replace('cs_test_1', 'cs_test_2'), headers: { 'stripe-signature': ok.header } })).status, 400);
      assert.equal(s.rpc.length, 0);
    } finally { await app.close(); }
  });

  test('Noch nicht bezahlt → keine Gutschrift; Live-Ereignis mit Test-Key → ignoriert', async () => {
    const s = setup({ paymentStatus: 'unpaid' });
    const app = await startApp({ handlers: s.handlers });
    try {
      await post(app, completedEvent);
      await post(app, { ...completedEvent, id: 'evt_live', livemode: true });
      assert.equal(s.rpc.filter((x) => x.name === 'confirm_purchase').length, 0);
    } finally { await app.close(); }
  });

  test('Rückerstattung in USD und abgelaufener Checkout', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      await post(app, { id: 'evt_2', type: 'charge.refunded', livemode: false, data: { object: { currency: 'usd', amount_refunded: 450, payment_intent: 'pi_1' } } });
      assert.deepEqual(s.rpc.at(-1), { name: 'refund_payment', a: { p_payment_id: 'pi_1', p_refunded_total: '4.50' } });
      await post(app, { id: 'evt_3', type: 'checkout.session.expired', livemode: false, data: { object: { id: 'cs_test_1', mode: 'payment' } } });
      assert.deepEqual(s.rpc.at(-1), { name: 'mark_purchase', a: { p_checkout_id: 'cs_test_1', p_status: 'expired' } });
    } finally { await app.close(); }
  });
});

test.describe('Stripe: Abo mit Monats-Credits', () => {
  test('Abo-Checkout: monatlich, USD, Nutzer und Plan in den Abo-Metadaten', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const r = await app.call('POST', '/v1/subscription/checkout', { token: signToken(), body: { planId: PLAN } });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      const f = s.stripeCalls[0].form;
      assert.equal(f.mode, 'subscription');
      assert.equal(f['line_items[0][price_data][recurring][interval]'], 'month');
      assert.equal(f['line_items[0][price_data][unit_amount]'], '1000');
      assert.equal(f['line_items[0][price_data][currency]'], 'usd');
      assert.equal(f['subscription_data[metadata][user_id]'], USER_A);
      assert.equal(f['subscription_data[metadata][plan_id]'], PLAN);
      assert.equal(r.data.plan.monthlyCredits, '1000.000000');
      // unbekannter Plan
      assert.equal((await app.call('POST', '/v1/subscription/checkout', { token: signToken(), body: { planId: PACKAGE } })).status, 404);
    } finally { await app.close(); }
  });

  test('Schon ein aktives Abo → 409 statt zweitem Abo; Portal öffnet für Kunden', async () => {
    const s = setup({ existingSub: { status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' } });
    const app = await startApp({ handlers: s.handlers });
    try {
      const r = await app.call('POST', '/v1/subscription/checkout', { token: signToken(), body: { planId: PLAN } });
      assert.equal(r.status, 409);
      assert.equal(r.data.error.code, 'already_subscribed');
      const portal = await app.call('POST', '/v1/subscription/portal', { token: signToken() });
      assert.equal(portal.status, 201);
      assert.equal(portal.data.portalUrl, 'https://billing.stripe.com/p/session/x');
      assert.equal(s.stripeCalls.at(-1).form.customer, 'cus_1');
    } finally { await app.close(); }
  });

  test('Portal ohne Abo → 404', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      assert.equal((await app.call('POST', '/v1/subscription/portal', { token: signToken() })).status, 404);
    } finally { await app.close(); }
  });

  test('Abo-Checkout abgeschlossen → Abo übernommen, aber noch keine Credits (die kommen mit invoice.paid)', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      await post(app, { id: 'evt_s1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_sub_1', mode: 'subscription' } } });
      const up = s.rpc.find((x) => x.name === 'upsert_subscription');
      assert.equal(up.a.p_user_id, USER_A);
      assert.equal(up.a.p_plan_id, PLAN);
      assert.equal(up.a.p_subscription_id, 'sub_1');
      assert.equal(up.a.p_customer_id, 'cus_1');
      assert.equal(up.a.p_status, 'active');
      assert.equal(s.rpc.filter((x) => x.name === 'grant_subscription_credits').length, 0);
      assert.equal(s.rpc.filter((x) => x.name === 'confirm_purchase').length, 0);
    } finally { await app.close(); }
  });

  test('invoice.paid → Rechnung bei Stripe nachgeprüft → Monats-Credits aus dem Plan bis Periodenende', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      await post(app, { id: 'evt_i1', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_1' } } });
      assert.ok(s.stripeCalls.some((c) => c.path === '/v1/invoices/in_1'));
      const g = s.rpc.find((x) => x.name === 'grant_subscription_credits');
      assert.deepEqual(g.a, { p_user_id: USER_A, p_invoice_id: 'in_1', p_credits: '1000.000000', p_period_end: new Date(s.periodEnd * 1000).toISOString() });
    } finally { await app.close(); }
  });

  test('Rechnung noch offen → keine Credits; Abo ohne gültigen Nutzer → ignoriert', async () => {
    const open = setup({ invoiceStatus: 'open' });
    const app1 = await startApp({ handlers: open.handlers });
    try {
      await post(app1, { id: 'evt_i2', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_1' } } });
      assert.equal(open.rpc.filter((x) => x.name === 'grant_subscription_credits').length, 0);
    } finally { await app1.close(); }
    const foreign = setup({ subUser: 'kein-uuid' });
    const app2 = await startApp({ handlers: foreign.handlers });
    try {
      await post(app2, { id: 'evt_i3', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_1' } } });
      assert.equal(foreign.rpc.length, 0);
    } finally { await app2.close(); }
  });

  test('Abo gekündigt/beendet → Zustand übernommen und Abo-Guthaben verfällt', async () => {
    const s = setup({ subStatus: 'canceled' });
    const app = await startApp({ handlers: s.handlers });
    try {
      await post(app, { id: 'evt_d1', type: 'customer.subscription.deleted', livemode: false, data: { object: { id: 'sub_1' } } });
      assert.equal(s.rpc.find((x) => x.name === 'upsert_subscription').a.p_status, 'canceled');
      assert.deepEqual(s.rpc.find((x) => x.name === 'end_subscription_credits').a, { p_user_id: USER_A, p_reference: 'end:sub_1:evt_d1' });
    } finally { await app.close(); }
  });
});

test.describe('Stripe Live-Modus', () => {
  test('eingeschränkter Live-Key (rk_live_) verarbeitet Live-Ereignisse, Test-Ereignisse werden ignoriert', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers, config: { stripe: { secretKey: 'rk_live_restrictedkey0000', webhookSecret: SECRET, apiBase: 'https://api.stripe.test', successUrl: 'https://buddy-island.top/kauf/danke', cancelUrl: 'https://buddy-island.top/kauf/abgebrochen' } } });
    try {
      await post(app, { ...completedEvent, id: 'evt_test_mode', livemode: false });
      assert.equal(s.rpc.length, 0);
      await post(app, { ...completedEvent, id: 'evt_live', livemode: true });
      assert.equal(s.rpc.filter((x) => x.name === 'confirm_purchase').length, 1);
    } finally { await app.close(); }
  });
});

test.describe('Beträge exakt', () => {
  test('Dollar ↔ Cent und Summen ohne Fliesskomma', () => {
    assert.equal(dollarsToCents('10.00'), 1000);
    assert.equal(dollarsToCents('0.1'), 10);
    assert.equal(dollarsToCents('19.95'), 1995);
    assert.equal(centsToDollars(1995), '19.95');
    assert.equal(centsToDollars(5), '0.05');
    assert.throws(() => dollarsToCents('1e3'));
    assert.throws(() => dollarsToCents('1.234'));
    assert.equal(add('0.100000', '0.200000'), '0.300000');
    assert.equal(add('12345678901234.123456', '0.000001'), '12345678901234.123457');
    assert.throws(() => verifySignature(Buffer.from('{}'), 't=1,v1=00', ''));
  });
});
