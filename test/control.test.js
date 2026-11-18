// Tests: Ton- und App-Steuerung (src/control-policy.js, src/control-tools.js, src/control.js, Freigaben).
// Windows-Aufrufe sind simuliert. Ist pwsh installiert (BUDDY_PWSH oder im PATH), läuft zusätzlich
// der echte PowerShell-Helfer (Add-Type + Protokoll; die Windows-Funktionen selbst melden dort Fehler).
const assert = require('assert');
// src/tools.js lädt electron (nur für shell): hier ein leerer Ersatz, damit der Test ohne Electron läuft
const Module = require('module');
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? { shell: {} } : load.call(this, request, ...rest); };
const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const P = require('../src/control-policy');
const { createControlTools } = require('../src/control-tools');
const { createControl, parseReply, encodeCommand } = require('../src/control');
const permissions = require('../src/permissions');
const { createTools } = require('../src/tools');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('✓', name); };

const WINDOWS = [
  'win\t100\t10\tnotepad\tNotepad\tnormal\t1\t*Unbenannt – Editor',
  'win\t101\t11\tchrome\tChrome_WidgetWin_1\tmax\t0\tYouTube – Google Chrome',
  'win\t102\t11\tchrome\tChrome_WidgetWin_1\tnormal\t0\tMail – Google Chrome',
  'win\t103\t12\texplorer\tCabinetWClass\tnormal\t0\tDownloads',
  'win\t104\t13\tApplicationFrameHost\tApplicationFrameWindow\tnormal\t0\tRechner',
  'win\t105\t14\tBuddy Island\tChrome_WidgetWin_1\tnormal\t0\tBuddy Island',
  'win\t106\t15\tCode\tChrome_WidgetWin_1\tnormal\t0\t● app.js – buddy – Visual Studio Code',
  'win\t107\t16\tsvchost\tSomething\tnormal\t0\tDienst',
  'win\t108\t12\texplorer\tProgman\tnormal\t0\tProgram Manager',
].join('\n');

const STATUS = [
  'master\t40\t0\tLautsprecher (Realtek)',
  'mic\t80\t0\tMikrofon (USB)',
  'app\t20\tSpotify\t100\t0\t',
  'app\t11\tchrome\t70\t0\t',
  'app\t21\tchrome\t70\t0\t',
].join('\n');

const DEVICES = [
  'device\tout\t1\t{0.0.0.00000000}.{aaa}\tLautsprecher (Realtek)',
  'device\tout\t0\t{0.0.0.00000000}.{bbb}\tKopfhörer (WH-1000XM5)',
  'device\tin\t1\t{0.0.1.00000000}.{ccc}\tMikrofon (USB)',
].join('\n');

// Simulierter Helfer: merkt sich Aufrufe, antwortet wie der echte
function fakeControl(over = {}) {
  const calls = [];
  let master = { level: 40, mute: 0 };
  let defaultId = '{0.0.0.00000000}.{aaa}';
  const answers = {
    windows: () => WINDOWS,
    status: () => STATUS.replace('master\t40\t0', `master\t${master.level}\t${master.mute}`),
    devices: () => DEVICES.replace(/device\tout\t[01]\t(\S+)/g, (m, id) => `device\tout\t${id === defaultId ? 1 : 0}\t${id}`),
    installed: () => 'installed\tMicrosoft.WindowsCalculator_8wekyb3d8bbwe!App\tRechner\ninstalled\tcom.squirrel.Discord.Discord\tDiscord\ninstalled\tMicrosoft.Office.WINWORD.EXE.15\tWord\ninstalled\tbad"id\tKaputt',
    master: (level, mute) => {
      const b = { ...master };
      if (level >= 0) master.level = level;
      if (mute >= 0) master.mute = mute;
      return `set\t${b.level}\t${b.mute}\t${master.level}\t${master.mute}\n`;
    },
    mic: (level, mute) => `set\t80\t0\t80\t${mute >= 0 ? mute : 0}\n`,
    app: (pids, level, mute) => pids.split(',').map((pid) => `app\t${pid}\t${pid === '20' ? 'Spotify' : 'chrome'}\t70\t0\t${level >= 0 ? level : 70}\t${mute >= 0 ? mute : 0}`).join('\n'),
    default: (id) => { defaultId = id; return 'ok\tKopfhörer\n'; },
    close: () => 'closed\n',
    kill: () => 'killed\n',
    focus: () => 'front\n',
    show: (id, cmd) => ({ 6: 'min\n', 3: 'max\n', 9: 'normal\n' }[cmd]),
    move: () => 'ok\n',
    ...over,
  };
  return {
    calls,
    async call(cmd, ...args) {
      calls.push([cmd, ...args]);
      const f = answers[cmd];
      if (!f) throw new Error('Unbekannter Befehl');
      return f(...args);
    },
  };
}

