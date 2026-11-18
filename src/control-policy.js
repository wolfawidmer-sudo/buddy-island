// Regeln und Auswertung für Ton- und App-Steuerung (ohne Windows-Aufrufe, darum testbar).
// Die eigentlichen Aufrufe macht src/control.js.

// Prozesse, die Buddy nie beendet (auch nicht mit Freigabe). Ihre Fenster schliesst Buddy
// höchstens sanft, und nur bei den zwei Ausnahmen unten (Ordnerfenster, Store-Apps).
const SYSTEM_PROCESSES = new Set([
  'system', 'idle', 'registry', 'memory compression', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
  'svchost', 'dwm', 'fontdrvhost', 'sihost', 'ctfmon', 'explorer', 'shellexperiencehost', 'startmenuexperiencehost',
  'shellhost', 'searchhost', 'searchapp', 'searchui', 'textinputhost', 'runtimebroker', 'applicationframehost', 'lockapp',
  'logonui', 'userinit', 'msmpeng', 'nissrv', 'mpdefendercoreservice', 'securityhealthservice', 'securityhealthsystray',
  'securityhealthhost', 'smartscreen', 'audiodg', 'conhost', 'spoolsv', 'wudfhost', 'dllhost', 'taskhostw', 'consent',
  'werfault', 'wermgr', 'trustedinstaller', 'tiworker', 'msiexec', 'taskmgr',
]);

// Fenster dieser Klassen gehören zwar Systemprozessen, sind aber normale Fenster:
// Explorer-Ordner und Store-Apps (Rechner, Einstellungen …). Sanft schliessen ist ok, hart nie.
const SOFT_CLOSE_OK = new Set(['explorer:cabinetwclass', 'applicationframehost:applicationframewindow']);

// Fenster, die nie als App gelten (Desktop, Taskleiste)
const SHELL_CLASSES = new Set(['progman', 'workerw', 'shell_traywnd', 'shell_secondarytraywnd']);

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().trim();
const procName = (s) => norm(s).replace(/\.exe$/, '');

// Text des Helfers: Zeilen mit Tab-getrennten Feldern
function rows(text, kind) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map((l) => l.split('\t')).filter((f) => !kind || f[0] === kind);
}

const int = (x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; };

function parseWindows(text) {
  return rows(text, 'win')
    .map(([, hwnd, pid, process, cls, state, front, ...title]) => ({
      id: String(hwnd), pid: int(pid), process: process || '', cls: cls || '', state: state || 'normal',
      front: front === '1', title: title.join(' ').trim(),
    }))
    .filter((w) => w.id && !SHELL_CLASSES.has(norm(w.cls)));
}

function parseStatus(text) {
  const out = { master: null, mic: null, apps: [] };
  for (const f of rows(text)) {
    if (f[0] === 'master') out.master = { level: int(f[1]), muted: f[2] === '1', device: f[3] || '' };
    else if (f[0] === 'mic') out.mic = { level: int(f[1]), muted: f[2] === '1', device: f[3] || '' };
    else if (f[0] === 'app') out.apps.push({ pid: int(f[1]), process: f[2] || '', level: int(f[3]), muted: f[4] === '1', name: f[5] || '' });
  }
  return out;
}

function parseDevices(text) {
  return rows(text, 'device').map(([, flow, def, id, ...name]) => ({ flow, isDefault: def === '1', id: id || '', name: name.join(' ').trim() }));
}

