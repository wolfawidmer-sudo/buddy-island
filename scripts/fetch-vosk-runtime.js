// Lädt die Vosk-Laufzeit (libvosk.dll + MinGW-Laufzeit) für das Store-Paket nach vendor/vosk.
// Gleiche Quelle und gleiche SHA-256 wie der Download in der App (src/vosk.js, RUNTIME).
// Im Store-Paket liegt damit kein nachgeladener Code mehr (Store-Richtlinie 10.2.2).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { RUNTIME } = require('../src/vosk');

const dest = path.join(__dirname, '..', 'vendor', 'vosk');

async function main() {
  if (fs.existsSync(path.join(dest, '.ok')) && fs.readFileSync(path.join(dest, '.ok'), 'utf8') === RUNTIME.sha256) {
    console.log('Vosk-Laufzeit schon da');
    return;
  }
  const res = await fetch(RUNTIME.url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== RUNTIME.sha256) throw new Error(`Prüfsumme stimmt nicht: ${sha}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vosk-'));
  const whl = path.join(tmp, 'vosk.zip');
  fs.writeFileSync(whl, buf);
  // Windows: tar.exe (bsdtar) kann Zip; Linux/macOS: unzip
  try { execFileSync('tar', ['-xf', whl, '-C', tmp], { stdio: 'ignore' }); } catch { execFileSync('unzip', ['-q', '-o', whl, '-d', tmp]); }
  const dlls = fs.readdirSync(path.join(tmp, 'vosk')).filter((f) => f.toLowerCase().endsWith('.dll'));
  if (!dlls.includes('libvosk.dll')) throw new Error('Im Paket fehlt libvosk.dll');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of dlls) fs.copyFileSync(path.join(tmp, 'vosk', f), path.join(dest, f));
  fs.writeFileSync(path.join(dest, '.ok'), RUNTIME.sha256);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Vosk-Laufzeit bereit: ${dlls.join(', ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
