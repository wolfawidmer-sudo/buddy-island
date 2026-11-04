// Release-Notizen aus whats-new.json: node scripts/release-notes.js [version] > notes.md
const { version: current } = require('../package.json');
const data = require('../whats-new.json');
const version = process.argv[2] || current;
const entry = data.versions.find((v) => v.version === version);
if (!entry) { console.error(`whats-new.json: kein Eintrag für ${version}`); process.exit(1); }
const lines = ['## Neu', '', ...entry.highlights.map((h) => `- **${h.title}**: ${h.text}`), '',
  'Installer für Windows 10 und 11. Einfach herunterladen und doppelklicken. Bereits installierte Versionen aktualisieren sich automatisch, nachdem sie die Signatur geprüft haben.'];
process.stdout.write(lines.join('\n') + '\n');