const own = { pids: [14], name: 'Buddy Island' };

(async () => {
  // ---------- Auswertung ----------
  await test('Fensterliste: Felder, Titel mit Tabs, Desktop/Taskleiste ausgeblendet', () => {
    const list = P.parseWindows(WINDOWS + '\nwin\t200\t30\tfoo\tX\tmin\t0\tA\tB');
    assert.strictEqual(list.length, 9);
    assert.deepStrictEqual(list[0], { id: '100', pid: 10, process: 'notepad', cls: 'Notepad', state: 'normal', front: true, title: '*Unbenannt – Editor' });
    assert.ok(!list.some((w) => w.cls === 'Progman'));
    assert.strictEqual(list.at(-1).title, 'A B');
  });

  await test('Status und Geräte lesen', () => {
    const s = P.parseStatus(STATUS);
    assert.deepStrictEqual(s.master, { level: 40, muted: false, device: 'Lautsprecher (Realtek)' });
    assert.strictEqual(s.mic.device, 'Mikrofon (USB)');
    assert.strictEqual(s.apps.length, 3);
    const d = P.parseDevices(DEVICES);
    assert.strictEqual(d.filter((x) => x.flow === 'out').length, 2);
    assert.strictEqual(P.findDevice(d, 'kopfhörer').name, 'Kopfhörer (WH-1000XM5)');
    assert.strictEqual(P.findDevice(d, 'Mikrofon'), null, 'nur Ausgabegeräte');
  });

  await test('Ungespeichert am Titel erkennen (Editor, VS Code, Word-Stern, «geändert»)', () => {
    for (const t of ['*Unbenannt – Editor', '● app.js – Visual Studio Code', 'Dokument1* - Word', 'Brief.txt (geändert) - App', 'notes • Obsidian'])
      assert.ok(P.looksUnsaved(t), t);
    for (const t of ['Rechner', 'YouTube – Google Chrome', 'Downloads', 'C++ Primer.pdf - Adobe', ''])
      assert.ok(!P.looksUnsaved(t), t);
  });

  await test('Fenster finden: ID, Prozessname, Titel; Gross/Klein und .exe egal', () => {
    const list = P.parseWindows(WINDOWS);
    assert.strictEqual(P.findWindows(list, { windowId: '103' })[0].title, 'Downloads');
    assert.strictEqual(P.findWindows(list, { app: 'Chrome.exe' }).length, 2);
    assert.strictEqual(P.findWindows(list, { app: 'rechner' })[0].id, '104');
    assert.strictEqual(P.findWindows(list, { app: '' }).length, 0);
  });

  await test('Schliessen: Buddy selbst und Systemprozesse nie, Ordner und Store-Apps nur sanft, Ungespeichertes fragt', () => {
    const list = P.parseWindows(WINDOWS);
    const w = (id) => list.filter((x) => x.id === id);
    assert.strictEqual(P.closeCheck(w('105'), { own }).blocked, 'self');
    assert.strictEqual(P.closeCheck([{ ...w('101')[0], pid: 14 }], { own }).blocked, 'self', 'eigene PID');
    assert.strictEqual(P.closeCheck(w('107'), { own }).blocked, 'system');
    assert.strictEqual(P.closeCheck(w('107'), { own, force: true }).blocked, 'system');
    assert.ok(P.closeCheck(w('103'), { own }).ok, 'Ordnerfenster sanft');
    assert.strictEqual(P.closeCheck(w('103'), { own, force: true }).blocked, 'system', 'Explorer nie hart');
    assert.ok(P.closeCheck(w('104'), { own }).ok, 'Store-App sanft');
    assert.strictEqual(P.closeCheck(w('104'), { own, force: true }).blocked, 'system');
    assert.strictEqual(P.closeCheck(w('100'), { own }).unsaved.length, 1);
    assert.ok(P.closeCheck(w('100'), { own, allowUnsaved: true }).ok);
    assert.ok(P.closeCheck(w('101'), { own }).ok);
    assert.strictEqual(P.closeCheck([], { own }).blocked, 'none');
    assert.strictEqual(P.closeCheck(Array(11).fill(w('101')[0]), { own }).blocked, 'many');
  });

  await test('Lautstärke-Angaben prüfen und begrenzen', () => {
    assert.deepStrictEqual(P.volumeArgs({ level: 140 }), { level: 100, change: 0, mute: -1 });
    assert.deepStrictEqual(P.volumeArgs({ change: -10 }), { level: -1, change: -10, mute: -1 });
    assert.deepStrictEqual(P.volumeArgs({ mute: true }), { level: -1, change: 0, mute: 1 });
    assert.deepStrictEqual(P.volumeArgs({ mute: false }), { level: -1, change: 0, mute: 0 });
    assert.ok(P.volumeArgs({}).error);
    assert.ok(P.volumeArgs({ level: 'laut' }).error);
  });

  await test('App-ID: nur saubere IDs an explorer.exe', () => {
    assert.ok(P.safeAppId('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'));
    assert.ok(P.safeAppId('{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe'));
    assert.ok(!P.safeAppId('a"b'));
    assert.ok(!P.safeAppId('-x'));
    assert.ok(!P.safeAppId('a\nb'));
    assert.ok(!P.safeAppId('x'.repeat(401)));
  });

  // ---------- Freigaben ----------
  await test('Risiko: Ton/Fenster niedrig, hart beenden oder ohne Speichern hoch', () => {
    for (const name of ['audio_status', 'list_apps', 'set_volume', 'set_audio_device', 'set_microphone', 'launch_app', 'window_control', 'close_app'])
      assert.strictEqual(permissions.classify({ name, input: {} }).level, 'low', name);
    const force = permissions.classify({ name: 'close_app', input: { app: 'chrome', force: true } });
    assert.strictEqual(force.level, 'high');
    assert.strictEqual(force.category, 'force');
    assert.match(force.summary, /chrome hart beenden/);
    const unsaved = permissions.classify({ name: 'close_app', input: { app: 'notepad', allow_unsaved: true } });
    assert.strictEqual(unsaved.level, 'high');
    assert.strictEqual(permissions.decide(force, { medium: 'allow', high: 'ask' }, { medium: true }), 'ask', 'nie automatisch');
    assert.strictEqual(permissions.decide(force, { high: 'block' }, {}), 'deny');
    assert.strictEqual(permissions.decide(permissions.classify({ name: 'set_volume', input: {} }), {}, {}), 'allow');
  });

  // ---------- Werkzeuge mit simuliertem Helfer ----------
  await test('Werkzeuge erscheinen in createTools und werden weitergereicht', async () => {
    const c = fakeControl();
    const tools = createTools({ onTimersChanged() {}, onTimerDone() {}, control: createControlTools({ control: c, getOwn: () => own }) });
    const names = tools.definitions.map((d) => d.name);
    for (const x of ['set_timer', 'audio_status', 'close_app', 'window_control']) assert.ok(names.includes(x), x);
    assert.strictEqual(new Set(names).size, names.length, 'keine doppelten Namen');
    assert.strictEqual(tools.describe('set_volume', { app: 'spotify', level: 30 }), 'Lautstärke Spotify: 30 %');
    assert.strictEqual(tools.describe('set_timer', { minutes: 10, label: 'Pizza' }), 'Timer 10 Min. · Pizza');
    const r = await tools.run('set_volume', { level: 25 });
    assert.match(r.text, /vorher 40 %, jetzt 25 %/);
    const plain = createTools({ onTimersChanged() {}, onTimerDone() {} });
    assert.ok(!plain.definitions.some((d) => d.name === 'audio_status'), 'ohne Helfer keine Ton-Werkzeuge');
  });

  await test('Lautstärke gesamt: absolut, relativ, stumm; Verlauf zeigt vorher → nachher', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    let r = await ct.run('set_volume', { change: -15 });
    assert.deepStrictEqual(c.calls.at(-1), ['master', 25, -1]);
    assert.strictEqual(r.label, 'Lautstärke: 40 → 25 %');
    r = await ct.run('set_volume', { mute: true });
    assert.deepStrictEqual(c.calls.at(-1), ['master', -1, 1]);
    assert.strictEqual(r.label, 'Ton stumm');
    r = await ct.run('set_volume', { change: 200 });
    assert.deepStrictEqual(c.calls.at(-1), ['master', 100, -1]);
    assert.ok((await ct.run('set_volume', {})).error);
  });

  await test('Lautstärke pro App: alle Sitzungen der App, unbekannte App mit Liste', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    const r = await ct.run('set_volume', { app: 'chrome', level: 30 });
    assert.deepStrictEqual(c.calls.at(-1), ['app', '11,21', 30, -1]);
    assert.strictEqual(r.label, 'Lautstärke Chrome: 70 → 30 %');
    const m = await ct.run('set_volume', { app: 'Spotify', mute: true });
    assert.strictEqual(m.label, 'Spotify stumm');
    const miss = await ct.run('set_volume', { app: 'discord', level: 10 });
    assert.ok(miss.error);
    assert.match(miss.text, /Spotify, chrome/);
  });

  await test('Ausgabegerät wechseln: Name, schon aktiv, unbekannt, Windows lehnt ab', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    const r = await ct.run('set_audio_device', { device: 'kopfhörer' });
    assert.ok(!r.error, r.text);
    assert.deepStrictEqual(c.calls.find((x) => x[0] === 'default'), ['default', '{0.0.0.00000000}.{bbb}']);
    assert.strictEqual(r.label, 'Ausgabe: Kopfhörer (WH-1000XM5)');
    assert.match((await ct.run('set_audio_device', { device: 'kopfhörer' })).text, /schon/);
    assert.ok((await ct.run('set_audio_device', { device: 'Beamer' })).error);
    const bad = createControlTools({ control: fakeControl({ default: () => { throw new Error('Gerätewechsel abgelehnt (0x80004002)'); } }), getOwn: () => own });
    const e = await bad.run('set_audio_device', { device: 'kopf' });
    assert.ok(e.error);
    assert.match(e.text, /open_settings «ton»/);
    const noEffect = createControlTools({ control: fakeControl({ default: () => 'ok\tx\n' }), getOwn: () => own });
    assert.match((await noEffect.run('set_audio_device', { device: 'kopf' })).text, /nicht gegriffen/);
  });

  await test('Mikrofon stumm/an', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    const r = await ct.run('set_microphone', { mute: true });
    assert.deepStrictEqual(c.calls.at(-1), ['mic', -1, 1]);
    assert.strictEqual(r.label, 'Mikrofon stumm');
    assert.strictEqual((await ct.run('set_microphone', { mute: false })).label, 'Mikrofon an');
  });

  await test('Ton-Übersicht für die KI', async () => {
    const ct = createControlTools({ control: fakeControl(), getOwn: () => own });
    const r = await ct.run('audio_status', {});
    assert.match(r.text, /Gesamt: 40 %/);
    assert.match(r.text, /- chrome: 70 %/);
    assert.strictEqual((r.text.match(/- chrome/g) || []).length, 1, 'Chrome nur einmal');
    assert.match(r.text, /Kopfhörer \(WH-1000XM5\)\n/);
    assert.match(r.text, /Lautsprecher \(Realtek\) \(aktiv\)/);
  });

  await test('Apps auflisten: laufend ohne Buddy, installiert mit Filter, Liste wird zwischengespeichert', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    const run = await ct.run('list_apps', { kind: 'running' });
    assert.match(run.text, /101 · chrome · max · YouTube/);
    assert.ok(!/Buddy Island/.test(run.text));
    const inst = await ct.run('list_apps', { kind: 'installed', query: 'disc' });
    assert.match(inst.text, /Discord/);
    assert.ok(!/Word/.test(inst.text));
    await ct.run('list_apps', { kind: 'installed' });
    assert.strictEqual(c.calls.filter((x) => x[0] === 'installed').length, 1);
  });

  await test('App starten: nur IDs aus der Liste, mehrdeutig fragt nach', async () => {
    const started = [];
    const ct = createControlTools({ control: fakeControl(), getOwn: () => own, launch: async (id) => started.push(id) });
    const r = await ct.run('launch_app', { name: 'discord' });
    assert.ok(!r.error);
    assert.deepStrictEqual(started, ['com.squirrel.Discord.Discord']);
    assert.ok((await ct.run('launch_app', { name: 'Photoshop' })).error);
    assert.ok((await ct.run('launch_app', { name: 'Kaputt' })).error, 'unsichere ID');
    assert.strictEqual(started.length, 1);
  });

  await test('App schliessen: sanft per WM_CLOSE, alle Fenster der App', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    const r = await ct.run('close_app', { app: 'chrome' });
    assert.ok(!r.error, r.text);
    assert.deepStrictEqual(c.calls.filter((x) => x[0] === 'close'), [['close', '101'], ['close', '102']]);
    assert.ok(!c.calls.some((x) => x[0] === 'kill'));
    assert.strictEqual(r.label, 'Chrome geschlossen');
  });

  await test('App schliessen: Ungespeichertes, Buddy, System, bleibt offen, hart nur auf Wunsch', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    const u = await ct.run('close_app', { app: 'notepad' });
    assert.ok(u.error);
    assert.match(u.text, /ungespeicherte Änderungen/);
    assert.ok(!c.calls.some((x) => x[0] === 'close'), 'nichts geschlossen');
    assert.ok(!(await ct.run('close_app', { app: 'notepad', allow_unsaved: true })).error);
    assert.match((await ct.run('close_app', { app: 'Buddy Island' })).text, /nicht selbst/);
    assert.match((await ct.run('close_app', { app: 'svchost' })).text, /Teil von Windows/);
    assert.match((await ct.run('close_app', { app: 'explorer', force: true })).text, /Teil von Windows/);
    assert.ok(!c.calls.some((x) => x[0] === 'kill'));
    const k = await ct.run('close_app', { app: 'chrome', force: true });
    assert.deepStrictEqual(c.calls.filter((x) => x[0] === 'kill'), [['kill', 11]], 'eine PID pro Prozess');
    assert.strictEqual(k.label, 'Chrome beendet');
    const stuck = createControlTools({ control: fakeControl({ close: () => 'open\n' }), getOwn: () => own });
    const s = await stuck.run('close_app', { app: 'Code', allow_unsaved: true });
    assert.ok(s.error);
    assert.match(s.text, /noch offen/);
    assert.ok((await ct.run('close_app', { app: 'gibtsnicht' })).text.includes('Offene Fenster'));
  });

  await test('Fenster anordnen: Vordergrund, min/max, Hälften, verschieben, anderer Bildschirm', async () => {
    const c = fakeControl();
    const ct = createControlTools({ control: c, getOwn: () => own });
    assert.strictEqual((await ct.run('window_control', { action: 'focus', app: 'rechner' })).label, 'Rechner im Vordergrund');
    assert.deepStrictEqual(c.calls.at(-1), ['focus', '104']);
    await ct.run('window_control', { action: 'minimize', window_id: '101' });
    assert.deepStrictEqual(c.calls.at(-1), ['show', '101', 6]);
    await ct.run('window_control', { action: 'left', app: 'notepad' });
    assert.deepStrictEqual(c.calls.at(-1), ['move', '100', 'left', 0, 0, 0, 0]);
    await ct.run('window_control', { action: 'move', app: 'notepad', x: 150, y: -5, width: 50 });
    assert.deepStrictEqual(c.calls.at(-1), ['move', '100', 'move', 100, 0, 50, 70]);
    await ct.run('window_control', { action: 'next_monitor', app: 'notepad' });
    assert.deepStrictEqual(c.calls.at(-1), ['move', '100', 'next', 0, 0, 0, 0]);
    assert.ok((await ct.run('window_control', { action: 'maximize', app: 'Buddy Island' })).error);
    const one = createControlTools({ control: fakeControl({ move: () => 'single\n' }), getOwn: () => own });
    assert.match((await one.run('window_control', { action: 'next_monitor', app: 'notepad' })).text, /nur ein Bildschirm/);
    const behind = createControlTools({ control: fakeControl({ focus: () => 'behind\n' }), getOwn: () => own });
    assert.ok((await behind.run('window_control', { action: 'focus', app: 'notepad' })).error);
  });

  // ---------- Helfer-Protokoll ----------
  await test('Protokoll: Auftrag mit Base64-Argumenten, Antwort lesen', () => {
    const line = encodeCommand('c1', 'app', ['11,21', 30, 'a\tb\nc']);
    const parts = line.split('\t');
    assert.strictEqual(parts.length, 5);
    assert.strictEqual(Buffer.from(parts[4], 'base64').toString(), 'a\tb\nc');
    assert.deepStrictEqual(parseReply(`c1\tok\t${Buffer.from('win\t1').toString('base64')}`), { id: 'c1', ok: true, text: 'win\t1' });
    assert.strictEqual(parseReply('kaputt'), null);
  });

  await test('Helfer: nur unter Windows, Antworten der Reihe nach zugeordnet, Absturz beendet offene Aufträge', async () => {
    const off = createControl({ scriptDir: os.tmpdir(), platform: 'linux' });
    await assert.rejects(off.call('status'), /nur unter Windows/);
    const { EventEmitter } = require('events');
    let child;
    const spawnFn = () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
      child.kill = () => {};
      child.stdin = { write(line) {
        const [id, cmd] = line.trim().split('\t');
        if (cmd === 'quit' || id === 'quit') return;
        setImmediate(() => child.stdout.emit('data', cmd === 'crash' ? '' : `${id}\t${cmd === 'bad' ? 'err' : 'ok'}\t${Buffer.from(cmd === 'bad' ? 'Nein' : `echo ${cmd}`).toString('base64')}\n`));
        if (cmd === 'crash') setImmediate(() => child.emit('exit', 1));
      } };
      setImmediate(() => child.stdout.emit('data', '﻿ready\r\n'));
      return child;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ctl-'));
    const ctl = createControl({ scriptDir: dir, platform: 'win32', spawnFn });
    const [a, b] = await Promise.all([ctl.call('status'), ctl.call('windows')]);
    assert.strictEqual(a, 'echo status');
    assert.strictEqual(b, 'echo windows');
    await assert.rejects(ctl.call('bad'), /Nein/);
    assert.ok(fs.existsSync(path.join(dir, 'buddy-control.cs')));
    await assert.rejects(ctl.call('crash'), /beendet/);
    assert.strictEqual(ctl.running(), false);
    ctl.stop();
  });

  // ---------- Echter PowerShell-Helfer (falls pwsh da ist) ----------
  let pwsh = process.env.BUDDY_PWSH || '';
  if (!pwsh) { try { pwsh = execSync('command -v pwsh', { encoding: 'utf8' }).trim(); } catch { pwsh = ''; } }
  if (pwsh) {
    await test('pwsh: C# lädt (Add-Type), Protokoll läuft, Windows-Fehler kommen als Fehler zurück', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ctl-'));
      const spawnFn = (exe, args, opts) => spawn(pwsh, args.filter((x) => x !== '-ExecutionPolicy' && x !== 'Bypass'), opts);
      const ctl = createControl({ scriptDir: dir, platform: 'win32', spawnFn });
      await assert.rejects(ctl.call('gibtsnicht'), /Unbekannter Befehl/);
      await assert.rejects(ctl.call('windows'), (e) => e.message.length > 0);
      await assert.rejects(ctl.call('kill', '3'), /Ungültiger Prozess/);
      await assert.rejects(ctl.call('focus', 'abc'), /Ungültiges Fenster/);
      ctl.stop();
    });
  } else {
    console.log('– pwsh nicht gefunden: echter Helfer übersprungen');
  }

  console.log(`${n} Tests grün`);
})().catch((err) => { console.error(err); process.exit(1); });
