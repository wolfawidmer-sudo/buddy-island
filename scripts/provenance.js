#!/usr/bin/env node
// Build-Herkunft für Buddy Island. Wird nicht in die App gepackt.
//
//   Prüfen:   node scripts/provenance.js verify [Pfad] [--provenance datei.json] [--offline] [--json]
//             Pfad = Installationsordner, app.asar oder BuddyIsland-Setup-x.y.z.exe
//             (ohne Pfad unter Windows: %LOCALAPPDATA%\Programs\buddy-island)
//   Release:  node scripts/provenance.js stamp                       (vor dem Build)
//             node scripts/provenance.js attest --asar dist/win-unpacked/resources/app.asar \
//                  --latest dist/latest.yml --out dist/provenance.json  (nach dem Build)
//
// Schlüssel: --key datei.pem oder BUDDY_UPDATE_SIGNING_KEY. Exit 2 = kein Schlüssel.
// Geprüft wird immer mit den öffentlichen Schlüsseln DIESER Kopie, nie mit denen der geprüften.

const fs = require('fs');
const path = require('path');
const pv = require('./lib/provenance');
const { PUBLIC_KEYS, parseLatestYml, sha512File, verifyManifest, MANIFEST_NAME } = require('../src/update-security');

const ROOT = path.join(__dirname, '..');
const RELEASES = 'https://github.com/wolfawidmer-sudo/buddy-island/releases/download';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(name);

function privateKey() {
  const file = arg('--key');
  const pem = file ? fs.readFileSync(file, 'utf8') : (process.env.BUDDY_UPDATE_SIGNING_KEY || '').replace(/\\n/g, '\n');
  if (!pem.trim()) {
    console.error('Kein Schlüssel (--key oder BUDDY_UPDATE_SIGNING_KEY).');
    process.exit(2);
  }
  return `${pem.trim()}\n`;
}

// Setzt den Schlüsselnachweis in src/update-security.js ein (Arbeitskopie des Builds)
function stamp() {
  const { keyId, proof } = pv.createKeyProof(privateKey());
  if (!pv.verifyKeyProof(keyId, proof).ok) throw new Error('Schlüssel passt nicht zum eingebauten öffentlichen Schlüssel.');
  const file = path.join(ROOT, pv.KEY_FILE);
  fs.writeFileSync(file, pv.injectKeyProof(fs.readFileSync(file, 'utf8'), keyId, proof));
  console.log(`Schlüsselnachweis eingesetzt (${keyId}).`);
}

async function attest() {
  const asar = arg('--asar');
  const out = arg('--out');
  if (!asar || !out) throw new Error('Aufruf: attest --asar <app.asar> --out <datei> [--latest latest.yml]');
  const key = privateKey();
  const { files, contents } = pv.inspectAsar(asar, ['package.json', pv.KEY_FILE]);
  const version = JSON.parse(contents['package.json']).version;
  const proofs = pv.extractKeyProofs(contents[pv.KEY_FILE] || '');
  if (!Object.keys(proofs).length) throw new Error('Im Build fehlt der Schlüsselnachweis (vorher «stamp» ausführen).');
  const latest = arg('--latest') ? parseLatestYml(fs.readFileSync(arg('--latest'), 'utf8')) : {};
  if (latest.version && latest.version !== version) throw new Error(`Version passt nicht (${latest.version} / ${version}).`);
  const p = pv.createProvenance(key, {
    version, files, asarSha256: await pv.sha256File(asar),
    installer: latest.file || '', installerSha512: latest.sha512 || '',
  });
  const check = pv.verifyProvenance(p);
  if (!check.ok) throw new Error(`Selbstprüfung fehlgeschlagen: ${check.error}`);
  fs.writeFileSync(out, `${JSON.stringify(p, null, 2)}\n`);
  console.log(`Build-Nachweis ${version}: ${p.fileCount} Dateien, app.asar ${p.asarSha256.slice(0, 16)}…`);
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function loadProvenance(version) {
  if (arg('--provenance')) return JSON.parse(fs.readFileSync(arg('--provenance'), 'utf8'));
  if (flag('--offline') || !version) return null;
  return fetchJson(`${RELEASES}/v${version}/${pv.PROVENANCE_NAME}`);
}

function findAsar(target) {
  if (!target && process.platform === 'win32') target = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'buddy-island');
  if (!target) throw new Error('Pfad fehlt (Installationsordner, app.asar oder Installer).');
  if (fs.statSync(target).isDirectory()) {
    for (const p of [path.join(target, 'resources', 'app.asar'), path.join(target, 'app.asar')]) if (fs.existsSync(p)) return p;
    throw new Error(`Keine app.asar in ${target}.`);
  }
  return target;
}

