// Musik-Erkennung: nur echtes Signal zählt, Pausen führen zurück in den Ruhezustand.
const assert = require('assert');
const { createActivity, parseLine, ANALYZER_SCRIPT } = require('../src/audio-meter');

let now = 0;
const changes = [];
const act = createActivity({ onChange: (a) => changes.push(a), now: () => now });
const loud = { rms: 0.12, bass: 0.8, mid: 0.4, treble: 0.2 };
const tick = (frame, ms = 16) => { now += ms; act.feed(frame); };

// Spotify offen, aber pausiert: Windows liefert nur «s» (keine Daten) -> nie aktiv
for (let i = 0; i < 200; i += 1) tick({ silent: true }, 250);
assert.deepStrictEqual(changes, [], 'Stille aktiviert nichts');

// Digitale Stille im offenen Stream (rms ~0) -> nicht aktiv
for (let i = 0; i < 100; i += 1) tick({ rms: 0.0001, bass: 0, mid: 0, treble: 0 });
assert.deepStrictEqual(changes, []);

// Ein einzelnes Knacksen (z. B. Systemton) reicht nicht
tick(loud); tick(loud); tick({ silent: true });
assert.deepStrictEqual(changes, [], 'zwei Bilder sind zu kurz');

// Musik läuft: nach drei hörbaren Bildern aktiv (< 50 ms)
tick(loud); tick(loud); tick(loud);
assert.deepStrictEqual(changes, [true]);
assert.strictEqual(act.active, true);

// Kurze leise Stelle im Lied (< 1,2 s) bleibt aktiv
for (let i = 0; i < 40; i += 1) tick({ rms: 0.001, bass: 0, mid: 0, treble: 0 });
assert.strictEqual(act.active, true, 'leise Passage hält die Anzeige');
tick(loud);

// Pause: nach 1,2 s ohne Signal zurück in den Ruhezustand
for (let i = 0; i < 4; i += 1) tick({ silent: true }, 250);
assert.strictEqual(act.active, true);
tick({ silent: true }, 250);
assert.deepStrictEqual(changes, [true, false]);

// Weiterspielen: sofort wieder aktiv
tick(loud); tick(loud); tick(loud);
assert.deepStrictEqual(changes, [true, false, true]);

// Analyse beendet (Musik aus, Spielmodus): reset meldet Ruhe genau einmal
act.reset(); act.reset();
assert.deepStrictEqual(changes, [true, false, true, false]);

// Zeilenformat des Helfers
assert.deepStrictEqual(parseLine('s'), { silent: true });
assert.deepStrictEqual(parseLine('f,0.1234,0.900,0.400,1.700,1'), { rms: 0.1234, bass: 0.9, mid: 0.4, treble: 1, beat: true });
assert.deepStrictEqual(parseLine('f,0.0100,-1,abc,0.2,0').bass, 0);
assert.deepStrictEqual(parseLine('i,48000,2,32,f'), { info: { rate: 48000, channels: 2, bits: 32, float: true } });
assert.strictEqual(parseLine('e,Gerät fehlt').error, 'Gerät fehlt');
assert.strictEqual(parseLine('READY'), null);
assert.strictEqual(parseLine(''), null);

// Kein PowerShell-Variablenzeichen im C#-Teil (sonst würde der Here-String es ersetzen)
const cs = ANALYZER_SCRIPT.split('@"')[1].split('"@')[0];
assert.ok(!/[$`]/.test(cs));
assert.ok(cs.includes('AUDCLNT_STREAMFLAGS_LOOPBACK') || cs.includes('0x00020000'), 'Loopback-Aufnahme');

console.log('audio.test.js: alle Tests bestanden');
