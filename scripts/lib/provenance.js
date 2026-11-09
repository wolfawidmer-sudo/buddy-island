// Build-Herkunft (provenance) für Buddy Island. Wird nicht in die App gepackt.
//
// Zwei Nachweise, beide mit dem Update-Schlüssel signiert, jeweils mit eigenem
// Kontext-Präfix, damit keine Signatur für einen anderen Zweck taugt:
//
//  1. Schlüsselnachweis: eine Signatur über Besitzer, GitHub-Konto (Name + feste ID)
//     und Repo. Steht als einzelner Wert in KEY_PROOFS in src/update-security.js
//     der ausgelieferten App (wird beim Release-Build eingesetzt). Reist in jeder
//     Kopie und jedem Update mit.
//  2. Build-Nachweis (provenance.json am Release): SHA-256 von app.asar und jeder
//     Datei darin, Version, Installer-Prüfsumme, Besitzer-ID. Ordnet eine installierte
//     Kopie Byte für Byte einem offiziellen Release zu und zeigt bei veränderten
//     Kopien, welche Dateien vom Original stammen.

const crypto = require('crypto');
const fs = require('fs');
const { PUBLIC_KEYS, APP_ID, keyIdOf } = require('../../src/update-security');

const OWNER = {
  owner: 'Wolf Widmer',
  github: 'wolfawidmer-sudo',
  githubId: '241971406', // feste GitHub-Konto-Nummer, bleibt bei Umbenennung gleich
  repository: 'https://github.com/wolfawidmer-sudo/buddy-island',
};
const PROOF_CONTEXT = 'buddy-island-key-proof-v1';
const BUILD_CONTEXT = 'buddy-island-build-provenance-v1';
const PROOF_FIELDS = ['app', 'owner', 'github', 'githubId', 'repository', 'keyId'];
const BUILD_FIELDS = ['app', 'version', 'owner', 'github', 'githubId', 'ownerId', 'keyId', 'asarSha256', 'filesRoot', 'fileCount', 'installer', 'installerSha512', 'created'];
const PROVENANCE_NAME = 'provenance.json';
const KEY_FILE = 'src/update-security.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const canonicalOf = (context, fields, obj) => [context, ...fields.map((k) => `${k}=${obj[k] ?? ''}`)].join('\n');
const pubPem = (privateKeyPem) => crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });

function verifySig(context, fields, obj, signature, keys) {
  const pem = keys[obj.keyId];
  if (!pem) return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalOf(context, fields, obj)), crypto.createPublicKey(pem), Buffer.from(String(signature || ''), 'base64'));
  } catch {
    return false;
  }
}

// Besitzer-ID: HMAC mit dem privaten Schlüssel. Immer gleich, ohne Schlüssel nicht herleitbar.
function ownerIdFrom(privateKeyPem) {
  const der = crypto.createPrivateKey(privateKeyPem).export({ type: 'pkcs8', format: 'der' });
  return crypto.createHmac('sha256', der).update(`${PROOF_CONTEXT}/owner-id`).digest('hex').slice(0, 32);
}

// --- 1. Schlüsselnachweis -----------------------------------------------------

function proofBody(keyId, owner = OWNER) {
  return { app: APP_ID, ...owner, keyId };
}

// Ed25519 ist deterministisch: gleicher Schlüssel → immer derselbe Wert
function createKeyProof(privateKeyPem, owner = OWNER) {
  const keyId = keyIdOf(pubPem(privateKeyPem));
  const sig = crypto.sign(null, Buffer.from(canonicalOf(PROOF_CONTEXT, PROOF_FIELDS, proofBody(keyId, owner))), crypto.createPrivateKey(privateKeyPem));
  return { keyId, proof: sig.toString('base64') };
}

function verifyKeyProof(keyId, proof, keys = PUBLIC_KEYS, owner = OWNER) {
  if (!proof) return { ok: false, error: 'Kein Schlüsselnachweis in dieser Kopie.' };
  if (!verifySig(PROOF_CONTEXT, PROOF_FIELDS, proofBody(keyId, owner), proof, keys)) return { ok: false, error: 'Schlüsselnachweis ungültig.' };
  return { ok: true, keyId, ...owner };
}

// Liest KEY_PROOFS aus dem Quelltext von update-security.js
function extractKeyProofs(source) {
  const block = String(source).match(/KEY_PROOFS\s*=\s*\{([^}]*)\}/);
  const out = {};
  if (!block) return out;
  for (const m of block[1].matchAll(/'([0-9a-f]{12})'\s*:\s*'([A-Za-z0-9+/=]*)'/g)) if (m[2]) out[m[1]] = m[2];
  return out;
}

