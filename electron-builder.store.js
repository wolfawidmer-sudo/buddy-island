// Microsoft-Store-Paket (MSIX/AppX). Baut nur auf Windows (makeappx aus dem Windows SDK).
//
//   STORE_IDENTITY_NAME=…  STORE_PUBLISHER="CN=…"  STORE_PUBLISHER_NAME=…  npm run dist:store
//
// Die drei Werte stehen in Partner Center › Buddy Island › Product management › Product identity
// («Package/Identity/Name», «Package/Identity/Publisher», «Package/Properties/PublisherDisplayName»).
// Das Paket wird NICHT signiert: Partner Center signiert es beim Einreichen selbst.
// Die Vosk-Laufzeit muss vorher in vendor/vosk liegen (scripts/fetch-vosk-runtime.js).

const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

const need = ['STORE_IDENTITY_NAME', 'STORE_PUBLISHER', 'STORE_PUBLISHER_NAME'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) throw new Error(`Für das Store-Paket fehlt: ${missing.join(', ')} (Werte aus Partner Center › Product identity)`);
if (!/^CN=/.test(process.env.STORE_PUBLISHER)) throw new Error('STORE_PUBLISHER muss mit «CN=» beginnen.');
if (!fs.existsSync(path.join(__dirname, 'vendor', 'vosk', 'libvosk.dll'))) throw new Error('vendor/vosk/libvosk.dll fehlt: zuerst node scripts/fetch-vosk-runtime.js');

const base = pkg.build;
module.exports = {
  ...base,
  // Kein eigener Update-Kanal im Store-Paket (kein app-update.yml)
  publish: null,
  extraResources: [{ from: 'vendor/vosk', to: 'vosk', filter: ['*.dll'] }],
  win: { ...base.win, target: [{ target: 'appx', arch: ['x64'] }] },
  appx: {
    identityName: process.env.STORE_IDENTITY_NAME,
    publisher: process.env.STORE_PUBLISHER,
    publisherDisplayName: process.env.STORE_PUBLISHER_NAME,
    applicationId: 'BuddyIsland',
    displayName: 'Buddy Island',
    backgroundColor: 'transparent',
    languages: ['de-DE', 'en-US', 'fr-FR'],
    // Fähigkeiten (Mikrofon für Sprache/Wakeword, Windows-Mitteilungen im Island) stehen fest
    // in build/appxmanifest.xml, weil electron-builder userNotificationListener falsch schreibt.
    customManifestPath: path.join(__dirname, 'build', 'appxmanifest.xml'),
    addAutoLaunchExtension: false,
    customExtensionsPath: 'build/appx-extensions.xml',
    // Windows 10 1809 als Minimum, getestet bis Windows 11 24H2
    minVersion: '10.0.17763.0',
    maxVersionTested: '10.0.26100.0',
    artifactName: 'BuddyIsland-Store-${version}.${ext}',
  },
};
