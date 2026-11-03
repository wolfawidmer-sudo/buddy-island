// Datei-Werkzeuge für Buddy: auflisten, Duplikate finden, Ordner anlegen,
// verschieben und in den Papierkorb legen. Nur in den eigenen Benutzerordnern
// (Desktop, Dokumente, Downloads, Bilder, Musik, Videos), nie systemweit.
// Löschen geht immer in den Papierkorb und lässt sich dort rückgängig machen.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { t } = require('./i18n');

const ALIASES = {
  desktop: 'desktop', schreibtisch: 'desktop',
  dokumente: 'documents', documents: 'documents', dokument: 'documents',
  downloads: 'downloads', download: 'downloads',
  bilder: 'pictures', pictures: 'pictures', fotos: 'pictures',
  musik: 'music', music: 'music',
  videos: 'videos', video: 'videos',
};
const ROOT_LABEL = { desktop: 'Desktop', documents: 'Dokumente', downloads: 'Downloads', pictures: 'Bilder', music: 'Musik', videos: 'Videos' };
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', '.cache']);
const MAX_LIST = 400;
const MAX_SCAN = 5000;
const MAX_HASH_BYTES = 1024 * 1024 * 1024; // grössere Dateien nicht hashen
const MAX_MOVES = 500;
const MAX_DELETES = 200;

