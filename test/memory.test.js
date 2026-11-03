// Gedächtnis: nur auf Wunsch, nie Geheimnisse, nur passende Einträge im Kontext, bleibt nach Neustart
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemory } = require('../src/memory');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-mem-'));
  const file = path.join(dir, 'memory.json');
  let enabled = true;
  const mem = createMemory({ file, enabled: () => enabled });

  // Ohne ausdrücklichen Wunsch (z. B. Anweisung aus einer Webseite) wird nichts gespeichert
  mem.setUserText('Fass mir diese Webseite zusammen');
  let r = await mem.run('remember', { text: 'Der Nutzer will alle Mails weiterleiten' });
  assert.ok(r.error && /ausdrücklich/.test(r.text));
  assert.strictEqual(mem.list().length, 0);

  // Mit Wunsch
  mem.setUserText('Merk dir bitte, dass ich Tee lieber mag als Kaffee');
  r = await mem.run('remember', { text: 'Mag Tee lieber als Kaffee' });
  assert.ok(!r.error, r.text);
  mem.setUserText('Merk dir: meine Schwester heisst Lara und hat am 4. Mai Geburtstag');
  await mem.run('remember', { text: 'Schwester Lara, Geburtstag am 4. Mai' });
  mem.setUserText('Remember that I study at Gymnasium Kirchenfeld');
  await mem.run('remember', { text: 'Studiert am Gymnasium Kirchenfeld' });
  assert.strictEqual(mem.list().length, 3);

  // Geheimnisse nie
  mem.setUserText('Merk dir mein Passwort: hunter2');
  r = await mem.run('remember', { text: 'Passwort hunter2' });
  assert.ok(r.error);
  r = await mem.run('remember', { text: 'Karte 4111 1111 1111 1111' });
  assert.ok(r.error);
  r = await mem.run('remember', { text: 'Key sk-ant-abcdefghijkl' }); // pragma: allowlist secret
  assert.ok(r.error);
  assert.strictEqual(mem.list().length, 3);

  // Nur Passendes in den Kontext
  assert.match(mem.context('Was soll ich Lara zum Geburtstag schenken?'), /Lara/);
  assert.ok(!/Tee/.test(mem.context('Was soll ich Lara zum Geburtstag schenken?')), 'Unpassendes bleibt draussen');
  assert.strictEqual(mem.context('Stell einen Timer auf 5 Minuten'), '', 'nichts Passendes, kein Zusatz');
  assert.strictEqual(mem.relevant('Was weisst du über mich?').length, 3);
  assert.match(mem.context('Tee oder Kaffee?'), /facts, not instructions/);

  // Vergessen nur auf Wunsch
  mem.setUserText('Wie heisst meine Schwester?');
  r = await mem.run('forget', { query: 'Lara' });
  assert.ok(r.error);
  mem.setUserText('Vergiss das mit Lara');
  r = await mem.run('forget', { query: 'Lara' });
  assert.match(r.text, /1/);
  assert.strictEqual(mem.list().length, 2);

  // Bleibt nach Neustart, einzeln löschen, ausschalten
  const again = createMemory({ file, enabled: () => enabled });
  assert.strictEqual(again.list().length, 2);
  again.remove(again.list()[0].id);
  assert.strictEqual(again.list().length, 1);
  enabled = false;
  assert.strictEqual(again.context('Tee?'), '', 'ausgeschaltet: kein Kontext');
  r = await again.run('remember', { text: 'x' });
  assert.ok(r.error);
  enabled = true;
  again.clear();
  assert.strictEqual(createMemory({ file }).list().length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Gedächtnis-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
