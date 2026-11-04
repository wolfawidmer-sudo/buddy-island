// Bildschirmrand = echter Aufnahme-Zustand (src/perception.js)
const assert = require('assert');
const { createPerception } = require('../src/perception');

const events = [];
const p = createPerception({ onChange: (a) => events.push(a) });
assert.strictEqual(p.isActive(), false, 'Start: aus');
// Aufnahme beginnt: sofort an
assert.strictEqual(p.captureStart('chat1'), true);
assert.deepStrictEqual(events, [true]);
// Aufnahme fertig, Modell wertet aus: bleibt an
p.captureEnd();
assert.strictEqual(p.isActive(), true);
// Nächste Aufnahme derselben Aufgabe: kein Flackern
p.captureStart('chat1'); p.captureEnd();
assert.deepStrictEqual(events, [true]);
// Aufgabe endet: sofort aus
p.taskEnd('chat1');
assert.deepStrictEqual(events, [true, false]);
// Steuerung endet mitten in einer Aufnahme: aus
p.captureStart('a');
p.stopAll();
assert.strictEqual(p.isActive(), false);
// Pausiert (Spiel): aus und keine Aufnahme erlaubt
p.captureStart('b');
p.setPaused(true);
assert.strictEqual(p.isActive(), false);
assert.strictEqual(p.captureStart('b'), false, 'pausiert: keine Aufnahme');
p.setPaused(false);
assert.strictEqual(p.isActive(), true, 'Aufgabe läuft noch: wieder an');
p.taskEnd('b');
p.captureEnd();
assert.strictEqual(p.isActive(), false);
// Musik hat keinen Einfluss: es gibt dafür gar keinen Eingang
assert.deepStrictEqual(Object.keys(p).sort(), ['captureEnd', 'captureStart', 'isActive', 'isPaused', 'setPaused', 'stopAll', 'taskEnd']);
// Der Hauptprozess koppelt den Rand nur an diesen Zustand (keine Musik, kein Timer)
const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
const apply = main.slice(main.indexOf('function applyGlow'), main.indexOf('function applyGlow') + 400);
assert.ok(!/music/i.test(apply), 'applyGlow kennt keine Musik');
assert.ok(!/CONTROL_GLOW_DELAY|setTimeout\(\(\) => \{ if \(controlling\) setGlow/.test(main), 'kein Timer schaltet den Rand');
assert.ok(/perception\.captureStart\(\)/.test(main) && /perception\.captureEnd\(\)/.test(main), 'Rand hängt an der echten Aufnahme');
console.log('Wahrnehmungs-Tests ok (Rand nur bei echter Aufnahme, sofort aus, pausierbar, unabhängig von Musik)');
