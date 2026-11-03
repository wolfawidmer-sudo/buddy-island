// Sicherheit für das bestehende Update-System (electron-updater über GitHub Releases):
// Jedes Release enthält eine signierte Datei update-signature.json. Buddy installiert
// ein Update nur, wenn die Ed25519-Signatur mit dem hier eingebauten öffentlichen
// Schlüssel stimmt, die SHA-512-Prüfsumme der heruntergeladenen Datei passt und die
// Version und Windows-Version kompatibel sind. Der private Schlüssel liegt nur als
// GitHub-Secret beim Projekt, nie im Code.

const crypto = require('crypto');
const fs = require('fs');

// Öffentliche Schlüssel (mehrere möglich, damit ein Schlüsselwechsel ohne Bruch geht)
const PUBLIC_KEYS = {
  // Öffentlicher Schlüssel und seine ID: kein Geheimnis
  '72db1fd0b545': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAikuWbB7YhjNdIKn1fw6O/kLyCQU5wlIDXSW+uCG8b3M=\n-----END PUBLIC KEY-----\n', // pragma: allowlist secret
};

const SIGNED_FIELDS = ['app', 'version', 'file', 'sha512', 'size', 'minWindowsBuild', 'arch', 'minUpdateFrom', 'created', 'keyId'];
const APP_ID = 'buddy-island';
const MANIFEST_NAME = 'update-signature.json';
const ALLOWED_HOSTS = /^(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|[a-z0-9-]+\.githubusercontent\.com)$/i;

function canonical(manifest) {
  return ['buddy-island-update-v1', ...SIGNED_FIELDS.map((k) => `${k}=${manifest[k] ?? ''}`)].join('\n');
}

function keyIdOf(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 12);
}

function sign(manifest, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const withKey = { ...manifest, keyId: keyIdOf(pub) };
  const signature = crypto.sign(null, Buffer.from(canonical(withKey)), key).toString('base64');
  return { ...withKey, signature };
}

// Semver-Vergleich für x.y.z (ohne Vorabversionen)
function compareVersions(a, b) {
  const pa = String(a || '0').split('-')[0].split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0').split('-')[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// Prüft Signatur und Inhalt. expect: { version, sha512 }
function verifyManifest(manifest, expect = {}, keys = PUBLIC_KEYS) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'Signaturdatei fehlt oder ist unlesbar.' };
  if (manifest.app !== APP_ID) return { ok: false, error: 'Die Signaturdatei gehört nicht zu Buddy Island.' };
  const pem = keys[manifest.keyId];
  if (!pem) return { ok: false, error: 'Unbekannter Signaturschlüssel.' };
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(canonical(manifest)), crypto.createPublicKey(pem), Buffer.from(String(manifest.signature || ''), 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'Die Signatur ist ungültig. Das Update stammt eventuell nicht vom Entwickler.' };
  if (expect.version && manifest.version !== expect.version) return { ok: false, error: `Versionsnummer passt nicht (${manifest.version} statt ${expect.version}).` };
  if (expect.sha512 && manifest.sha512 !== expect.sha512) return { ok: false, error: 'Prüfsumme passt nicht zur Signatur.' };
  return { ok: true };
}

// Kompatibilität: Windows-Version, Architektur, direkte Aktualisierung möglich?
function checkCompatibility(manifest, { osRelease = '', arch = 'x64', currentVersion = '0.0.0', platform = 'win32' } = {}) {
  if (platform !== 'win32') return { ok: false, error: 'Updates gibt es nur für Windows.' };
  const build = Number(String(osRelease).split('.')[2] || 0);
  if (manifest.minWindowsBuild && build && build < Number(manifest.minWindowsBuild)) {
    return { ok: false, error: `Diese Version braucht mindestens Windows-Build ${manifest.minWindowsBuild} (du hast ${build}).` };
  }
  if (manifest.arch && manifest.arch !== arch) return { ok: false, error: `Das Update ist für ${manifest.arch}, dein PC ist ${arch}.` };
  if (manifest.minUpdateFrom && compareVersions(currentVersion, manifest.minUpdateFrom) < 0) {
    return { ok: false, error: `Von Version ${currentVersion} geht kein direktes Update. Bitte den Installer von der Website nehmen.` };
  }
  return { ok: true };
}

// SHA-512 einer Datei, base64 (wie in latest.yml von electron-builder)
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')));
  });
}

// Liest version, path, sha512 und size aus latest.yml (ohne YAML-Bibliothek)
function parseLatestYml(text) {
  const top = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9]*):\s*'?([^']*)'?\s*$/);
    if (m) top[m[1]] = m[2];
  }
  const size = String(text).match(/^\s+size:\s*(\d+)/m);
  return { version: top.version, file: top.path, sha512: top.sha512, size: size ? Number(size[1]) : 0, releaseDate: top.releaseDate };
}

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  PUBLIC_KEYS, MANIFEST_NAME, APP_ID, canonical, sign, verifyManifest, checkCompatibility, compareVersions,
  sha512File, parseLatestYml, isAllowedUrl, keyIdOf,
};
