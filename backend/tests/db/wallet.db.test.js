// Datenbank-Tests gegen ein echtes PostgreSQL (lokal, mit Supabase-Nachbau).
// Start: BUDDY_TEST_PG="-h /tmp/pg -p 54329 -U postgres" node --test tests/db/
// Ohne BUDDY_TEST_PG wird die Datei übersprungen (kein Postgres vorhanden).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PG = process.env.BUDDY_TEST_PG;
const DB = 'buddy_wallet_test';
const root = path.resolve(__dirname, '..', '..', '..');

const skip = !PG && 'BUDDY_TEST_PG nicht gesetzt';
const args = (PG || '').split(/\s+/).filter(Boolean);

function psqlSync(sql, db = DB) {
  return execFileSync('psql', [...args, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** SQL ausführen, optional als Rolle mit auth.uid(). Gibt { ok, out, err } zurück. */
function sql(query, { role, sub } = {}) {
  const pre = [
    role ? `set role ${role};` : '',
    sub ? `set request.jwt.claim.sub = '${sub}';` : '',
  ].join('');
  return new Promise((resolve) => {
    execFile('psql', [...args, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', `${pre}${query}`], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr).trim() });
    });
  });
}

async function must(query, opts) {
  const r = await sql(query, opts);
  if (!r.ok) throw new Error(`${query}\n${r.err}`);
  return r.out;
}

async function newUser(name = 'Test') {
  return must(`insert into auth.users (email, raw_user_meta_data) values ('${name.toLowerCase()}@example.com', '{"full_name":"${name}","avatar_url":"javascript:alert(1)"}') returning id`);
}

async function wallet(uid) {
  const out = await must(`select available_credits, reserved_credits, lifetime_purchased, lifetime_consumed from public.wallets where user_id = '${uid}'`);
  const [available, reserved, purchased, consumed] = out.split('|');
  return { available, reserved, purchased, consumed };
}

async function fund(uid, credits) {
  return must(`select public.adjust_credits('${uid}', ${credits}, 'test-fund-${uid}-${Date.now()}-${Math.random()}', 'Testguthaben')`);
}

test.describe('Buddy Credits Datenbank', { skip }, () => {
  test.before(() => {
    execFileSync('psql', [...args, '-d', 'postgres', '-qc', `drop database if exists ${DB}`], { stdio: 'ignore' });
    execFileSync('psql', [...args, '-d', 'postgres', '-qc', `create database ${DB}`], { stdio: 'ignore' });
    execFileSync('psql', [...args, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-qf', path.join(__dirname, 'supabase-stub.sql')], { stdio: 'ignore' });
    const dir = path.join(root, 'supabase', 'migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      execFileSync('psql', [...args, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-qf', path.join(dir, f)], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    // Testpreise (nicht die echten): 1 USD = 0.8 CHF, 1 CHF = 100 BC, Modell 2/8 USD je 1M, Cache 0.5
    psqlSync(`update public.billing_settings set usd_to_chf = 0.8, credits_per_chf = 100`);
    psqlSync(`insert into public.model_pricing (model_id, input_price, output_price, cached_input_price, audio_pricing, effective_from)
              values ('test-model', 2, 8, 0.5, '{"input_per_1m": 32, "output_per_1m": 64}', now() - interval '1 day')`);
    psqlSync(`insert into public.credit_packages (id, name, price_chf, credits, display_order) values ('00000000-0000-0000-0000-0000000000a1', 'Test 10', 10.00, 1000, 1)`);
  });

  test('neuer Nutzer bekommt Profil und Wallet, unsichere Avatar-URL wird verworfen', async () => {
    const uid = await newUser('Anna');
    const p = await must(`select display_name, coalesce(avatar_url, 'NULL') from public.profiles where id = '${uid}'`);
    assert.equal(p, 'Anna|NULL');
    const w = await wallet(uid);
    assert.equal(w.available, '0.000000');
  });

  test('Preisformel: Anbieterkosten + 10 % Aufschlag, exakt, aufgerundet', async () => {
    // 1'000'000 Input davon 200'000 gecacht, 100'000 Output:
    // 800k*2 + 200k*0.5 + 100k*8 = 1.6 + 0.1 + 0.8 = 2.5 USD; +10 % = 2.75 USD; *0.8 = 2.2 CHF; *100 = 220 BC
    const q = await must(`select provider_cost, markup_amount, total_cost, credits from public.billing_quote('test-model', 1000000, 200000, 100000)`);
    assert.equal(q, '2.50000000|0.25000000|2.75000000|220.000000');
    // Winzige Anfrage: 7 Input-Tokens → 0.000014 USD → *1.1*0.8*100 = 0.001232 BC
    const small = await must(`select credits from public.billing_quote('test-model', 7, 0, 0)`);
    assert.equal(small, '0.001232');
    // Audio-Tokens
    const audio = await must(`select provider_cost from public.billing_quote('test-model', 0, 0, 0, '{"input_tokens": 1000, "output_tokens": 500}')`);
    assert.equal(audio, '0.06400000');
  });

  test('unbekanntes Modell und fehlende Umrechnung werden abgelehnt', async () => {
    const r = await sql(`select * from public.billing_quote('nope', 1, 0, 1)`);
    assert.match(r.err, /unknown_model_pricing/);
    await must(`update public.billing_settings set credits_per_chf = null`);
    const r2 = await sql(`select * from public.billing_quote('test-model', 1, 0, 1)`);
    assert.match(r2.err, /billing_not_configured/);
    await must(`update public.billing_settings set credits_per_chf = 100`);
  });

  test('Reservieren, Abrechnen, Rest freigeben', async () => {
    const uid = await newUser('Ben');
    await fund(uid, 10);
    const res = await must(`select amount, available_credits, reserved_credits from public.reserve_credits('${uid}', 'req-ben-0001', 'test-model', 1)`);
    assert.equal(res, '1.000000|9.000000|1.000000');
    // gleiche request_id nochmal → keine zweite Reservierung
    await must(`select * from public.reserve_credits('${uid}', 'req-ben-0001', 'test-model', 1)`);
    assert.deepEqual(await wallet(uid), { available: '9.000000', reserved: '1.000000', purchased: '0.000000', consumed: '0.000000' });
    // 10'000 Input, 1'000 Output: 0.02 + 0.008 = 0.028 USD → 0.0308 → 2.464 BC? Nein: *0.8*100 = 2.464 BC > 1 reserviert → Rest vom Guthaben
    const e = await must(`select credits_charged, status, provider_cost, markup_amount from public.settle_reservation('req-ben-0001', 10000, 0, 1000)`);
    assert.equal(e, '2.464000|settled|0.02800000|0.00280000');
    assert.deepEqual(await wallet(uid), { available: '7.536000', reserved: '0.000000', purchased: '0.000000', consumed: '2.464000' });
    // nochmal abrechnen → idempotent, nichts doppelt
    await must(`select * from public.settle_reservation('req-ben-0001', 10000, 0, 1000)`);
    assert.equal((await wallet(uid)).available, '7.536000');
    const n = await must(`select count(*) from public.wallet_transactions where reference_id = 'req-ben-0001' and transaction_type = 'usage'`);
    assert.equal(n, '1');
  });

  test('zu wenig Guthaben: Reservierung wird abgelehnt, nichts gebucht', async () => {
    const uid = await newUser('Cora');
    await fund(uid, 0.5);
    const r = await sql(`select * from public.reserve_credits('${uid}', 'req-cora-0001', 'test-model', 1)`);
    assert.match(r.err, /insufficient_credits/);
    assert.equal((await wallet(uid)).available, '0.500000');
  });

  test('Abrechnung kostet mehr als vorhanden → nie negativ, Status partial', async () => {
    const uid = await newUser('Dario');
    await fund(uid, 1);
    await must(`select * from public.reserve_credits('${uid}', 'req-dario-001', 'test-model', 1)`);
    const e = await must(`select credits_charged, status from public.settle_reservation('req-dario-001', 1000000, 0, 0)`);
    assert.equal(e, '1.000000|partial');
    assert.equal((await wallet(uid)).available, '0.000000');
  });

  test('Freigeben bei Fehler und abgelaufene Reservierungen', async () => {
    const uid = await newUser('Eva');
    await fund(uid, 5);
    await must(`select * from public.reserve_credits('${uid}', 'req-eva-00001', 'test-model', 2)`);
    await must(`select * from public.release_reservation('req-eva-00001', 'failed', 'OpenAI-Fehler')`);
    await must(`select * from public.release_reservation('req-eva-00001', 'failed', 'OpenAI-Fehler')`); // idempotent
    assert.deepEqual(await wallet(uid), { available: '5.000000', reserved: '0.000000', purchased: '0.000000', consumed: '0.000000' });
    assert.equal(await must(`select status from public.usage_events where request_id = 'req-eva-00001'`), 'failed');
    // abgelaufen
    await must(`select * from public.reserve_credits('${uid}', 'req-eva-00002', 'test-model', 3)`);
    await must(`update public.credit_reservations set expires_at = now() - interval '1 minute' where request_id = 'req-eva-00002'`);
    assert.equal(await must(`select public.release_expired_reservations()`), '1');
    assert.equal((await wallet(uid)).available, '5.000000');
  });

  test('gleichzeitige Anfragen können nicht überziehen (20 parallel, Guthaben für 10)', async () => {
    const uid = await newUser('Finn');
    await fund(uid, 10);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      sql(`select * from public.reserve_credits('${uid}', 'req-finn-${String(i).padStart(4, '0')}', 'test-model', 1)`)));
    const ok = results.filter((r) => r.ok).length;
    const denied = results.filter((r) => /insufficient_credits/.test(r.err)).length;
    assert.equal(ok, 10);
    assert.equal(denied, 10);
    assert.deepEqual(await wallet(uid), { available: '0.000000', reserved: '10.000000', purchased: '0.000000', consumed: '0.000000' });
    // gleichzeitig dieselbe Abrechnung 5× → nur einmal
    await Promise.all(Array.from({ length: 5 }, () => sql(`select * from public.settle_reservation('req-finn-0000', 1000, 0, 0)`)));
    assert.equal(await must(`select count(*) from public.wallet_transactions where reference_id = 'req-finn-0000' and transaction_type = 'usage'`), '1');
  });

  test('Kauf: nur einmal gutgeschrieben, Betrag wird geprüft', async () => {
    const uid = await newUser('Gina');
    const pid = await must(`select id from public.create_purchase('${uid}', '00000000-0000-0000-0000-0000000000a1')`);
    await must(`select id from public.attach_checkout('${pid}', 'cs_test_gina')`);
    const bad = await sql(`select * from public.complete_purchase('${pid}', 'cs_test_gina', 'pi_gina', 9.99, 'chf')`);
    assert.match(bad.err, /amount_mismatch/);
    const eur = await sql(`select * from public.complete_purchase('${pid}', 'cs_test_gina', 'pi_gina', 10.00, 'eur')`);
    assert.match(eur.err, /amount_mismatch/);
    const wrongCheckout = await sql(`select * from public.complete_purchase('${pid}', 'cs_other', 'pi_gina', 10.00, 'chf')`);
    assert.match(wrongCheckout.err, /purchase_not_found/);
    const runs = await Promise.all(Array.from({ length: 4 }, () => sql(`select status from public.complete_purchase('${pid}', 'cs_test_gina', 'pi_gina', 10.00, 'chf')`)));
    assert.ok(runs.every((r) => r.ok && r.out === 'completed'));
    assert.deepEqual(await wallet(uid), { available: '1000.000000', reserved: '0.000000', purchased: '1000.000000', consumed: '0.000000' });
  });

  test('Rückerstattung: anteilig, idempotent, nie negativ', async () => {
    const uid = await newUser('Hugo');
    const pid = await must(`select id from public.create_purchase('${uid}', '00000000-0000-0000-0000-0000000000a1')`);
    await must(`select id from public.attach_checkout('${pid}', 'cs_test_hugo')`);
    await must(`select id from public.complete_purchase('${pid}', 'cs_test_hugo', 'pi_hugo', 10.00, 'chf')`);
    await must(`select status from public.refund_purchase('pi_hugo', 4.00)`);
    await must(`select status from public.refund_purchase('pi_hugo', 4.00)`); // doppelt
    assert.equal((await wallet(uid)).available, '600.000000');
    // Nutzer verbraucht 550, dann volle Rückerstattung: nur 50 abziehbar
    await must(`select public.adjust_credits('${uid}', -550, 'test-spend-hugo', 'Test')`);
    const st = await must(`select status, credits_refunded from public.refund_purchase('pi_hugo', 10.00)`);
    assert.equal(st, 'refunded|1000.000000');
    assert.equal((await wallet(uid)).available, '0.000000');
  });

  test('Buchungen sind unveränderlich', async () => {
    const r = await sql(`update public.wallet_transactions set amount = 999`);
    assert.match(r.err, /immutable_record/);
    const d = await sql(`delete from public.wallet_transactions`);
    assert.match(d.err, /immutable_record/);
  });

  test('RLS: Nutzer sehen nur eigene Daten und können nichts Finanzielles schreiben', async () => {
    const a = await newUser('Ida');
    const b = await newUser('Jan');
    await fund(b, 5);
    const as = { role: 'authenticated', sub: a };
    assert.equal(await must(`select count(*) from public.wallets`, as), '1');
    assert.equal(await must(`select count(*) from public.wallets where user_id = '${b}'`, as), '0');
    assert.equal(await must(`select count(*) from public.wallet_transactions where user_id = '${b}'`, as), '0');
    assert.equal(await must(`select count(*) from public.profiles where id = '${b}'`, as), '0');

    const upd = await sql(`update public.wallets set available_credits = 1000000 where user_id = '${a}'`, as);
    assert.equal(upd.ok, false);
    assert.match(upd.err, /permission denied/);
    const ins = await sql(`insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id) select '${a}', id, 'purchase', 100, 100, 'x' from public.wallets where user_id = '${a}'`, as);
    assert.match(ins.err, /permission denied/);
    const rpc = await sql(`select * from public.reserve_credits('${a}', 'req-ida-00001', 'test-model', 1)`, as);
    assert.match(rpc.err, /permission denied/);
    const credit = await sql(`select public.adjust_credits('${a}', 100, 'hack', 'hack')`, as);
    assert.match(credit.err, /permission denied/);
    const pricing = await sql(`select * from public.model_pricing`, as);
    assert.match(pricing.err, /permission denied/);
    const settings = await sql(`select * from public.billing_settings`, as);
    assert.match(settings.err, /permission denied/);

    // Profil: Name ändern ja, fremdes Profil nein
    await must(`update public.profiles set display_name = 'Ida B.' where id = '${a}'`, as);
    assert.equal(await must(`select display_name from public.profiles where id = '${a}'`), 'Ida B.');
    await must(`update public.profiles set display_name = 'gehackt' where id = '${b}'`, as);
    assert.equal(await must(`select display_name from public.profiles where id = '${b}'`), 'Jan');

    // anon sieht nur aktive Pakete
    assert.equal(await must(`select count(*) from public.credit_packages`, { role: 'anon' }), '1');
    const anonWallet = await sql(`select * from public.wallets`, { role: 'anon' });
    assert.match(anonWallet.err, /permission denied/);
  });
});
