// Tests: eigenes Wakeword (src/wakeword.js) und Schlafzyklus der Augen (src/renderer/eyes.js)
const assert = require('assert');
const ww = require('../src/wakeword');
const { phaseAt, createEyes, DAY, NIGHT } = require('../src/renderer/eyes');
const { SCRIPT } = require('../src/voice');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('✓', name); };

// ---------- Wakeword ----------
test('gültige Wakewords werden sauber', () => {
  assert.deepStrictEqual(ww.cleanWakeWord('  Hey   Kiwi '), { ok: true, value: 'Hey Kiwi' });
  assert.strictEqual(ww.cleanWakeWord('Jarvis').value, 'Jarvis');
  assert.strictEqual(ww.cleanWakeWord('Salut Léa').value, 'Salut Léa');
  assert.strictEqual(ww.cleanWakeWord('Hallo Grüezi-Bot').ok, true);
});
test('ungültige Wakewords werden abgelehnt', () => {
  for (const bad of ['', '   ', 'Bob', 'a'.repeat(33), 'Hey $(rm -rf)', "hey'; Remove-Item", 'eins zwei drei vier fünf', 'Hey 123', null, 42]) {
    assert.strictEqual(ww.cleanWakeWord(bad).ok, false, `sollte ablehnen: ${bad}`);
  }
});
test('Varianten: einzelnes Wort bekommt Begrüssungen', () => {
  const p = ww.wakePhrases('Jarvis');
  assert.strictEqual(p[0], 'jarvis');
  assert.ok(p.includes('hey jarvis') && p.includes('hallo jarvis'));
});
test('Varianten: «Hey X» wird zu den anderen Begrüssungen', () => {
  const p = ww.wakePhrases('Hey Buddy');
  for (const x of ['hey buddy', 'hallo buddy', 'hi buddy', 'he buddy', 'okay buddy']) assert.ok(p.includes(x), x);
  assert.deepStrictEqual(ww.wakePhrases('Guten Morgen Kiwi'), ['guten morgen kiwi']);
});
test('einzelnes Wort: strengere Schwelle', () => {
  assert.strictEqual(ww.minConfidence('Jarvis'), 0.75);
  assert.strictEqual(ww.minConfidence('Hey Kiwi'), 0.6);
});
test('Ungültiges fällt auf «Hey Buddy» zurück', () => {
  assert.strictEqual(ww.wakeWordOf({ wakeWord: 'x;' }), 'Hey Buddy');
  assert.strictEqual(ww.wakeWordOf({}), 'Hey Buddy');
  assert.strictEqual(ww.wakeWordOf({ wakeWord: 'Hey Kiwi' }), 'Hey Kiwi');
});
test('Übergabe an PowerShell nur als Base64', () => {
  const enc = ww.encodePhrases(ww.wakePhrases('Hey Kiwi'));
  assert.match(enc, /^[A-Za-z0-9+/=]+$/);
  assert.deepStrictEqual(Buffer.from(enc, 'base64').toString('utf8').split('\n'), ww.wakePhrases('Hey Kiwi'));
  assert.ok(!SCRIPT.includes('| ConvertFrom-Json)'), 'keine JSON-Listen an PowerShell 5.1');
  assert.ok(SCRIPT.includes('[string]$words') && SCRIPT.includes('FromBase64String($words)') && SCRIPT.includes('$minconf'));
});

// ---------- Schlafzyklus ----------
test('Phasen am Tag', () => {
  assert.strictEqual(phaseAt(0, 14), 'awake');
  assert.strictEqual(phaseAt(DAY.drowsy - 1, 14), 'awake');
  assert.strictEqual(phaseAt(DAY.drowsy, 14), 'drowsy');
  assert.strictEqual(phaseAt(DAY.asleep, 14), 'asleep');
});
test('Phasen nachts schneller', () => {
  assert.strictEqual(phaseAt(NIGHT.drowsy, 23), 'drowsy');
  assert.strictEqual(phaseAt(NIGHT.asleep, 3), 'asleep');
  assert.strictEqual(phaseAt(NIGHT.asleep, 12), 'awake');
});

function fakeIsland() {
  const classes = new Set();
  return {
    dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)), contains: (c) => classes.has(c),
    },
  };
}
const fakeTimers = { setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {} };

