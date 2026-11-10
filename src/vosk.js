// Vosk (Kaldi) für das Wakeword: offline, Apache 2.0, beliebiges Wort ohne Training.
// Laufzeit (libvosk.dll) und ein kleines Sprachmodell werden erst geladen, wenn das
// Wakeword eingeschaltet wird, und nur mit fester SHA-256-Prüfsumme installiert.
// Store-Version: die Laufzeit liegt schon im Paket («bundled»), geladen wird nur das Modell.
//
// Quellen (geprüft am 10.11.2026):
//   Laufzeit: PyPI vosk 0.3.45, Windows-Wheel (enthält libvosk.dll + MinGW-Laufzeit)
//   Modelle:  https://alphacephei.com/vosk/models (alle drei Apache 2.0)

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
};
const modelUrl = (m) => `https://alphacephei.com/vosk/models/${m.name}.zip`;

// App-Sprache → Modell (Schweizerdeutsch und alles andere Deutsche → de)
function langFor(appLang) {
  const l = String(appLang || '').slice(0, 2).toLowerCase();
  return MODELS[l] ? l : 'de';
}

function paths(root, lang, bundled = null) {
  const m = MODELS[langFor(lang)];
  return {
    dllDir: bundled || path.join(root, RUNTIME.id, 'vosk'),
    modelDir: path.join(root, `model-${langFor(lang)}`, m.name),
  };
}

// Schon installiert? (Dateien da und Markierung geschrieben)
function installed(root, lang, bundled = null) {
  const p = paths(root, lang, bundled);
  const ok = fs.existsSync(path.join(p.dllDir, 'libvosk.dll'))
    && fs.existsSync(path.join(p.modelDir, 'am', 'final.mdl'))
    && fs.existsSync(path.join(root, `model-${langFor(lang)}`, '.ok'))
    && (bundled ? true : fs.existsSync(path.join(root, RUNTIME.id, '.ok')));
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
 * @param {{ root: string, lang: string, bundled?: string|null, fetchImpl: Function, unzip: (zip: string, dest: string) => Promise<void>, onProgress?: Function, signal?: AbortSignal }} o
 * @returns {Promise<{ dllDir: string, modelDir: string }>}
 */
async function ensure({ root, lang, bundled = null, fetchImpl, unzip, onProgress = () => {}, signal }) {
  const l = langFor(lang);
  const have = installed(root, l, bundled);
  if (have) return have;
  const model = MODELS[l];
  const needRuntime = !bundled && !fs.existsSync(path.join(root, RUNTIME.id, '.ok'));
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
      if (!fs.existsSync(path.join(dest, model.name, 'am', 'final.mdl'))) throw new Error('Das Sprachmodell ist unvollständig.');
      fs.writeFileSync(path.join(dest, '.ok'), model.sha256);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* egal */ }
  }
  onProgress({ phase: 'ready' });
  return paths(root, l, bundled);
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

module.exports = { RUNTIME, MODELS, modelUrl, langFor, paths, installed, ensure, missingWords, grammarWords };
