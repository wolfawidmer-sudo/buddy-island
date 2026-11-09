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
    run(DB, ['-c', `update public.billing_settings set usd_to_chf = 0.8, credits_per_chf = 100;
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
});
