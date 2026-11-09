'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, signToken, json, USER_A } = require('./helpers');
const { chfToRappen, rappenToChf, verifySignature } = require('../src/services/stripe');

const SECRET = 'whsec_testsecret000000';
const PURCHASE = '33333333-3333-4333-8333-333333333333';
const PACKAGE = '44444444-4444-4444-8444-444444444444';

function signed(event, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { raw, header: `t=${t},v1=${sig}` };
}

function setup({ paymentStatus = 'paid' } = {}) {
  const rpc = [];
  const stripeCalls = [];
  return {
    rpc,
    stripeCalls,
    handlers: {
      supabaseRpc: (name, a) => {
        rpc.push({ name, a });
        if (name === 'create_purchase') return json(200, { id: PURCHASE, amount_chf: '10.00', credits_purchased: '1000.000000', status: 'pending' });
        if (name === 'attach_checkout') return json(200, { id: PURCHASE });
        if (name === 'complete_purchase') return json(200, { id: PURCHASE, status: 'completed' });
        if (name === 'refund_purchase') return json(200, { id: PURCHASE, status: 'partially_refunded' });
        if (name === 'mark_purchase') return json(200, { id: PURCHASE, status: a.p_status });
        return json(404, {});
      },
      stripe: (method, path, form, headers) => {
        stripeCalls.push({ method, path, form: Object.fromEntries(form), headers });
        if (method === 'POST' && path === '/v1/checkout/sessions') return json(200, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
        if (method === 'GET' && path === '/v1/checkout/sessions/cs_test_1') {
          return json(200, { id: 'cs_test_1', payment_status: paymentStatus, amount_total: 1000, currency: 'chf', payment_intent: 'pi_1', metadata: { purchase_id: PURCHASE }, client_reference_id: PURCHASE });
        }
        return json(404, { error: { code: 'resource_missing' } });
      },
    },
  };
}

const completedEvent = { id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_1', payment_status: 'paid' } } };

test.describe('Stripe', () => {
  test('Checkout: Preis aus der Datenbank, CHF in Rappen, Idempotency-Key, Kauf verknüpft', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const r = await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { packageId: PACKAGE } });
      assert.equal(r.status, 201);
      assert.equal(r.data.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
      assert.equal(r.data.amountChf, '10.00');
      assert.equal(r.data.credits, '1000.000000');
      assert.deepEqual(s.rpc[0], { name: 'create_purchase', a: { p_user_id: USER_A, p_package_id: PACKAGE } });
      const c = s.stripeCalls[0];
      assert.equal(c.form['line_items[0][price_data][unit_amount]'], '1000');
      assert.equal(c.form['line_items[0][price_data][currency]'], 'chf');
      assert.equal(c.form['metadata[purchase_id]'], PURCHASE);
      assert.equal(c.headers['idempotency-key'], `checkout-${PURCHASE}`);
      assert.deepEqual(s.rpc[1], { name: 'attach_checkout', a: { p_purchase_id: PURCHASE, p_checkout_id: 'cs_test_1' } });
      // Client darf keinen Preis mitschicken
      assert.equal((await app.call('POST', '/v1/purchases/checkout', { token: signToken(), body: { packageId: PACKAGE, priceChf: '0.01' } })).status, 400);
    } finally { await app.close(); }
  });

  test('Webhook mit gültiger Signatur: Zahlung bei Stripe nachgeprüft, dann gutgeschrieben', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const { raw, header } = signed(completedEvent);
      const r = await app.call('POST', '/webhooks/stripe', { raw, headers: { 'stripe-signature': header, 'content-type': 'application/json' } });
      assert.equal(r.status, 200);
      assert.equal(s.stripeCalls[0].path, '/v1/checkout/sessions/cs_test_1');
      const done = s.rpc.find((x) => x.name === 'complete_purchase');
      assert.deepEqual(done.a, { p_purchase_id: PURCHASE, p_checkout_id: 'cs_test_1', p_payment_id: 'pi_1', p_amount_chf: '10.00', p_currency: 'chf' });
    } finally { await app.close(); }
  });

  test('Ungültige oder abgelaufene Signatur → 400, nichts gutgeschrieben', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const bad = signed(completedEvent, { secret: 'whsec_falsch' });
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: bad.raw, headers: { 'stripe-signature': bad.header } })).status, 400);
      const old = signed(completedEvent, { t: Math.floor(Date.now() / 1000) - 3600 });
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: old.raw, headers: { 'stripe-signature': old.header } })).status, 400);
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: JSON.stringify(completedEvent) })).status, 400);
      // Body nach dem Signieren verändert
      const ok = signed(completedEvent);
      const tampered = ok.raw.replace('cs_test_1', 'cs_test_2');
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw: tampered, headers: { 'stripe-signature': ok.header } })).status, 400);
      assert.equal(s.rpc.length, 0);
    } finally { await app.close(); }
  });

  test('Noch nicht bezahlt (z. B. Überweisung) → keine Gutschrift', async () => {
    const s = setup({ paymentStatus: 'unpaid' });
    const app = await startApp({ handlers: s.handlers });
    try {
      const { raw, header } = signed(completedEvent);
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw, headers: { 'stripe-signature': header } })).status, 200);
      assert.equal(s.rpc.filter((x) => x.name === 'complete_purchase').length, 0);
    } finally { await app.close(); }
  });

  test('Live-Ereignis mit Test-Key wird ignoriert', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const { raw, header } = signed({ ...completedEvent, livemode: true });
      assert.equal((await app.call('POST', '/webhooks/stripe', { raw, headers: { 'stripe-signature': header } })).status, 200);
      assert.equal(s.rpc.length, 0);
    } finally { await app.close(); }
  });

  test('Rückerstattung und abgelaufener Checkout', async () => {
    const s = setup();
    const app = await startApp({ handlers: s.handlers });
    try {
      const refund = signed({ id: 'evt_2', type: 'charge.refunded', livemode: false, data: { object: { currency: 'chf', amount_refunded: 450, payment_intent: 'pi_1' } } });
      await app.call('POST', '/webhooks/stripe', { raw: refund.raw, headers: { 'stripe-signature': refund.header } });
      assert.deepEqual(s.rpc.at(-1), { name: 'refund_purchase', a: { p_payment_id: 'pi_1', p_refunded_total_chf: '4.50' } });
      const expired = signed({ id: 'evt_3', type: 'checkout.session.expired', livemode: false, data: { object: { id: 'cs_test_1' } } });
      await app.call('POST', '/webhooks/stripe', { raw: expired.raw, headers: { 'stripe-signature': expired.header } });
      assert.deepEqual(s.rpc.at(-1), { name: 'mark_purchase', a: { p_checkout_id: 'cs_test_1', p_status: 'expired' } });
    } finally { await app.close(); }
  });

  test('CHF ↔ Rappen ohne Fliesskomma', () => {
    assert.equal(chfToRappen('10.00'), 1000);
    assert.equal(chfToRappen('0.1'), 10);
    assert.equal(chfToRappen('19.95'), 1995);
    assert.equal(rappenToChf(1995), '19.95');
    assert.equal(rappenToChf(5), '0.05');
    assert.throws(() => chfToRappen('1e3'));
    assert.throws(() => verifySignature(Buffer.from('{}'), 't=1,v1=00', ''));
  });
});
