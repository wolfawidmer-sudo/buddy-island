// Microsoft-Store-Version: Erkennung, Autostart-Skript, Vosk im Paket, «Antwort melden», Paket-Konfiguration
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const vosk = require('../src/vosk');

// Erkennung
assert.strictEqual(store.isStore({ platform: 'win32', windowsStore: true }), true);
assert.strictEqual(store.isStore({ platform: 'win32' }), false);
assert.strictEqual(store.isStore({ platform: 'linux', windowsStore: true }), false);

// Autostart-Skript: gleiche TaskId wie im Manifest, nur bekannte Aktionen
const ext = fs.readFileSync(path.join(__dirname, '..', 'build', 'appx-extensions.xml'), 'utf8');
assert.ok(ext.includes(`TaskId="${store.STARTUP_TASK_ID}"`), 'TaskId im Manifest passt');
assert.ok(/Enabled="false"/.test(ext), 'Autostart im Paket standardmässig aus');
assert.ok(ext.includes('Executable="app\\Buddy Island.exe"'));
assert.ok(store.startupTaskScript('enable').includes('RequestEnableAsync'));
assert.ok(store.startupTaskScript('disable').includes('.Disable()'));
assert.ok(!store.startupTaskScript('query').includes('RequestEnableAsync'));
assert.throws(() => store.startupTaskScript('rm -rf'));
assert.deepStrictEqual(store.parseStartupTask('{"state":"Enabled"}\r\n'), { state: 'Enabled', enabled: true, blocked: false, error: null });
assert.strictEqual(store.parseStartupTask('{"state":"DisabledByUser"}').blocked, true);
assert.strictEqual(store.parseStartupTask('{"state":"DisabledByPolicy"}').blocked, true);
assert.strictEqual(store.parseStartupTask('{"state":"Disabled"}').blocked, false);
assert.strictEqual(store.parseStartupTask('Müll').state, 'Error');
assert.strictEqual(store.parseStartupTask('{"state":"Error","error":"x"}').error, 'x');

// Vosk: mit Laufzeit im Paket nur das Modell laden
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const res = path.join(tmp, 'resources');
  assert.strictEqual(store.bundledVoskDir(res), null);
  assert.strictEqual(store.bundledVoskDir(undefined), null);
  fs.mkdirSync(path.join(res, 'vosk'), { recursive: true });
  fs.writeFileSync(path.join(res, 'vosk', 'libvosk.dll'), 'x');
  const bundled = store.bundledVoskDir(res);
  assert.strictEqual(bundled, path.join(res, 'vosk'));

  const root = path.join(tmp, 'vosk-data');
  const model = vosk.MODELS.de;
  const fetched = [];
  const zipBytes = Buffer.from('modell');
  const fakeModel = { ...model };
  // Prüfsumme des Test-Downloads einsetzen
  const sha = require('crypto').createHash('sha256').update(zipBytes).digest('hex');
  vosk.MODELS.de = { ...model, sha256: sha, size: zipBytes.length };
  const fetchImpl = async (url) => {
    fetched.push(url);
    return new Response(zipBytes);
  };
  const unzip = async (_zip, dest) => {
    fs.mkdirSync(path.join(dest, model.name, 'am'), { recursive: true });
    fs.writeFileSync(path.join(dest, model.name, 'am', 'final.mdl'), 'x');
  };
  const p = await vosk.ensure({ root, lang: 'de', bundled, fetchImpl, unzip });
  assert.strictEqual(fetched.length, 1, 'nur das Modell geladen');
  assert.ok(!fetched[0].includes('pythonhosted'), 'keine Laufzeit (Code) nachgeladen');
  assert.strictEqual(p.dllDir, bundled);
  assert.deepStrictEqual(vosk.installed(root, 'de', bundled), p);
  assert.strictEqual(vosk.installed(root, 'de'), null, 'ohne Paket-Laufzeit fehlt die DLL');
  vosk.MODELS.de = fakeModel;
  fs.rmSync(tmp, { recursive: true, force: true });

  // «Antwort melden»: E-Mail-Entwurf an die Kontaktadresse, gekürzt, mit Version
  const long = 'ä'.repeat(5000);
  const link = store.reportMailto({ question: 'Wie spät?', answer: long, version: '0.14.3', lang: 'de' });
  assert.ok(link.startsWith(`mailto:${store.REPORT_EMAIL}?subject=`));
  const body = decodeURIComponent(link.split('&body=')[1]);
  assert.ok(body.includes('Wie spät?'));
  assert.ok(body.includes('Buddy Island 0.14.3'));
  assert.ok(body.length < 1300, 'gekürzt');
  assert.ok(decodeURIComponent(store.reportMailto({ answer: 'a', version: '1', lang: 'fr' })).includes('Signaler'));
  assert.ok(decodeURIComponent(store.reportMailto({ answer: 'a', version: '1', lang: 'xx' })).includes('Report'));

  // Paket-Konfiguration: verlangt die Partner-Center-Werte, kein Update-Kanal, Fähigkeiten
  const cfgPath = require.resolve('../electron-builder.store.js');
  const keep = { ...process.env };
  delete process.env.STORE_IDENTITY_NAME;
  assert.throws(() => require(cfgPath), /STORE_IDENTITY_NAME/);
  delete require.cache[cfgPath];
  Object.assign(process.env, { STORE_IDENTITY_NAME: 'Test.BuddyIsland', STORE_PUBLISHER: 'CN=TEST', STORE_PUBLISHER_NAME: 'Test' });
  const hasVendor = fs.existsSync(path.join(__dirname, '..', 'vendor', 'vosk', 'libvosk.dll'));
  if (hasVendor) {
    const cfg = require(cfgPath);
    assert.strictEqual(cfg.publish, null);
    assert.deepStrictEqual(cfg.win.target, [{ target: 'appx', arch: ['x64'] }]);
    assert.ok(cfg.appx.capabilities.includes('microphone'));
    assert.ok(cfg.appx.capabilities.includes('userNotificationListener'));
    assert.strictEqual(cfg.appx.addAutoLaunchExtension, false);
    assert.ok(fs.existsSync(path.join(__dirname, '..', cfg.appx.customExtensionsPath)));
  } else {
    assert.throws(() => require(cfgPath), /vendor\/vosk/);
  }
  process.env = keep;

  // Kachelbilder vorhanden, Installer-Build packt sie nicht ein
  for (const n of ['StoreLogo', 'Square44x44Logo', 'Square150x150Logo', 'Wide310x150Logo']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'appx', `${n}.scale-100.png`)), n);
  }
  assert.ok(require('../package.json').build.files.includes('!assets/appx/**'));

  console.log('Store-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