const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description:
      'Listet Dateien und Ordner in einem Benutzerordner auf (Desktop, Dokumente, Downloads, Bilder, Musik, Videos). ' +
      'Pfade beginnen mit dem Ordnernamen, z. B. «Desktop» oder «Dokumente/Schule».',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'z. B. «Desktop» oder «Downloads/Fotos»' },
        recursive: { type: 'boolean', description: 'Auch Unterordner (bis 4 Ebenen). Standard: nein.' },
      },
      required: ['folder'],
    },
  },
  {
    name: 'find_duplicates',
    description: 'Findet doppelte Dateien (gleicher Inhalt, per SHA-256 geprüft) in einem Benutzerordner und seinen Unterordnern. Ändert nichts.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'z. B. «Desktop»' },
        recursive: { type: 'boolean', description: 'Unterordner mit durchsuchen. Standard: ja.' },
      },
      required: ['folder'],
    },
  },
  {
    name: 'create_folder',
    description: 'Legt einen Ordner in einem Benutzerordner an (mittleres Risiko).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'z. B. «Desktop/Bilder»' } },
      required: ['path'],
    },
  },
  {
    name: 'move_files',
    description:
      'Verschiebt oder benennt Dateien/Ordner um (mittleres Risiko). Überschreibt nie: Existiert das Ziel schon, bekommt die Datei einen Zusatz wie « (2)». ' +
      'Ist «to» ein Ordner (oder endet mit /), landet die Datei mit gleichem Namen darin. Prüft danach, ob alles am Ziel ist.',
    input_schema: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          description: 'Liste von Verschiebungen (höchstens 500).',
          items: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
          },
        },
      },
      required: ['moves'],
    },
  },
  {
    name: 'delete_files',
    description:
      'Legt Dateien oder Ordner in den Windows-Papierkorb (hohes Risiko, der Nutzer muss jedes Mal zustimmen). Nie endgültig. ' +
      'Nur benutzen, wenn der Nutzer das Löschen ausdrücklich will.',
    input_schema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Pfade, höchstens 200.' } },
      required: ['paths'],
    },
  },
];

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function createFiles({ roots, trash, home = '' }) {
  // roots: { desktop: 'C:\\Users\\…\\Desktop', … }
  const realRoots = {};
  for (const [key, dir] of Object.entries(roots || {})) {
    if (!dir) continue;
    try { realRoots[key] = fs.realpathSync(dir); } catch { realRoots[key] = path.resolve(dir); }
  }

  const sameOrInside = (target, root) => {
    const a = process.platform === 'win32' ? target.toLowerCase() : target;
    const b = process.platform === 'win32' ? root.toLowerCase() : root;
    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  };

  function rootOf(abs) {
    for (const [key, dir] of Object.entries(realRoots)) if (sameOrInside(abs, dir)) return key;
    return null;
  }

  // Echter Pfad (auch für noch nicht existierende Ziele über den nächsten vorhandenen Elternordner)
  function realish(abs) {
    let current = abs;
    const rest = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(current), ...rest.reverse());
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return abs;
        rest.push(path.basename(current));
        current = parent;
      }
    }
  }

  function resolve(input) {
    let p = String(input || '').trim().replace(/^["']|["']$/g, '');
    if (!p) throw new Error('Kein Pfad angegeben.');
    if (p.startsWith('~')) p = path.join(home || '', p.slice(1));
    let abs;
    if (path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p)) {
      abs = path.resolve(p);
    } else {
      const parts = p.split(/[\\/]+/).filter(Boolean);
      const key = ALIASES[String(parts[0] || '').toLowerCase()];
      if (!key || !realRoots[key]) {
        throw new Error(`Pfade müssen mit einem Benutzerordner beginnen (${Object.values(ROOT_LABEL).join(', ')}), z. B. «Desktop/Fotos».`);
      }
      abs = path.resolve(realRoots[key], ...parts.slice(1));
    }
    const real = realish(abs);
    const root = rootOf(real);
    if (!root) throw new Error(`«${input}» liegt ausserhalb deiner Benutzerordner. Buddy arbeitet nur in Desktop, Dokumente, Downloads, Bilder, Musik und Videos.`);
    return { abs: real, root, isRoot: sameOrInside(realRoots[root], real) };
  }

  // Lesbarer Pfad für Claude und das Island, z. B. «Desktop/Fotos/a.jpg»
  function display(abs) {
    const root = rootOf(abs);
    if (!root) return abs;
    const rel = path.relative(realRoots[root], abs);
    return [ROOT_LABEL[root], ...(rel ? rel.split(path.sep) : [])].join('/');
  }

  const exists = async (p) => fsp.access(p).then(() => true, () => false);

  async function walk(dir, { recursive, depth = 0, maxDepth = 4, limit = MAX_SCAN, out = [] }) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (out.length >= limit) break;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        out.push({ path: full, dir: true, depth });
        if (recursive && depth < maxDepth) await walk(full, { recursive, depth: depth + 1, maxDepth, limit, out });
      } else if (e.isFile()) {
        if (/^(desktop\.ini|thumbs\.db)$/i.test(e.name)) continue;
        out.push({ path: full, dir: false, depth });
      }
    }
    return out;
  }

  async function listFiles({ folder, recursive = false }) {
    const { abs } = resolve(folder);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) throw new Error(`Ordner «${folder}» gibt es nicht.`);
    if (!stat.isDirectory()) throw new Error(`«${folder}» ist kein Ordner.`);
    const items = await walk(abs, { recursive: Boolean(recursive), limit: MAX_LIST + 1 });
    const truncated = items.length > MAX_LIST;
    const lines = [];
    let files = 0;
    let dirs = 0;
    for (const item of items.slice(0, MAX_LIST)) {
      const rel = path.relative(abs, item.path).split(path.sep).join('/');
      if (item.dir) {
        dirs += 1;
        lines.push(`[Ordner] ${rel}/`);
      } else {
        files += 1;
        const s = await fsp.stat(item.path).catch(() => null);
        lines.push(`${rel} · ${s ? formatSize(s.size) : '?'} · ${s ? day(s.mtimeMs) : ''}`);
      }
    }
    const head = `${display(abs)}: ${files} Dateien, ${dirs} Ordner${truncated ? ` (nur die ersten ${MAX_LIST} gezeigt)` : ''}`;
    return { text: [head, ...lines].join('\n'), count: files + dirs };
  }

  function hashFile(file, signal) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file);
      const onAbort = () => stream.destroy(Object.assign(new Error('abgebrochen'), { name: 'AbortError' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('data', (d) => hash.update(d));
      stream.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
      stream.on('end', () => { signal?.removeEventListener('abort', onAbort); resolve(hash.digest('hex')); });
    });
  }

  async function findDuplicates({ folder, recursive = true }, signal) {
    const { abs } = resolve(folder);
    const items = (await walk(abs, { recursive: recursive !== false })).filter((i) => !i.dir);
    const bySize = new Map();
    for (const item of items) {
      const s = await fsp.stat(item.path).catch(() => null);
      if (!s || !s.size) continue;
      item.size = s.size;
      item.mtime = s.mtimeMs;
      if (!bySize.has(s.size)) bySize.set(s.size, []);
      bySize.get(s.size).push(item);
    }
    const groups = [];
    let skipped = 0;
    for (const [size, list] of bySize) {
      if (list.length < 2) continue;
      if (size > MAX_HASH_BYTES) { skipped += list.length; continue; }
      const byHash = new Map();
      for (const item of list) {
        if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
        const h = await hashFile(item.path, signal).catch(() => null);
        if (!h) continue;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(item);
      }
      for (const same of byHash.values()) if (same.length > 1) groups.push(same.sort((a, b) => a.mtime - b.mtime));
    }
    if (!groups.length) {
      return { text: `Keine doppelten Dateien in ${display(abs)} gefunden (${items.length} Dateien geprüft${skipped ? `, ${skipped} sehr grosse übersprungen` : ''}).`, groups: 0 };
    }
    let wasted = 0;
    const lines = groups.slice(0, 80).map((g, i) => {
      wasted += g[0].size * (g.length - 1);
      return `Gruppe ${i + 1} (${formatSize(g[0].size)}): ${g.map((x, j) => `${display(x.path)}${j === 0 ? ' [älteste]' : ''}`).join(' | ')}`;
    });
    return {
      text: `${groups.length} Gruppen doppelter Dateien in ${display(abs)} (${items.length} Dateien geprüft, ${formatSize(wasted)} doppelt):\n${lines.join('\n')}${groups.length > 80 ? '\n… weitere Gruppen nicht gezeigt' : ''}`,
      groups: groups.length,
    };
  }

  async function createFolder({ path: target }) {
    const { abs } = resolve(target);
    await fsp.mkdir(abs, { recursive: true });
    const ok = (await fsp.stat(abs).catch(() => null))?.isDirectory();
    if (!ok) throw new Error(`Ordner «${target}» konnte nicht angelegt werden.`);
    return { text: `Ordner angelegt und geprüft: ${display(abs)}` };
  }

  async function uniqueTarget(dest) {
    if (!(await exists(dest))) return dest;
    const dir = path.dirname(dest);
    const ext = path.extname(dest);
    const base = path.basename(dest, ext);
    for (let i = 2; i < 1000; i += 1) {
      const candidate = path.join(dir, `${base} (${i})${ext}`);
      if (!(await exists(candidate))) return candidate;
    }
    throw new Error('Kein freier Dateiname gefunden.');
  }

  async function moveOne(from, to) {
    const src = resolve(from);
    if (src.isRoot) throw new Error(`«${from}» ist ein Hauptordner und wird nicht verschoben.`);
    const srcStat = await fsp.stat(src.abs).catch(() => null);
    if (!srcStat) throw new Error(`«${from}» gibt es nicht (mehr).`);
    const target = resolve(to);
    const toDir = /[\\/]$/.test(String(to).trim()) || (await fsp.stat(target.abs).catch(() => null))?.isDirectory();
    let dest = toDir ? path.join(target.abs, path.basename(src.abs)) : target.abs;
    if (dest === src.abs) return { from: display(src.abs), to: display(dest), ok: true, note: 'schon am Ziel' };
    if (srcStat.isDirectory() && sameOrInside(dest, src.abs)) throw new Error('Ein Ordner kann nicht in sich selbst verschoben werden.');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    dest = await uniqueTarget(dest);
    try {
      await fsp.rename(src.abs, dest);
    } catch (err) {
      if (err.code !== 'EXDEV' || srcStat.isDirectory()) throw err;
      await fsp.copyFile(src.abs, dest, fs.constants.COPYFILE_EXCL);
      await fsp.unlink(src.abs);
    }
    // Prüfen statt annehmen
    const arrived = await exists(dest);
    const gone = !(await exists(src.abs));
    if (!arrived || !gone) throw new Error(`Verschieben von «${from}» nicht bestätigt.`);
    return { from: display(src.abs), to: display(dest), ok: true, renamed: path.basename(dest) !== path.basename(src.abs) };
  }

  async function moveFiles({ moves }, signal) {
    if (!Array.isArray(moves) || !moves.length) throw new Error('«moves» braucht mindestens einen Eintrag.');
    if (moves.length > MAX_MOVES) throw new Error(`Höchstens ${MAX_MOVES} Verschiebungen auf einmal.`);
    const done = [];
    const failed = [];
    for (const m of moves) {
      if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      try {
        done.push(await moveOne(m.from, m.to));
      } catch (err) {
        failed.push({ from: m.from, error: err.message });
      }
    }
    const lines = done.map((d) => `✓ ${d.from} → ${d.to}${d.renamed ? ' (umbenannt, Ziel existierte schon)' : ''}${d.note ? ` (${d.note})` : ''}`);
    for (const f of failed) lines.push(`✗ ${f.from}: ${f.error}`);
    return {
      text: `Verschoben und geprüft: ${done.length} von ${moves.length}.${failed.length ? ` ${failed.length} fehlgeschlagen.` : ''}\n${lines.join('\n')}`,
      error: done.length === 0,
      done: done.length,
      failed: failed.length,
    };
  }

  async function deleteFiles({ paths }, signal) {
    if (!Array.isArray(paths) || !paths.length) throw new Error('«paths» braucht mindestens einen Pfad.');
    if (paths.length > MAX_DELETES) throw new Error(`Höchstens ${MAX_DELETES} Dateien auf einmal.`);
    if (typeof trash !== 'function') throw new Error('Papierkorb ist nicht verfügbar.');
    const done = [];
    const failed = [];
    for (const p of paths) {
      if (signal?.aborted) throw Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
      try {
        const target = resolve(p);
        if (target.isRoot) throw new Error('Hauptordner werden nie gelöscht.');
        if (!(await exists(target.abs))) throw new Error('gibt es nicht (mehr)');
        await trash(target.abs);
        if (await exists(target.abs)) throw new Error('liegt noch am alten Ort');
        done.push(display(target.abs));
      } catch (err) {
        failed.push(`${p}: ${err.message}`);
      }
    }
    return {
      text: `In den Papierkorb gelegt und geprüft: ${done.length} von ${paths.length}.${done.length ? `\n${done.map((d) => `✓ ${d}`).join('\n')}` : ''}${failed.length ? `\n${failed.map((f) => `✗ ${f}`).join('\n')}` : ''}`,
      error: done.length === 0,
      done: done.length,
    };
  }

  async function run(name, input = {}, signal) {
    switch (name) {
      case 'list_files': return listFiles(input);
      case 'find_duplicates': return findDuplicates(input, signal);
      case 'create_folder': return createFolder(input);
      case 'move_files': return moveFiles(input, signal);
      case 'delete_files': return deleteFiles(input, signal);
      default: return { error: true, text: `Unbekanntes Werkzeug: ${name}` };
    }
  }

  function describe(name, input = {}) {
    const n = Array.isArray(input.moves) ? input.moves.length : Array.isArray(input.paths) ? input.paths.length : 0;
    switch (name) {
      case 'list_files': return t('{folder} angeschaut', { folder: input.folder || t('Ordner') });
      case 'find_duplicates': return t('Duplikate gesucht');
      case 'create_folder': return t('Ordner {name} angelegt', { name: String(input.path || '').split(/[\\/]/).pop() });
      case 'move_files': return n === 1 ? t('1 Datei verschoben') : t('{n} Dateien verschoben', { n });
      case 'delete_files': return t('{n} in den Papierkorb', { n });
      default: return name;
    }
  }

  // Kurzer Text für die Freigabe-Karte
  function summarize(name, input = {}) {
    if (name === 'move_files' && Array.isArray(input.moves)) {
      const targets = [...new Set(input.moves.map((m) => String(m.to || '').replace(/[\\/][^\\/]*\.[^\\/]+$/, '').replace(/[\\/]$/, '')))];
      const n = input.moves.length;
      const more = targets.length > 3 ? t(' und {n} weitere Ordner', { n: targets.length - 3 }) : '';
      return (n === 1 ? t('1 Datei verschieben nach {to}', { to: targets.slice(0, 3).join(', ') }) : t('{n} Dateien verschieben nach {to}', { n, to: targets.slice(0, 3).join(', ') })) + more;
    }
    if (name === 'delete_files' && Array.isArray(input.paths)) {
      const list = input.paths.slice(0, 4).map((p) => String(p).split(/[\\/]/).pop()).join(', ') + (input.paths.length > 4 ? ' …' : '');
      return input.paths.length === 1 ? t('1 Datei in den Papierkorb legen: {list}', { list }) : t('{n} Dateien in den Papierkorb legen: {list}', { n: input.paths.length, list });
    }
    if (name === 'create_folder') return t('Ordner «{path}» anlegen', { path: input.path });
    return describe(name, input);
  }

  return { definitions: TOOL_DEFINITIONS, run, describe, summarize, resolve, display, names: new Set(TOOL_DEFINITIONS.map((d) => d.name)) };
}

module.exports = { createFiles, TOOL_DEFINITIONS, formatSize };
