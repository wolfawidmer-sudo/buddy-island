#!/usr/bin/env node
// Signiert ein Release für Buddys Update-Prüfung.
//   Signieren:  BUDDY_UPDATE_SIGNING_KEY="<PEM>" node scripts/sign-update.js dist/latest.yml dist/update-signature.json
//   Prüfen:     node scripts/sign-update.js --verify update-signature.json latest.yml [installer.exe]
// Der private Schlüssel kommt nur aus der Umgebung (GitHub-Secret), nie aus einer Datei im Repo.

const fs = require('fs');
const { sign, verifyManifest, parseLatestYml, sha512File, APP_ID } = require('../src/update-security');

const MIN_WINDOWS_BUILD = 17763; // Windows 10, Version 1809
const MIN_UPDATE_FROM = '0.2.0';

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--verify') {
    const manifest = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const latest = parseLatestYml(fs.readFileSync(args[2], 'utf8'));
    const result = verifyManifest(manifest, { version: latest.version, sha512: latest.sha512 });
    if (!result.ok) throw new Error(result.error);
    if (args[3]) {
      const hash = await sha512File(args[3]);
      if (hash !== manifest.sha512) throw new Error('Prüfsumme des Installers passt nicht.');
    }
    console.log(`Signatur gültig für ${manifest.version} (${manifest.file}).`);
    return;
  }

  const [latestPath, outPath] = args;
  if (!latestPath || !outPath) throw new Error('Aufruf: sign-update.js <latest.yml> <ausgabe.json>');
  const pem = (process.env.BUDDY_UPDATE_SIGNING_KEY || '').replace(/\\n/g, '\n').trim();
  if (!pem) {
    console.error('Kein Signierschlüssel (BUDDY_UPDATE_SIGNING_KEY) gesetzt.');
    process.exit(2);
  }
  const latest = parseLatestYml(fs.readFileSync(latestPath, 'utf8'));
  if (!latest.version || !latest.sha512 || !latest.file) throw new Error('latest.yml ist unvollständig.');
  const manifest = sign({
    app: APP_ID,
    version: latest.version,
    file: latest.file,
    sha512: latest.sha512,
    size: latest.size,
    minWindowsBuild: MIN_WINDOWS_BUILD,
    arch: 'x64',
    minUpdateFrom: MIN_UPDATE_FROM,
    created: new Date().toISOString(),
  }, `${pem}\n`);
  const check = verifyManifest(manifest, { version: latest.version, sha512: latest.sha512 });
  if (!check.ok) throw new Error(`Selbstprüfung fehlgeschlagen: ${check.error} (passt der Schlüssel zum eingebauten öffentlichen Schlüssel?)`);
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Signiert: ${manifest.version} (${manifest.file}), Schlüssel ${manifest.keyId}`);
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
