// Tests für Modelle/Preise, Kostenstatistik, Verlauf, Berechtigungen und Update-Signaturen
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const models = require('../src/models');
const { createUsage } = require('../src/usage');
const { createHistory } = require('../src/history');
const permissions = require('../src/permissions');
const sec = require('../src/update-security');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-core-'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ---------- Modelle und Preise ----------
near(models.costOf('claude-haiku-5-5', { input_tokens: 100000 }), 0.01);
near(models.costOf('claude-haiku-5-5', { output_tokens: 1e6 }), 0.50);
near(models.costOf('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 12);
near(models.costOf('claude-opus-5-5', { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 5.2);
// Haiku über 100k Prompt-Tokens: teurerer Tarif
near(models.costOf('claude-haiku-5-5', { input_tokens: 150000 }), 150000 * 0.5 / 1e6);
assert.strictEqual(models.tierOf('claude-sonnet-5-5'), 'sonnet');
assert.strictEqual(models.tierOf('claude-opus-6-0'), 'opus');
assert.deepStrictEqual(models.resolveTiers([]), { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' });
assert.deepStrictEqual(models.resolveTiers([{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }]), { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' });
assert.strictEqual(models.resolveTiers(['claude-opus-6-0', 'claude-haiku-5-5']).opus, 'claude-opus-6-0');
assert.strictEqual(models.supportedEffort('claude-haiku-5-5', 'auto'), null);
assert.strictEqual(models.supportedEffort('claude-haiku-5-5', 'high'), 'high');
assert.strictEqual(models.supportedEffort('claude-unknown-1-0', 'max'), 'high');
assert.strictEqual(models.nextTier('haiku'), 'sonnet');
assert.strictEqual(models.nextTier('opus'), null);
assert.strictEqual(models.maxTokensFor('high', 4096), 16000);

// ---------- Kosten und Limit ----------
let now = new Date(2026, 10, 11, 12, 0).getTime(); // 11. November, Mittag
const usageFile = path.join(tmp, 'usage.json');
const usage = createUsage({ file: usageFile, now: () => now });
const c1 = usage.record({ model: 'claude-sonnet-5-5', usage: { input_tokens: 100000, output_tokens: 10000 }, purpose: 'Antwort' });
near(c1, 0.3);
usage.record({ model: 'claude-haiku-5-5', usage: { input_tokens: 2000, output_tokens: 300 }, purpose: 'Router' });
let sum = usage.summary(1);
assert.strictEqual(sum.totals.requests, 2);
assert.strictEqual(sum.models[0].name, 'Sonnet 5.5');
assert.strictEqual(sum.budget.level, 'ok');
assert.ok(sum.estimate > sum.totals.cost, 'Hochrechnung grösser als bisher');
assert.strictEqual(usage.budget(0.35).level, 'warn');
assert.strictEqual(usage.budget(0.31).level, 'tight');
assert.strictEqual(usage.budget(0.2).level, 'blocked');
assert.strictEqual(usage.budget(0).level, 'none');
usage.flush();
const reloaded = createUsage({ file: usageFile, now: () => now });
assert.strictEqual(reloaded.summary(0).totals.requests, 2, 'Statistik bleibt nach Neustart');
assert.strictEqual(reloaded.summary(0).session.requests, 0, 'Sitzung beginnt neu');
now = new Date(2026, 11, 2, 12, 0).getTime(); // neuer Monat
assert.strictEqual(reloaded.spentThisMonth(), 0);
reloaded.reset();

// ---------- Verlauf ----------
const histFile = path.join(tmp, 'history.json');
const history = createHistory({ file: histFile });
const t = history.start({ id: 'a1', title: '  Räum   meinen Desktop auf ', route: { model: 'claude-sonnet-5-5' } });
t.useModel('claude-sonnet-5-5');
t.useModel('claude-sonnet-5-5');
t.useModel('claude-haiku-5-5');
t.step('file', '3 Dateien verschoben', 'ok');
t.addCost(0.01, { input_tokens: 10, output_tokens: 5 });
t.escalate('claude-haiku-5-5', 'claude-sonnet-5-5', 'Fehler');
t.finish('done', { verified: true });
history.flush();
const h2 = createHistory({ file: histFile }).list();
assert.strictEqual(h2[0].title, 'Räum meinen Desktop auf');
assert.deepStrictEqual(h2[0].models, ['claude-sonnet-5-5', 'claude-haiku-5-5']);
assert.strictEqual(h2[0].status, 'done');
assert.strictEqual(h2[0].tokens.input, 10);
const off = createHistory({ file: path.join(tmp, 'h-off.json'), enabled: () => false });
off.start({ id: 'x', title: 'geheim' });
assert.strictEqual(off.list().length, 0, 'Verlauf aus speichert nichts');

// ---------- Berechtigungen ----------
const cls = (name, input, computer) => permissions.classify({ name, input, ...(computer ? { toolset_name: 'computer' } : {}) });
assert.strictEqual(cls('screenshot', {}, true).level, 'low');
assert.strictEqual(cls('left_click', { coordinate: [1, 2] }, true).category, 'control');
assert.strictEqual(cls('type', { text: 'Hallo Welt' }, true).level, 'medium');
assert.strictEqual(cls('type', { text: 'Remove-Item C:\\Users\\x -Recurse' }, true).category, 'delete');
assert.strictEqual(cls('type', { text: 'Set-MpPreference -DisableRealtimeMonitoring $true' }, true).category, 'security');
assert.strictEqual(cls('type', { text: 'reg add HKLM\\Software\\X' }, true).category, 'admin');
assert.strictEqual(cls('type', { text: 'winget install Spotify' }, true).category, 'install');
assert.strictEqual(cls('type', { text: 'winget install Spotify' }, true).level, 'medium');
assert.strictEqual(cls('type', { text: 'netsh advfirewall set allprofiles state off' }, true).level, 'high');
assert.strictEqual(cls('key', { text: 'shift+Delete' }, true).level, 'high');
assert.strictEqual(cls('key', { text: 'ctrl+c' }, true).level, 'medium');
assert.strictEqual(cls('list_files', { folder: 'Desktop' }).level, 'low');
assert.strictEqual(cls('move_files', { moves: [] }).level, 'medium');
assert.strictEqual(cls('delete_files', { paths: [] }).level, 'high');
assert.strictEqual(cls('open_app', { app: 'editor' }).level, 'low');
assert.strictEqual(cls('irgendwas', {}).level, 'medium', 'Unbekanntes vorsichtig');
assert.strictEqual(cls('request_permission', { action: 'Firewall ändern', risk: 'high', category: 'security' }).category, 'security');

const policy = permissions.cleanPolicy({});
const dec = (r, p = policy, g = {}) => permissions.decide(r, p, g);
assert.strictEqual(dec(cls('screenshot', {}, true)), 'allow');
assert.strictEqual(dec(cls('left_click', {}, true)), 'ask-control');
assert.strictEqual(dec(cls('left_click', {}, true), policy, { control: true }), 'allow');
assert.strictEqual(dec(cls('left_click', {}, true), policy, { control: false }), 'deny');
assert.strictEqual(dec(cls('move_files', {})), 'ask');
assert.strictEqual(dec(cls('move_files', {}), policy, { medium: true }), 'allow');
assert.strictEqual(dec(cls('move_files', {}), { medium: 'allow', high: 'ask' }), 'allow');
assert.strictEqual(dec(cls('delete_files', {}), { medium: 'allow', high: 'ask' }, { medium: true, control: true }), 'ask', 'Hohes Risiko nie automatisch');
assert.strictEqual(dec(cls('delete_files', {}), { medium: 'allow', high: 'block' }), 'deny');
assert.deepStrictEqual(permissions.cleanPolicy({ medium: 'yolo', high: 'allow' }), { medium: 'ask', high: 'ask' }, 'Hoch kann nie «erlauben» sein');

// ---------- Update-Signaturen ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keys = { [sec.keyIdOf(pubPem)]: pubPem };
const manifest = sec.sign({ app: 'buddy-island', version: '0.3.0', file: 'BuddyIsland-Setup-0.3.0.exe', sha512: 'abc', size: 1, minWindowsBuild: 17763, arch: 'x64', minUpdateFrom: '0.2.0', created: 'x' }, privPem);
assert.ok(sec.verifyManifest(manifest, { version: '0.3.0', sha512: 'abc' }, keys).ok);
assert.ok(!sec.verifyManifest({ ...manifest, sha512: 'evil' }, {}, keys).ok, 'veränderte Prüfsumme');
assert.ok(!sec.verifyManifest({ ...manifest, version: '9.9.9' }, {}, keys).ok, 'veränderte Version');
assert.ok(!sec.verifyManifest(manifest, { version: '0.3.1' }, keys).ok, 'falsche Version');
assert.ok(!sec.verifyManifest(manifest, {}, sec.PUBLIC_KEYS).ok, 'fremder Schlüssel');
assert.ok(!sec.verifyManifest({ ...manifest, app: 'other' }, {}, keys).ok);
assert.ok(!sec.verifyManifest(null).ok);
// Ein fremder Schlüssel mit gleicher keyId darf nicht durchkommen
const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const forged = { ...sec.sign({ ...manifest, signature: undefined }, other), keyId: manifest.keyId };
assert.ok(!sec.verifyManifest(forged, {}, keys).ok, 'gefälschte Signatur');
assert.ok(sec.checkCompatibility(manifest, { osRelease: '10.0.22631', arch: 'x64', currentVersion: '0.2.0', platform: 'win32' }).ok);
assert.ok(!sec.checkCompatibility(manifest, { osRelease: '10.0.10240', arch: 'x64', currentVersion: '0.2.0', platform: 'win32' }).ok);
assert.ok(!sec.checkCompatibility(manifest, { osRelease: '10.0.22631', arch: 'arm64', currentVersion: '0.2.0', platform: 'win32' }).ok);
assert.ok(!sec.checkCompatibility(manifest, { osRelease: '10.0.22631', arch: 'x64', currentVersion: '0.1.0', platform: 'win32' }).ok);
assert.strictEqual(sec.compareVersions('0.10.0', '0.9.9'), 1);
assert.strictEqual(sec.compareVersions('0.3.0', '0.3.0'), 0);
assert.ok(sec.isAllowedUrl('https://github.com/wolfawidmer-sudo/buddy-island/releases/download/v0.3.0/x'));
assert.ok(sec.isAllowedUrl('https://objects.githubusercontent.com/abc'));
assert.ok(!sec.isAllowedUrl('http://github.com/x'), 'nur HTTPS');
assert.ok(!sec.isAllowedUrl('https://github.com.evil.example/x'));
const yml = 'version: 0.3.0\nfiles:\n  - url: BuddyIsland-Setup-0.3.0.exe\n    sha512: Zm9v\n    size: 1234\npath: BuddyIsland-Setup-0.3.0.exe\nsha512: Zm9v\nreleaseDate: \'2026-11-03T10:00:00.000Z\'\n';
assert.deepStrictEqual(sec.parseLatestYml(yml), { version: '0.3.0', file: 'BuddyIsland-Setup-0.3.0.exe', sha512: 'Zm9v', size: 1234, releaseDate: '2026-11-03T10:00:00.000Z' });

(async () => {
  const f = path.join(tmp, 'blob.bin');
  fs.writeFileSync(f, 'Buddy');
  assert.strictEqual(await sec.sha512File(f), crypto.createHash('sha512').update('Buddy').digest('base64'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Kern-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
