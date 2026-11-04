// Jede veröffentlichte Version braucht Neuigkeiten für Website und Release-Notizen.
const assert = require('assert');
const { version } = require('../package.json');
const data = require('../whats-new.json');
const entry = data.versions.find((v) => v.version === version);
assert.ok(entry, `whats-new.json: Eintrag für ${version} fehlt`);
assert.strictEqual(data.versions[0].version, version, 'neuste Version steht zuoberst');
for (const v of data.versions) {
  assert.ok(Array.isArray(v.highlights) && v.highlights.length >= 1 && v.highlights.length <= 5, `${v.version}: 1 bis 5 Punkte`);
  for (const h of v.highlights) {
    assert.ok(h.title && h.title.length <= 40, `${v.version}: Titel kurz halten (${h.title})`);
    assert.ok(h.text && h.text.length <= 200, `${v.version}: Text kurz halten (${h.title})`);
    assert.ok(!/<|>/.test(h.title + h.text), 'kein HTML');
  }
}
console.log('Neuigkeiten-Tests ok');
