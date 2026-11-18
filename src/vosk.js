// Vosk (Kaldi) für das Wakeword: offline, Apache 2.0, beliebiges Wort ohne Training.
// Laufzeit (libvosk.dll) und ein kleines Sprachmodell werden erst geladen, wenn das
// Wakeword eingeschaltet wird, und nur mit fester SHA-256-Prüfsumme installiert.
//
// Quellen (geprüft am 10.11.2026):
//   Laufzeit: PyPI vosk 0.3.45, Windows-Wheel (enthält libvosk.dll + MinGW-Laufzeit)
//   Modelle:  https://alphacephei.com/vosk/models (alle Apache 2.0; es/it/pt/nl geprüft am 11.11.2026)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNTIME = {
  id: 'runtime-0.3.45',
  url: 'https://files.pythonhosted.org/packages/c0/4c/deb0861f7da9696f8a255f1731bb73e9412cca29c4b3888a3fcb2a930a59/vosk-0.3.45-py3-none-win_amd64.whl',
  sha256: '6994ddc68556c7e5730c3b6f6bad13320e3519b13ce3ed2aa25a86724e7c10ac',
  size: 13997596,
};

const MODELS = {
  de: { name: 'vosk-model-small-de-0.15', sha256: 'b7e53c90b1f0a38456f4cd62b366ecd58803cd97cd42b06438e2c131713d5e43', size: 46499967 },
  en: { name: 'vosk-model-small-en-us-0.15', sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498', size: 41205931 },
  fr: { name: 'vosk-model-small-fr-0.22', sha256: 'cabf6180e177eb9b3a9a9d43a437bd5e549f3a7d09525e5d69a3fed787be12ad', size: 42233323 },
  es: { name: 'vosk-model-small-es-0.42', sha256: '09b239888f633ef2f0b4e09736e3d9936acfd810bc65d53fad45261762c6511f', size: 39817833 },
  it: { name: 'vosk-model-small-it-0.22', sha256: '9ec65e75861d1c6c2e457cccd932705340dcdf233f5b239f00733b4de0bf3267', size: 49665141 },
  // Das portugiesische Modell hat ein älteres Format: final.mdl liegt direkt im Ordner (kein am/)
  pt: { name: 'vosk-model-small-pt-0.3', sha256: '6e1ce909032e1afa7a88e68a3d628ecafff302bdf195befab308826c395e93b7', size: 32453112, check: 'final.mdl' },
  nl: { name: 'vosk-model-small-nl-0.22', sha256: '039811c3b829de64e4f123a9f684a53784005b212a346ac0b899dc7efce2ed0a', size: 40441176 },
};
const LANG_NAMES = { de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', pt: 'Português', nl: 'Nederlands' };
const checkFile = (m) => m.check || path.join('am', 'final.mdl');
const modelUrl = (m) => `https://alphacephei.com/vosk/models/${m.name}.zip`;

// Gesprochene Sprache (z. B. «de-CH», «es-ES», «gsw») → Modell.
// Schweizerdeutsch und alles Deutsche → de; Sprachen ohne Modell → en («Hey Buddy» ist englisch).
function langFor(spoken) {
  const raw = String(spoken || '').toLowerCase();
  if (!raw) return 'de';
  if (raw === 'gsw' || raw.startsWith('gsw-')) return 'de';
  const l = raw.slice(0, 2);
  return MODELS[l] ? l : 'en';
}

function paths(root, lang) {
  const m = MODELS[langFor(lang)];
  return {
    dllDir: path.join(root, RUNTIME.id, 'vosk'),
    modelDir: path.join(root, `model-${langFor(lang)}`, m.name),
  };
}

// Schon installiert? (Dateien da und Markierung geschrieben)
function installed(root, lang) {
  const p = paths(root, lang);
  const ok = fs.existsSync(path.join(p.dllDir, 'libvosk.dll'))
    && fs.existsSync(path.join(p.modelDir, checkFile(MODELS[langFor(lang)])))
    && fs.existsSync(path.join(root, `model-${langFor(lang)}`, '.ok'))
    && fs.existsSync(path.join(root, RUNTIME.id, '.ok'));
  return ok ? p : null;
}

async function download(fetchImpl, url, file, { sha256, size }, onBytes, signal) {
  const res = await fetchImpl(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  const hash = crypto.createHash('sha256');
  const reader = res.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      total += buf.length;
      if (total > size * 1.05 + 1024) throw new Error('Download ist unerwartet gross.');
      hash.update(buf);
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      onBytes(buf.length);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  const got = hash.digest('hex');
  if (got !== sha256) {
    try { fs.rmSync(file, { force: true }); } catch { /* egal */ }
    throw new Error(`Prüfsumme stimmt nicht (${path.basename(url)}).`);
  }
}

/**
 * Laufzeit und Modell sicherstellen. Lädt nur, was fehlt.
 * @param {{ root: string, lang: string, fetchImpl: Function, unzip: (zip: string, dest: string) => Promise<void>, onProgress?: Function, signal?: AbortSignal }} o
 * @returns {Promise<{ dllDir: string, modelDir: string }>}
 */
async function ensure({ root, lang, fetchImpl, unzip, onProgress = () => {}, signal }) {
  const l = langFor(lang);
  const have = installed(root, l);
  if (have) return have;
  const model = MODELS[l];
  const needRuntime = !fs.existsSync(path.join(root, RUNTIME.id, '.ok'));
  const needModel = !fs.existsSync(path.join(root, `model-${l}`, '.ok'));
  const totalBytes = (needRuntime ? RUNTIME.size : 0) + (needModel ? model.size : 0);
  let done = 0;
  let last = 0;
  const onBytes = (n) => {
    done += n;
    const now = Date.now();
    if (now - last > 400) { last = now; onProgress({ phase: 'download', percent: Math.round((done / totalBytes) * 100) }); }
  };
  const tmp = path.join(root, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (needRuntime) {
      const zip = path.join(tmp, 'vosk-runtime.zip'); // .whl ist ein Zip; Expand-Archive will die Endung .zip
      await download(fetchImpl, RUNTIME.url, zip, RUNTIME, onBytes, signal);
      onProgress({ phase: 'install' });
      const dest = path.join(root, RUNTIME.id);
      fs.rmSync(dest, { recursive: true, force: true });
      await unzip(zip, dest);
      if (!fs.existsSync(path.join(dest, 'vosk', 'libvosk.dll'))) throw new Error('Im Vosk-Paket fehlt libvosk.dll.');
      fs.writeFileSync(path.join(dest, '.ok'), RUNTIME.sha256);
    }
    if (needModel) {
      const zip = path.join(tmp, `${model.name}.zip`);
      await download(fetchImpl, modelUrl(model), zip, model, onBytes, signal);
      onProgress({ phase: 'install' });
      const dest = path.join(root, `model-${l}`);
      fs.rmSync(dest, { recursive: true, force: true });
      await unzip(zip, dest);
      if (!fs.existsSync(path.join(dest, model.name, checkFile(model)))) throw new Error('Das Sprachmodell ist unvollständig.');
      fs.writeFileSync(path.join(dest, '.ok'), model.sha256);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* egal */ }
  }
  onProgress({ phase: 'ready' });
  return paths(root, l);
}

// Wortliste für die Erkennung: Wakeword-Varianten plus häufige Wörter der Sprache.
// Ohne Füllwörter presst Vosk jedes Gesagte auf das Wakeword (viele Fehlalarme);
// Gemessen mit synthetischer Sprache (test/wake/): ~40 häufige Wörter sind besser als ~300,
// weil weniger Wörter dem Wakeword bei leiser oder entfernter Sprache Konkurrenz machen.
function grammarWords(lang, phrases) {
  let fill = [];
  try { fill = fs.readFileSync(path.join(__dirname, 'wake-fillers', `${langFor(lang)}.txt`), 'utf8').split(/\s+/).filter(Boolean); } catch { /* ohne Füllwörter */ }
  const own = phrases.flatMap((p) => p.split(' '));
  return [...new Set([...fill, ...own])].filter((w) => /^[\p{L}' -]{1,40}$/u.test(w)).sort();
}

// Vosk meldet unbekannte Wörter auf stderr: «Ignoring word missing in vocabulary: 'jarvis'»
function missingWords(stderrText) {
  const out = [];
  const re = /missing in vocabulary: '([^']+)'/g;
  let m;
  while ((m = re.exec(String(stderrText || '')))) out.push(m[1]);
  return [...new Set(out)];
}

module.exports = { RUNTIME, MODELS, LANG_NAMES, modelUrl, langFor, paths, installed, ensure, missingWords, grammarWords };
