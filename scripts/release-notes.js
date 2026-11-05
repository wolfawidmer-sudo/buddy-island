// Release-Notizen aus whats-new.json: node scripts/release-notes.js [version] > notes.md
const { version: current } = require('../package.json');
const data = require('../whats-new.json');
const version = process.argv[2] || current;
const entry = data.versions.find((v) => v.version === version);
if (!entry) { console.error(`whats-new.json: kein Eintrag für ${version}`); process.exit(1); }
// «since»: letzte veröffentlichte Version. Dazwischen liegende Versionen ohne eigenes Release kommen mit.
const between = [];
if (entry.since) {
  for (const v of data.versions) {
    if (v === entry) continue;
    if (v.version === entry.since) break;
    if (data.versions.indexOf(v) > data.versions.indexOf(entry)) between.push(v);
  }
}
const extra = between.length ? ['', `## Ausserdem seit ${entry.since}`, '', ...between.flatMap((v) => v.highlights.map((h) => `- **${h.title}**: ${h.text}`))] : [];
const lines = ['## Neu', '', ...entry.highlights.map((h) => `- **${h.title}**: ${h.text}`), ...extra, '',
  'Installer für Windows 10 und 11. Einfach herunterladen und doppelklicken. Bereits installierte Versionen aktualisieren sich automatisch, nachdem sie die Signatur geprüft haben.'];
process.stdout.write(lines.join('\n') + '\n');