async function verifyInstaller(file) {
  const sha512 = await sha512File(file);
  const version = (path.basename(file).match(/(\d+\.\d+\.\d+)/) || [])[1];
  const p = await loadProvenance(version);
  if (p && pv.verifyProvenance(p).ok && p.installerSha512 === sha512) {
    return { verdict: 'ECHT', detail: `Installer ${p.version} passt zum signierten Build-Nachweis.`, owner: p };
  }
  // Ältere Releases haben nur die Update-Signatur; die bindet den Installer ebenfalls an den Schlüssel
  const sig = flag('--offline') ? null : await fetchJson(`${RELEASES}/v${version}/${MANIFEST_NAME}`);
  if (sig && verifyManifest(sig, { sha512 }).ok) {
    return { verdict: 'ECHT', detail: `Installer ${version} passt zur signierten Update-Signatur (Schlüssel ${sig.keyId}).`, owner: pv.OWNER };
  }
  return { verdict: 'UNBEKANNT', detail: 'Kein signierter Nachweis passt zu diesem Installer.' };
}

async function verifyAsar(asar) {
  const { files, contents } = pv.inspectAsar(asar, ['package.json', pv.KEY_FILE]);
  const version = contents['package.json'] ? JSON.parse(contents['package.json']).version : undefined;
  const proofs = pv.extractKeyProofs(contents[pv.KEY_FILE] || '');
  const proofChecks = Object.entries(proofs).map(([keyId, proof]) => pv.verifyKeyProof(keyId, proof, PUBLIC_KEYS));
  const keyProof = proofChecks.find((c) => c.ok) || proofChecks[0] || pv.verifyKeyProof('', '');
  const p = await loadProvenance(version);
  const build = p ? pv.verifyProvenance(p) : { ok: false, error: 'Kein Build-Nachweis gefunden.' };
  const result = { version, keyProof, build };

  if (build.ok) {
    const cmp = pv.compareFiles(files, p.files);
    result.files = { total: Object.keys(files).length, same: cmp.same.length, changed: cmp.changed, added: cmp.added, missing: cmp.missing };
    if ((await pv.sha256File(asar)) === p.asarSha256 || pv.filesRoot(files) === p.filesRoot) {
      result.verdict = 'ECHT';
      result.detail = `Byte für Byte identisch mit dem signierten Build ${p.version}.`;
    } else if (cmp.same.length) {
      result.verdict = 'ABGELEITET';
      result.detail = `${cmp.same.length} von ${result.files.total} Dateien identisch mit Build ${p.version}; ${cmp.changed.length} geändert, ${cmp.added.length} neu, ${cmp.missing.length} entfernt.`;
    } else {
      result.verdict = keyProof.ok ? 'ABGELEITET' : 'UNBEKANNT';
      result.detail = 'Keine Datei stimmt mit dem signierten Build überein.';
    }
  } else if (keyProof.ok) {
    result.verdict = 'ABGELEITET';
    result.detail = `Enthält deinen gültigen Schlüsselnachweis; ohne Build-Nachweis (${build.error}) ist der übrige Inhalt ungeprüft.`;
  } else {
    result.verdict = 'UNBEKANNT';
    result.detail = 'Weder Schlüsselnachweis noch passender Build-Nachweis.';
  }
  return result;
}

async function verify() {
  const target = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  const result = target && /\.exe$/i.test(target) ? await verifyInstaller(target) : await verifyAsar(findAsar(target));
  if (flag('--json')) {
    console.log(JSON.stringify(result, (k, v) => (k === 'files' && v && !Array.isArray(v) && typeof v.total !== 'number' ? undefined : v), 2));
  } else {
    console.log(`Ergebnis: ${result.verdict}`);
    console.log(result.detail);
    const o = result.keyProof?.ok ? result.keyProof : result.owner;
    if (o) console.log(`Besitzer: ${o.owner} · GitHub ${o.github} (Konto-ID ${o.githubId}) · ${o.repository}`);
    if (result.keyProof && !result.keyProof.ok) console.log(`Schlüsselnachweis: ${result.keyProof.error}`);
    if (result.build?.ok === false) console.log(`Build-Nachweis: ${result.build.error}`);
    if (result.files?.changed?.length) console.log(`Geändert: ${result.files.changed.slice(0, 20).join(', ')}`);
  }
  process.exitCode = { ECHT: 0, ABGELEITET: 3 }[result.verdict] ?? 1;
}

const commands = { stamp, attest, verify };
const cmd = commands[argv[0]];
if (!cmd) {
  console.error('Befehle: verify, stamp, attest (siehe Kopf von scripts/provenance.js)');
  process.exit(1);
}
Promise.resolve(cmd()).catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
