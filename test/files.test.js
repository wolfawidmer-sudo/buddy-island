// Tests für die Datei-Werkzeuge in einem temporären Ordner
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFiles } = require('../src/files');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-files-'));
  const desktop = path.join(base, 'Desktop');
  const docs = path.join(base, 'Documents');
  const trashDir = path.join(base, 'Papierkorb');
  const outside = path.join(base, 'Geheim');
  for (const d of [desktop, docs, trashDir, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(desktop, 'foto.jpg'), 'BILD-1');
  fs.writeFileSync(path.join(desktop, 'foto kopie.jpg'), 'BILD-1');
  fs.mkdirSync(path.join(desktop, 'alt'));
  fs.writeFileSync(path.join(desktop, 'alt', 'foto.jpg'), 'BILD-1');
  fs.writeFileSync(path.join(desktop, 'bericht.pdf'), 'PDF');
  fs.writeFileSync(path.join(desktop, 'notiz.txt'), 'gleich gross');
  fs.writeFileSync(path.join(desktop, 'andere.txt'), 'gleich GROSS');
  fs.writeFileSync(path.join(outside, 'passwort.txt'), 'nein');

  const trashed = [];
  const files = createFiles({
    roots: { desktop, documents: docs },
    trash: async (p) => { const dest = path.join(trashDir, path.basename(p)); fs.renameSync(p, dest); trashed.push(dest); },
    home: base,
  });

  // Auflisten
  const list = await files.run('list_files', { folder: 'Desktop' });
  assert.match(list.text, /Desktop: 5 Dateien, 1 Ordner/);
  assert.match(list.text, /\[Ordner\] alt\//);
  const deep = await files.run('list_files', { folder: 'Desktop', recursive: true });
  assert.match(deep.text, /alt\/foto\.jpg/);

  // Pfade ausserhalb der Benutzerordner sind verboten
  await assert.rejects(files.run('list_files', { folder: outside }), /ausserhalb/);
  await assert.rejects(files.run('list_files', { folder: 'Desktop/../Geheim' }), /ausserhalb/);
  await assert.rejects(files.run('list_files', { folder: 'C:/Windows/System32' }), /ausserhalb|Benutzerordner/);
  await assert.rejects(files.run('list_files', { folder: 'irgendwo' }), /Benutzerordner/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, path.join(desktop, 'link'));
    await assert.rejects(files.run('list_files', { folder: 'Desktop/link' }), /ausserhalb/, 'Symlink nach draussen');
    fs.unlinkSync(path.join(desktop, 'link'));
  }

  // Duplikate nach Inhalt (gleiche Grösse, anderer Inhalt ist kein Duplikat)
  const dup = await files.run('find_duplicates', { folder: 'Desktop' });
  assert.strictEqual(dup.groups, 1);
  assert.match(dup.text, /Gruppe 1/);
  assert.ok(!/notiz\.txt/.test(dup.text), 'gleiche Grösse, anderer Inhalt');
  assert.strictEqual((dup.text.match(/foto/g) || []).length, 3);

  // Ordner anlegen und verschieben
  const mk = await files.run('create_folder', { path: 'Desktop/Bilder' });
  assert.match(mk.text, /geprüft/);
  const moved = await files.run('move_files', {
    moves: [
      { from: 'Desktop/foto.jpg', to: 'Desktop/Bilder/' },
      { from: 'Desktop/alt/foto.jpg', to: 'Desktop/Bilder' },
      { from: 'Desktop/bericht.pdf', to: 'Dokumente/Schule/bericht.pdf' },
      { from: 'Desktop/fehlt.txt', to: 'Desktop/Bilder/' },
      { from: 'Desktop', to: 'Dokumente/' },
    ],
  });
  assert.strictEqual(moved.done, 3);
  assert.strictEqual(moved.failed, 2);
  assert.ok(fs.existsSync(path.join(desktop, 'Bilder', 'foto.jpg')));
  assert.ok(fs.existsSync(path.join(desktop, 'Bilder', 'foto (2).jpg')), 'nie überschreiben');
  assert.ok(fs.existsSync(path.join(docs, 'Schule', 'bericht.pdf')), 'Zielordner wird angelegt');
  assert.match(moved.text, /umbenannt/);
  assert.match(moved.text, /Hauptordner/);
  await assert.rejects(files.run('move_files', { moves: [{ from: 'Desktop/notiz.txt', to: outside }] }).then((r) => { if (r.error) throw new Error(r.text); }), /ausserhalb/);

  // Papierkorb
  const del = await files.run('delete_files', { paths: ['Desktop/foto kopie.jpg', 'Desktop', 'Desktop/gibtsnicht.txt'] });
  assert.strictEqual(del.done, 1);
  assert.ok(!fs.existsSync(path.join(desktop, 'foto kopie.jpg')));
  assert.strictEqual(trashed.length, 1);
  assert.match(del.text, /Hauptordner werden nie gelöscht/);

  // Anzeige
  assert.strictEqual(files.describe('move_files', { moves: [1, 2] }), '2 Dateien verschoben');
  assert.match(files.summarize('move_files', { moves: [{ from: 'a', to: 'Desktop/Bilder/a.jpg' }, { from: 'b', to: 'Desktop/Texte/' }] }), /2 Dateien verschieben nach Desktop\/Bilder, Desktop\/Texte/);
  assert.match(files.summarize('delete_files', { paths: ['Desktop/x.jpg'] }), /Papierkorb.*x\.jpg/);

  fs.rmSync(base, { recursive: true, force: true });
  console.log('Datei-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