test('Augen schlafen ein und wachen bei Kontakt auf', () => {
  let t = new Date(2026, 10, 10, 14, 0).getTime();
  const island = fakeIsland();
  const eyes = createEyes({ island, active: () => true, now: () => t, timers: fakeTimers });
  eyes.start();
  assert.strictEqual(island.dataset.eyes, 'awake');
  t += DAY.drowsy; eyes.tick();
  assert.strictEqual(island.dataset.eyes, 'drowsy');
  t += DAY.asleep; eyes.tick();
  assert.strictEqual(island.dataset.eyes, 'asleep');
  assert.ok(island.classList.contains('breath'), 'atmet im Schlaf');
  eyes.tick();
  assert.ok(!island.classList.contains('breath'), 'atmet wieder aus');
  eyes.wake();
  assert.strictEqual(island.dataset.eyes, 'awake');
  assert.ok(!island.classList.contains('breath'));
});
test('inaktiv (Einstellung aus, offen, Spiel): kein data-eyes', () => {
  let on = true;
  const island = fakeIsland();
  const eyes = createEyes({ island, active: () => on, timers: fakeTimers });
  eyes.start();
  assert.ok(island.dataset.eyes);
  on = false; eyes.sync();
  assert.strictEqual(island.dataset.eyes, undefined);
});
test('ruhige Bewegung: kein Atmen', () => {
  let t = new Date(2026, 10, 10, 14, 0).getTime();
  const island = fakeIsland();
  const eyes = createEyes({ island, active: () => true, calm: () => true, now: () => t, timers: fakeTimers });
  eyes.start();
  t += DAY.asleep; eyes.tick(); eyes.tick();
  assert.strictEqual(island.dataset.eyes, 'asleep');
  assert.ok(!island.classList.contains('breath'));
});

// ---------- Vosk ----------
const vosk = require('../src/vosk');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

test('Sprache → Modell', () => {
  assert.strictEqual(vosk.langFor('de-CH'), 'de');
  assert.strictEqual(vosk.langFor('en'), 'en');
  assert.strictEqual(vosk.langFor('fr'), 'fr');
  assert.strictEqual(vosk.langFor('it'), 'de');
  for (const m of Object.values(vosk.MODELS)) assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.match(vosk.RUNTIME.sha256, /^[0-9a-f]{64}$/);
  assert.ok(vosk.RUNTIME.url.startsWith('https://files.pythonhosted.org/'));
});
test('Wortliste: Wakeword + Füllwörter, nur sichere Zeichen', () => {
  for (const lang of ['de', 'en', 'fr']) {
    const g = vosk.grammarWords(lang, ww.wakePhrases('Hey Kiwi'));
    assert.ok(g.includes('kiwi') && g.includes('hey'), lang);
    assert.ok(g.length > 150, `${lang}: genug Füllwörter (${g.length})`);
    for (const w of g) assert.ok(!/["\\\[\]{}]/.test(w), `kein Sonderzeichen: ${w}`);
  }
});
test('unbekannte Wörter aus der Vosk-Ausgabe', () => {
  const err = "WARNING (VoskAPI:UpdateGrammarFst():recognizer.cc:308) Ignoring word missing in vocabulary: 'jarvis'\nLOG (x)\n...missing in vocabulary: 'jarvis'";
  assert.deepStrictEqual(vosk.missingWords(err), ['jarvis']);
  assert.deepStrictEqual(vosk.missingWords(''), []);
});
test('Sprach-Helfer: Vosk-Teil vorhanden, Mikrofon wird fürs Diktat freigegeben', () => {
  for (const x of ['[string]$grammar', 'BuddyVosk', '[BuddyVosk]::StopMic()', 'StartsWith', 'waveInOpen', 'GetShortPathName']) assert.ok(SCRIPT.includes(x), x);
});

async function asyncTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vosk-'));
  const body = (buf) => ({ getReader() { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { value: buf, done: false })) }; } });
  // Falsche Datei: Prüfsumme stimmt nicht → abgelehnt, nichts installiert
  let unzipped = 0;
  await assert.rejects(vosk.ensure({ root, lang: 'de', fetchImpl: async () => ({ ok: true, body: body(Buffer.from('gefälscht')) }), unzip: async () => { unzipped++; } }), /Prüfsumme/);
  assert.strictEqual(unzipped, 0);
  assert.strictEqual(vosk.installed(root, 'de'), null);
  n++; console.log('✓ falscher Download wird abgelehnt');
  // HTTP-Fehler
  await assert.rejects(vosk.ensure({ root, lang: 'de', fetchImpl: async () => ({ ok: false, status: 404 }), unzip: async () => {} }), /HTTP 404/);
  n++; console.log('✓ HTTP-Fehler wird gemeldet');
  // Schon installiert: kein Download
  const p = vosk.paths(root, 'de');
  fs.mkdirSync(p.dllDir, { recursive: true }); fs.writeFileSync(path.join(p.dllDir, 'libvosk.dll'), '');
  fs.mkdirSync(path.join(p.modelDir, 'am'), { recursive: true }); fs.writeFileSync(path.join(p.modelDir, 'am', 'final.mdl'), '');
  fs.writeFileSync(path.join(root, vosk.RUNTIME.id, '.ok'), ''); fs.writeFileSync(path.join(root, 'model-de', '.ok'), '');
  let fetched = 0;
  const got = await vosk.ensure({ root, lang: 'de', fetchImpl: async () => { fetched++; }, unzip: async () => {} });
  assert.strictEqual(fetched, 0);
  assert.strictEqual(got.modelDir, p.modelDir);
  n++; console.log('✓ vorhandenes Modell wird nicht neu geladen');
  fs.rmSync(root, { recursive: true, force: true });
  void crypto;
}

asyncTests().then(() => console.log(`\n${n} Tests grün`)).catch((err) => { console.error(err); process.exit(1); });