// Setzt den Nachweis in den Quelltext ein (nur im Build-Ordner, nicht committet)
function injectKeyProof(source, keyId, proof) {
  const re = new RegExp(`(KEY_PROOFS\\s*=\\s*\\{[^}]*'${keyId}'\\s*:\\s*')[A-Za-z0-9+/=]*(')`);
  if (!re.test(source)) throw new Error(`KEY_PROOFS-Eintrag für ${keyId} fehlt in ${KEY_FILE}.`);
  return source.replace(re, `$1${proof}$2`);
}

// --- 2. Build-Nachweis ---------------------------------------------------------

function filesRoot(files) {
  const h = crypto.createHash('sha256');
  for (const p of Object.keys(files).sort()) h.update(`${p}\0${files[p]}\n`);
  return h.digest('hex');
}

function createProvenance(privateKeyPem, { version, asarSha256, files, installer = '', installerSha512 = '', created }, owner = OWNER) {
  const body = {
    app: APP_ID, version, ...owner,
    ownerId: ownerIdFrom(privateKeyPem),
    keyId: keyIdOf(pubPem(privateKeyPem)),
    asarSha256, filesRoot: filesRoot(files), fileCount: Object.keys(files).length,
    installer, installerSha512, created: created || new Date().toISOString(),
  };
  const signature = crypto.sign(null, Buffer.from(canonicalOf(BUILD_CONTEXT, BUILD_FIELDS, body)), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { ...body, signature, files };
}

function verifyProvenance(p, keys = PUBLIC_KEYS) {
  if (!p || p.app !== APP_ID) return { ok: false, error: 'Kein Buddy-Island-Build-Nachweis.' };
  if (!verifySig(BUILD_CONTEXT, BUILD_FIELDS, p, p.signature, keys)) return { ok: false, error: 'Signatur des Build-Nachweises ungültig.' };
  if (!p.files || filesRoot(p.files) !== p.filesRoot || Object.keys(p.files).length !== Number(p.fileCount)) {
    return { ok: false, error: 'Dateiliste passt nicht zur signierten Wurzel.' };
  }
  return { ok: true };
}

function compareFiles(found, signed) {
  const same = []; const changed = []; const added = [];
  for (const [p, h] of Object.entries(found)) {
    if (!(p in signed)) added.push(p);
    else if (signed[p] === h) same.push(p);
    else changed.push(p);
  }
  return { same, changed, added, missing: Object.keys(signed).filter((p) => !(p in found)) };
}

// --- app.asar lesen (ohne Fremdpaket) -----------------------------------------
// Aufbau: [4][Headergrösse] Pickle([Länge][JSON-Header]), danach die Dateidaten.

function readHeader(fd) {
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  if (head.readUInt32LE(0) !== 4) throw new Error('Keine gültige app.asar.');
  const headerSize = head.readUInt32LE(4);
  if (headerSize > 64 * 1024 * 1024) throw new Error('asar-Header zu gross.');
  const pickle = Buffer.alloc(headerSize);
  fs.readSync(fd, pickle, 0, headerSize, 8);
  return { header: JSON.parse(pickle.subarray(8, 8 + pickle.readUInt32LE(4)).toString('utf8')), base: 8 + headerSize };
}

// SHA-256 jeder Datei in app.asar, dazu der Inhalt ausgewählter Dateien.
// Ausgelagerte (unpacked) Dateien und Links liegen ausserhalb und zählen nicht.
function inspectAsar(file, wanted = []) {
  const fd = fs.openSync(file, 'r');
  try {
    const { header, base } = readHeader(fd);
    const files = {}; const contents = {};
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (entry.files) { walk(entry, p); continue; }
        if (entry.link || entry.unpacked) continue;
        const buf = Buffer.alloc(Number(entry.size) || 0);
        if (buf.length) fs.readSync(fd, buf, 0, buf.length, base + Number(entry.offset));
        files[p] = sha256(buf);
        if (wanted.includes(p)) contents[p] = buf;
      }
    };
    walk(header, '');
    return { files, contents };
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = {
  OWNER, PROVENANCE_NAME, KEY_FILE, ownerIdFrom,
  createKeyProof, verifyKeyProof, extractKeyProofs, injectKeyProof,
  filesRoot, createProvenance, verifyProvenance, compareFiles, inspectAsar, sha256File,
};
