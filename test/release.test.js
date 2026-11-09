// Build-Herkunft: Schlüsselnachweis, Build-Nachweis, asar-Leser, Vergleich veränderter
// Kopien, Updates. Nur Testschlüssel, der echte private Schlüssel wird nie gebraucht.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pv = require('../scripts/lib/provenance');
const sec = require('../src/update-security');

const ROOT = path.join(__dirname, '..');
const pem = (k) => k.export({ type: 'pkcs8', format: 'pem' });
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const KEY = pem(privateKey);
const PUB = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
const KEY_ID = sec.keyIdOf(PUB);
const KEYS = { [KEY_ID]: PUB };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-prov-'));

// Minimaler asar-Schreiber (gleiches Format wie @electron/asar)
function writeAsar(file, entries) {
  const header = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [p, content] of Object.entries(entries)) {
    const parts = p.split('/');
    let node = header;
    for (const dir of parts.slice(0, -1)) node = (node.files[dir] ||= { files: {} });
    const buf = Buffer.from(content);
    node.files[parts.at(-1)] = { size: buf.length, offset: String(offset) };
    blobs.push(buf);
    offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(pickle.length, 4);
  fs.writeFileSync(file, Buffer.concat([head, pickle, ...blobs]));
}

(async () => {
  // ---------- 1. Schlüsselnachweis ----------
  const a = pv.createKeyProof(KEY);
  const b = pv.createKeyProof(KEY);
  assert.strictEqual(a.proof, b.proof, 'Ed25519 deterministisch: jeder Build setzt denselben Wert ein');
  assert.strictEqual(a.keyId, KEY_ID);
  assert.strictEqual(Buffer.from(a.proof, 'base64').length, 64, 'nur 64 Byte in der App');
  const ok = pv.verifyKeyProof(a.keyId, a.proof, KEYS);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.github, 'wolfawidmer-sudo');
  assert.strictEqual(ok.githubId, '241971406');
  assert.strictEqual(pv.verifyKeyProof(a.keyId, a.proof, KEYS, { ...pv.OWNER, github: 'someone-else' }).ok, false, 'anderes GitHub-Konto → ungültig');
  assert.strictEqual(pv.verifyKeyProof(a.keyId, a.proof, sec.PUBLIC_KEYS).ok, false, 'Testschlüssel ist nicht der echte');
  assert.strictEqual(pv.verifyKeyProof(a.keyId, '', KEYS).ok, false, 'leer → kein Nachweis');
  // Ein fremder Schlüssel kann keinen Nachweis für Wolfs keyId fälschen
  const other = pem(crypto.generateKeyPairSync('ed25519').privateKey);
  assert.strictEqual(pv.verifyKeyProof(KEY_ID, pv.createKeyProof(other).proof, KEYS).ok, false);

  // Getrennte Kontexte: eine Update-Signatur taugt nicht als Nachweis und umgekehrt
  const upd = sec.sign({ app: 'buddy-island', version: '1.0.0', file: 'x.exe', sha512: 'abc' }, KEY);
  assert.strictEqual(pv.verifyKeyProof(KEY_ID, upd.signature, KEYS).ok, false);

  // ---------- 2. Einsetzen in update-security.js ----------
  const source = fs.readFileSync(path.join(ROOT, 'src/update-security.js'), 'utf8');
  assert.deepStrictEqual(pv.extractKeyProofs(source), {}, 'im Repo ist der Wert leer');
  assert.ok(/KEY_PROOFS = \{ '72db1fd0b545': '' \}/.test(source), 'Eintrag für den echten Schlüssel vorhanden');
  const testSource = source.replace("'72db1fd0b545': ''", `'72db1fd0b545': '', '${KEY_ID}': ''`);
  const stamped = pv.injectKeyProof(testSource, KEY_ID, a.proof);
  assert.deepStrictEqual(pv.extractKeyProofs(stamped), { [KEY_ID]: a.proof });
  assert.strictEqual(pv.injectKeyProof(stamped, KEY_ID, a.proof), stamped, 'zweimal einsetzen ändert nichts');
  assert.throws(() => pv.injectKeyProof(source, 'ffffffffffff', a.proof), /fehlt/);
  // Die App lädt die Datei mit Nachweis normal, Update-Prüfung unverändert
  const stampedFile = path.join(tmp, 'update-security.js');
  fs.writeFileSync(stampedFile, stamped.replace("require('crypto')", "require('crypto')"));
  const loaded = require(stampedFile);
  assert.strictEqual(loaded.KEY_PROOFS[KEY_ID], a.proof);
  assert.strictEqual(loaded.verifyManifest(upd, {}, KEYS).ok, true, 'Update-Signaturen gehen weiter');

  // ---------- 3. asar lesen ----------
  const v1 = {
    'package.json': JSON.stringify({ name: 'buddy-island', version: '0.13.0' }),
    'src/main.js': 'console.log("main")',
    'src/update-security.js': stamped,
    'src/renderer/app.js': 'app()',
    'assets/empty.txt': '',
  };
  const asar1 = path.join(tmp, 'v1.asar');
  writeAsar(asar1, v1);
  const read = pv.inspectAsar(asar1, ['package.json', 'src/update-security.js']);
  assert.deepStrictEqual(Object.keys(read.files).sort(), Object.keys(v1).sort());
  for (const [p, c] of Object.entries(v1)) assert.strictEqual(read.files[p], crypto.createHash('sha256').update(c).digest('hex'), p);
  assert.strictEqual(read.contents['src/update-security.js'].toString(), stamped);
  const bad = path.join(tmp, 'bad.asar');
  fs.writeFileSync(bad, 'kein asar');
  assert.throws(() => pv.inspectAsar(bad), /asar/);

  // ---------- 4. Build-Nachweis ----------
  const prov = pv.createProvenance(KEY, { version: '0.13.0', files: read.files, asarSha256: await pv.sha256File(asar1), installer: 'BuddyIsland-Setup-0.13.0.exe', installerSha512: 'xyz' });
  assert.strictEqual(pv.verifyProvenance(prov, KEYS).ok, true);
  assert.strictEqual(prov.ownerId, pv.ownerIdFrom(KEY), 'Besitzer-ID aus dem Schlüssel');
  assert.strictEqual(prov.ownerId.length, 32);
  assert.notStrictEqual(pv.ownerIdFrom(other), prov.ownerId, 'anderer Schlüssel → andere ID');
  assert.strictEqual(prov.github, 'wolfawidmer-sudo');
  assert.strictEqual(pv.verifyProvenance({ ...prov, version: '9.9.9' }, KEYS).ok, false, 'Version geändert → ungültig');
  assert.strictEqual(pv.verifyProvenance({ ...prov, github: 'x' }, KEYS).ok, false, 'Konto geändert → ungültig');
  assert.strictEqual(pv.verifyProvenance({ ...prov, files: { ...prov.files, 'src/main.js': '0'.repeat(64) } }, KEYS).ok, false, 'Dateiliste geändert → ungültig');
  assert.strictEqual(pv.verifyProvenance(prov, sec.PUBLIC_KEYS).ok, false, 'fremder Schlüssel nicht anerkannt');
  assert.strictEqual(pv.verifyProvenance(JSON.parse(JSON.stringify(prov)), KEYS).ok, true, 'übersteht JSON-Speichern');

  // ---------- 5. Veränderte Kopie: welche Dateien stammen vom Original ----------
  const fork = path.join(tmp, 'fork.asar');
  writeAsar(fork, { ...v1, 'src/main.js': 'console.log("fork")', 'src/extra.js': '1' });
  const cmp = pv.compareFiles(pv.inspectAsar(fork).files, prov.files);
  assert.deepStrictEqual(cmp.changed, ['src/main.js']);
  assert.deepStrictEqual(cmp.added, ['src/extra.js']);
  assert.strictEqual(cmp.same.length, 4);
  assert.strictEqual(pv.filesRoot(pv.inspectAsar(asar1).files), prov.filesRoot);

  // ---------- 6. Update: neue Version, gleicher Nachweis ----------
  const asar2 = path.join(tmp, 'v2.asar');
  writeAsar(asar2, { ...v1, 'package.json': JSON.stringify({ name: 'buddy-island', version: '0.14.0' }), 'src/main.js': 'neu' });
  const r2 = pv.inspectAsar(asar2, ['src/update-security.js']);
  const proofs2 = pv.extractKeyProofs(r2.contents['src/update-security.js']);
  assert.strictEqual(pv.verifyKeyProof(KEY_ID, proofs2[KEY_ID], KEYS).ok, true, 'Nachweis überlebt das Update');
  const prov2 = pv.createProvenance(KEY, { version: '0.14.0', files: r2.files, asarSha256: await pv.sha256File(asar2) });
  assert.strictEqual(pv.verifyProvenance(prov2, KEYS).ok, true);
  assert.strictEqual(prov2.ownerId, prov.ownerId, 'Besitzer-ID bleibt über Versionen gleich');
  assert.notStrictEqual(prov2.asarSha256, prov.asarSha256);

  // ---------- 7. Werkzeug (CLI) ----------
  const cli = (args, env = {}) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'scripts/provenance.js'), ...args], { env: { ...process.env, BUDDY_UPDATE_SIGNING_KEY: '', ...env }, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  assert.strictEqual(cli(['stamp']).code, 2, 'ohne Schlüssel: Exit 2, nichts geändert');
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'src/update-security.js'), 'utf8'), source);
  const keyFile = path.join(tmp, 'k.pem');
  fs.writeFileSync(keyFile, KEY);
  assert.notStrictEqual(cli(['stamp', '--key', keyFile]).code, 0, 'falscher Schlüssel wird abgelehnt');
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'src/update-security.js'), 'utf8'), source, 'Quelltext unverändert');
  // Kopie ohne Nachweis und ohne Build-Nachweis → UNBEKANNT
  const plain = path.join(tmp, 'plain.asar');
  writeAsar(plain, { 'package.json': '{"version":"0.0.1"}', 'src/update-security.js': source });
  const u = cli(['verify', plain, '--offline']);
  assert.strictEqual(u.code, 1);
  assert.ok(/UNBEKANNT/.test(u.out), u.out);
  // Gefälschter Build-Nachweis (anderer Schlüssel) wird nicht anerkannt
  fs.writeFileSync(path.join(tmp, 'prov.json'), JSON.stringify(prov));
  const f = cli(['verify', asar1, '--provenance', path.join(tmp, 'prov.json')]);
  assert.strictEqual(f.code, 1);
  assert.ok(/ungültig/.test(f.out), f.out);

  // ---------- 8. Ganzer Release-Ablauf mit Testschlüssel (Kopie des Repos) ----------
  {
    const repo = path.join(tmp, 'repo');
    fs.cpSync(path.join(ROOT, 'src'), path.join(repo, 'src'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(repo, 'package.json'));
    const secFile = path.join(repo, 'src/update-security.js');
    fs.writeFileSync(secFile, fs.readFileSync(secFile, 'utf8')
      .replace("const PUBLIC_KEYS = {", `const PUBLIC_KEYS = {\n  '${KEY_ID}': ${JSON.stringify(PUB)},`)
      .replace("'72db1fd0b545': '' }", `'72db1fd0b545': '', '${KEY_ID}': '' }`));
    const run = (args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [path.join(repo, 'scripts/provenance.js'), ...args], { env: { ...process.env, BUDDY_UPDATE_SIGNING_KEY: KEY }, encoding: 'utf8', stdio: 'pipe' }) };
      } catch (err) {
        return { code: err.status, out: `${err.stdout}${err.stderr}` };
      }
    };
    assert.strictEqual(run(['stamp']).code, 0);
    assert.strictEqual(pv.extractKeyProofs(fs.readFileSync(secFile, 'utf8'))[KEY_ID], a.proof, 'stamp setzt den Nachweis ein');
    // «Build»: app.asar aus src + package.json, wie electron-builder (scripts/ kommt nicht mit)
    const entries = { 'package.json': fs.readFileSync(path.join(repo, 'package.json')) };
    const walk = (dir, prefix) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${prefix}/${e.name}`;
        if (e.isDirectory()) walk(path.join(dir, e.name), p);
        else entries[p] = fs.readFileSync(path.join(dir, e.name));
      }
    };
    walk(path.join(repo, 'src'), 'src');
    assert.ok(!Object.keys(entries).some((p) => p.startsWith('scripts/')), 'Werkzeug nicht in der App');
    assert.ok(!Object.values(entries).some((c) => /provenance|wolfawidmer-sudo\/buddy-island\/releases|241971406/.test(c.toString())), 'App enthält kein Wort zum Herkunftsnachweis');
    const unpacked = path.join(repo, 'dist/win-unpacked/resources');
    fs.mkdirSync(unpacked, { recursive: true });
    writeAsar(path.join(unpacked, 'app.asar'), entries);
    const latest = path.join(repo, 'dist/latest.yml');
    fs.writeFileSync(latest, `version: ${JSON.parse(entries['package.json']).version}\npath: BuddyIsland-Setup-x.exe\nsha512: abc\n`);
    const out = path.join(repo, 'dist/provenance.json');
    const at = run(['attest', '--asar', path.join(unpacked, 'app.asar'), '--latest', latest, '--out', out]);
    assert.strictEqual(at.code, 0, at.out);
    const ve = run(['verify', path.join(repo, 'dist/win-unpacked'), '--provenance', out]);
    assert.strictEqual(ve.code, 0, ve.out);
    assert.ok(/ECHT/.test(ve.out) && /wolfawidmer-sudo \(Konto-ID 241971406\)/.test(ve.out), ve.out);
    // Veränderte Kopie desselben Builds → ABGELEITET mit Dateiliste
    writeAsar(path.join(tmp, 'mod.asar'), { ...entries, 'src/main.js': 'verändert' });
    const vm = run(['verify', path.join(tmp, 'mod.asar'), '--provenance', out]);
    assert.strictEqual(vm.code, 3, vm.out);
    assert.ok(/ABGELEITET/.test(vm.out) && /src\/main\.js/.test(vm.out), vm.out);
    // Kopie mit Nachweis, aber ohne Build-Nachweis → ABGELEITET (Herkunft belegt)
    const vo = run(['verify', path.join(unpacked, 'app.asar'), '--offline']);
    assert.strictEqual(vo.code, 3, vo.out);
    // Ohne Nachweis eingesetzt: attest verweigert
    writeAsar(path.join(tmp, 'nostamp.asar'), { ...entries, 'src/update-security.js': source });
    assert.notStrictEqual(run(['attest', '--asar', path.join(tmp, 'nostamp.asar'), '--out', path.join(tmp, 'x.json')]).code, 0);
    console.log(`  Release-Ablauf: ${ve.out.split('\n')[0]}`);
  }

  // ---------- 9. Echtes asar-Format (nur wenn @electron/asar installiert ist, z. B. im CI) ----------
  let asarLib = null;
  try { asarLib = require('@electron/asar'); } catch { /* lokal ohne npm */ }
  if (asarLib && typeof asarLib.createPackage === 'function') {
    const srcDir = path.join(tmp, 'app');
    fs.cpSync(path.join(ROOT, 'src'), path.join(srcDir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(srcDir, 'package.json'));
    const real = path.join(tmp, 'real.asar');
    await asarLib.createPackage(srcDir, real);
    const got = pv.inspectAsar(real).files;
    const expected = {};
    const walk = (dir, prefix) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), p);
        else expected[p] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex');
      }
    };
    walk(srcDir, '');
    assert.deepStrictEqual(got, expected, 'echtes asar von @electron/asar korrekt gelesen');
    console.log(`  echtes asar: ${Object.keys(got).length} Dateien korrekt gelesen`);
  } else {
    console.log('  (@electron/asar nicht installiert: Test mit echtem asar übersprungen)');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('release.test.js: alle Tests bestanden');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