function parseInstalled(text) {
  const seen = new Set();
  return rows(text, 'installed')
    .map(([, id, ...name]) => ({ id: id || '', name: name.join(' ').trim() }))
    .filter((a) => a.id && a.name && !seen.has(a.id) && seen.add(a.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Was ist «Buddy selbst»? Eigene Prozess-IDs und der Name der eigenen exe.
function isSelf(win, own = {}) {
  if ((own.pids || []).includes(win.pid)) return true;
  return Boolean(own.name) && procName(win.process) === procName(own.name);
}

function isSystem(win) {
  return SYSTEM_PROCESSES.has(procName(win.process));
}

// Ungespeicherte Änderungen sind nur am Titel erkennbar (nicht bei allen Apps):
// «*Unbenannt – Editor», «● datei.js – Visual Studio Code», «Dokument* – …», «(Geändert)»
function looksUnsaved(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  if (/^[*•●]/.test(t)) return true;
  if (/^\S[^–—|]*\*\s*[-–—|]/.test(t)) return true;
  if (/(^|\s)[•●](\s|$)/.test(t)) return true;
  return /\((geändert|modified|modifié|non enregistré|nicht gespeichert|unsaved)\)/i.test(t);
}

// Fenster zu einer Angabe suchen: Fenster-ID, Prozessname oder Teil des Titels
function findWindows(list, { app, windowId } = {}) {
  if (windowId != null && String(windowId).trim()) return list.filter((w) => w.id === String(windowId).trim());
  const q = norm(app);
  if (!q) return [];
  const exact = list.filter((w) => procName(w.process) === procName(q));
  if (exact.length) return exact;
  return list.filter((w) => norm(w.title).includes(q) || procName(w.process).includes(procName(q)));
}

// Darf Buddy diese Fenster schliessen? force = hart beenden, allowUnsaved = trotz Änderungen
// Rückgabe { ok } | { blocked: 'self'|'system'|'many' } | { unsaved: [Fenster] }
function closeCheck(wins, { force = false, allowUnsaved = false, own = {} } = {}) {
  if (!wins.length) return { blocked: 'none' };
  if (wins.length > 10) return { blocked: 'many' };
  for (const w of wins) {
    if (isSelf(w, own)) return { blocked: 'self', win: w };
    if (isSystem(w)) {
      const soft = SOFT_CLOSE_OK.has(`${procName(w.process)}:${norm(w.cls)}`);
      if (force || !soft) return { blocked: 'system', win: w };
    }
  }
  const unsaved = wins.filter((w) => looksUnsaved(w.title));
  if (unsaved.length && !allowUnsaved && !force) return { unsaved };
  return { ok: true };
}

// Fenster bewegen ist bei Buddy selbst und bei der Taskleiste nicht erlaubt
function windowCheck(win, own = {}) {
  if (isSelf(win, own)) return 'self';
  return null;
}

// Gerät zu einer Angabe suchen (ID oder Teil des Namens), nur Ausgabegeräte
function findDevice(devices, query, flow = 'out') {
  const list = devices.filter((d) => d.flow === flow);
  const q = norm(query);
  if (!q) return null;
  return list.find((d) => norm(d.id) === q) || list.find((d) => norm(d.name) === q) || list.find((d) => norm(d.name).includes(q)) || null;
}

// Audio-Sitzungen einer App (Prozessname oder Anzeigename)
function findSessions(apps, query) {
  const q = norm(query);
  if (!q) return [];
  const exact = apps.filter((a) => procName(a.process) === procName(q));
  if (exact.length) return exact;
  return apps.filter((a) => procName(a.process).includes(procName(q)) || (a.name && norm(a.name).includes(q)));
}

// Installierte App zu einem Namen suchen
function findInstalled(list, query) {
  const q = norm(query);
  if (!q) return [];
  const exact = list.filter((a) => norm(a.name) === q);
  if (exact.length) return exact;
  const starts = list.filter((a) => norm(a.name).startsWith(q));
  if (starts.length) return starts;
  return list.filter((a) => norm(a.name).includes(q));
}

// App-ID aus der Liste darf an explorer.exe (shell:AppsFolder\…) gehen
function safeAppId(id) {
  const s = String(id || '');
  return s.length > 0 && s.length <= 400 && !/["\u0000-\u001f]/.test(s) && !/^\s*-/.test(s);
}

// Lautstärke-Angaben prüfen: level 0–100 oder change −100…100, mute true/false
function volumeArgs(input = {}) {
  const has = (k) => input[k] !== undefined && input[k] !== null && input[k] !== '';
  const out = { level: -1, change: 0, mute: -1 };
  if (has('level')) {
    const n = Number(input.level);
    if (!Number.isFinite(n)) return { error: 'level muss eine Zahl von 0 bis 100 sein.' };
    out.level = Math.max(0, Math.min(100, Math.round(n)));
  }
  if (has('change')) {
    const n = Number(input.change);
    if (!Number.isFinite(n)) return { error: 'change muss eine Zahl von -100 bis 100 sein.' };
    out.change = Math.max(-100, Math.min(100, Math.round(n)));
  }
  if (has('mute')) out.mute = input.mute === true || input.mute === 'true' ? 1 : 0;
  if (out.level < 0 && !out.change && out.mute < 0) return { error: 'Gib level, change oder mute an.' };
  return out;
}

module.exports = {
  SYSTEM_PROCESSES, parseWindows, parseStatus, parseDevices, parseInstalled, isSelf, isSystem, looksUnsaved,
  findWindows, closeCheck, windowCheck, findDevice, findSessions, findInstalled, safeAppId, volumeArgs, norm, procName,
};
