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
  assert.deepStrictEqual(JSON.parse(Buffer.from(enc, 'base64').toString('utf8')), ww.wakePhrases('Hey Kiwi'));
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

console.log(`\n${n} Tests grün`);
