// Umstellung auf «nur Buddy Cloud» beim Start (src/cloud-only.js): erster Start,
// bestehende Nutzer mit und ohne eigene Keys, wiederholter Start, Modelle.
const assert = require('assert');
const { migrateToCloudOnly, LEGACY_SECRETS } = require('../src/cloud-only');
const models = require('../src/models');

const opts = { isCloudModel: (id) => models.providerOf(id) === 'buddy', defaultModel: models.resolveTiers([], 'buddy').sonnet };
const fresh = () => ({ provider: 'buddy', model: opts.defaultModel, onboarded: false, cloudNotice: null, usageLocal: false, keyHints: {}, keyStatus: {} });

// 1) Erster Start: keine gespeicherten Einstellungen → Einführung zeigen, nichts ändern
{
  const s = fresh();
  assert.strictEqual(migrateToCloudOnly(s, null, opts), false);
  assert.strictEqual(s.onboarded, false, 'neuer Nutzer sieht die Einführung');
  assert.strictEqual(s.cloudNotice, null);
}

// 2) Bestehender Nutzer mit eigenem Gemini-Key und lokalem Modell: Keys weg, Cloud, Hinweis, keine Einführung
{
  const saved = { provider: 'gemini', model: 'gemini-flash-latest', key_geminiEncrypted: 'abc', keyEncrypted: 'def', anthropicAdminEncrypted: 'x', hfTokenPlain: 'hf_1', localModel: 'qwen3.5:4b', keyHints: { gemini: '1234' }, keyStatus: { gemini: 'ok' }, usageLocal: true, workspaceId: 'wrkspc_1', fallbackModels: ['gemini-flash-lite'] };
  const s = { ...fresh(), ...saved };
  assert.strictEqual(migrateToCloudOnly(s, saved, opts), true);
  assert.strictEqual(s.provider, 'buddy');
  assert.ok(opts.isCloudModel(s.model), `Cloud-Modell statt ${s.model}`);
  for (const n of LEGACY_SECRETS) {
    assert.ok(!s[n + 'Encrypted'] && !s[n + 'Plain'], `${n} gelöscht`);
  }
  assert.deepStrictEqual(s.keyHints, {});
  assert.deepStrictEqual(s.keyStatus, {});
  assert.strictEqual(s.workspaceId, '');
  assert.deepStrictEqual(s.fallbackModels, []);
  assert.strictEqual(s.usageLocal, false);
  assert.strictEqual(s.onboarded, true, 'bestehender Nutzer: keine Einführung');
  assert.strictEqual(s.cloudNotice, 'keys-removed');
}

// 3) Bestehender Nutzer ohne Keys (z. B. schon Buddy Cloud): nur der Hinweis «Neu»
{
  const saved = { provider: 'buddy', model: opts.defaultModel };
  const s = { ...fresh(), ...saved };
  migrateToCloudOnly(s, saved, opts);
  assert.strictEqual(s.onboarded, true);
  assert.strictEqual(s.cloudNotice, 'new-cloud');
}

// 4) Zweiter Start nach der Umstellung: nichts mehr zu tun, Hinweis bleibt quittiert
{
  const saved = { ...fresh(), onboarded: true, cloudNotice: null };
  const s = { ...saved };
  assert.strictEqual(migrateToCloudOnly(s, saved, opts), false);
  assert.strictEqual(s.cloudNotice, null, 'quittierter Hinweis kommt nicht wieder');
}

// 5) Einführung abgebrochen (onboarded=false gespeichert): beim nächsten Start wieder Einführung
{
  const saved = { ...fresh(), onboarded: false };
  const s = { ...saved };
  migrateToCloudOnly(s, saved, opts);
  assert.strictEqual(s.onboarded, false);
}

// 6) Der Cloud-Session-Speicher bleibt unangetastet (sonst wäre man nach jedem Start abgemeldet)
{
  const saved = { ...fresh(), onboarded: true, cloudSessionEncrypted: 'session' };
  const s = { ...saved };
  migrateToCloudOnly(s, saved, opts);
  assert.strictEqual(s.cloudSessionEncrypted, 'session');
}

console.log('Nur-Cloud-Tests ok (erster Start, bestehende Nutzer mit/ohne Keys, wiederholter Start, Sitzung bleibt)');
