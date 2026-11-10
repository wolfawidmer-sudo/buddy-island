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
assert.strictEqual(store.STARTUP_SETTINGS, 'ms-settings:startupapps');

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
    const man = fs.readFileSync(cfg.appx.customManifestPath, 'utf8');
    assert.ok(/<uap3:Capability Name="userNotificationListener"/.test(man), 'uap3-Namensraum für Mitteilungen');
    assert.ok(/xmlns:uap3=/.test(man));
    assert.ok(/<DeviceCapability Name="microphone"/.test(man));
    // Reihenfolge laut Schema: Capability vor DeviceCapability
    assert.ok(man.indexOf('uap3:Capability') < man.indexOf('DeviceCapability'));
    // alle Platzhalter, die electron-builder kennt (sonst bricht der Build ab)
    const known = ['publisher', 'publisherDisplayName', 'version', 'applicationId', 'identityName', 'executable', 'displayName', 'description', 'backgroundColor', 'logo', 'square150x150Logo', 'square44x44Logo', 'lockScreen', 'defaultTile', 'splashScreen', 'arch', 'resourceLanguages', 'capabilities', 'extensions', 'minVersion', 'maxVersionTested'];
    for (const [, k] of man.matchAll(/\$\{([a-zA-Z0-9]+)\}/g)) assert.ok(known.includes(k), `unbekannter Platzhalter ${k}`);
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

// Paket-Familienname und echter Daten-Ordner (AppData-Umleitung im Paket)
{
  const exe = 'C:\\Program Files\\WindowsApps\\12345WolfWidmer.BuddyIsland_0.14.3.0_x64__abc123xyz\\app\\Buddy Island.exe';
  assert.strictEqual(store.packageFamilyName(exe), '12345WolfWidmer.BuddyIsland_abc123xyz');
  assert.strictEqual(store.packageFamilyName('C:\\Users\\w\\AppData\\Local\\Programs\\buddy-island\\Buddy Island.exe'), null);
  assert.strictEqual(store.packageFamilyName(''), null);
  const o = { execPath: exe, userData: '/u/AppData/Roaming/Buddy Island', appData: '/u/AppData/Roaming', localAppData: '/u/AppData/Local' };
  const want = path.join('/u/AppData/Local', 'Packages', '12345WolfWidmer.BuddyIsland_abc123xyz', 'LocalCache', 'Roaming', 'Buddy Island');
  assert.strictEqual(store.realDataDir({ ...o, exists: (p) => p === want }), want);
  assert.strictEqual(store.realDataDir({ ...o, exists: () => false }), o.userData, 'ohne umgeleiteten Ordner: normaler Pfad');
  assert.strictEqual(store.realDataDir({ ...o, execPath: 'C:\\x\\Buddy Island.exe', exists: () => true }), o.userData);
  console.log('Store-Pfade ok');
}
