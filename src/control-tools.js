// Werkzeuge der KI für Ton und Apps (Windows). Jede Änderung erscheint als Aktion im Verlauf
// (Beschriftung aus dem Ergebnis, z. B. «Lautstärke Spotify: 60 → 30 %»).
// Freigaben: siehe src/permissions.js (close_app mit force/allow_unsaved = hohes Risiko).

const { spawn } = require('child_process');
const { t } = require('./i18n');
const P = require('./control-policy');

const INSTALLED_TTL = 10 * 60 * 1000;

const DEFINITIONS = [
  {
    name: 'audio_status',
    description:
      'Liest den Ton am PC: Gesamtlautstärke und Stumm, Mikrofon, Lautstärke pro App (nur Apps, die gerade Ton haben) und die Ausgabe- und Eingabegeräte. Nur lesen.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_volume',
    description:
      'Ändert die Lautstärke. Ohne app die Gesamtlautstärke, mit app nur die Lautstärke dieser App (z. B. «spotify», «chrome», «discord»; Namen aus audio_status). ' +
      'level = neuer Wert 0 bis 100, change = relativ (z. B. -10), mute = true/false. Bevorzuge das gegenüber media_control.',
    input_schema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Optional: Prozessname der App.' },
        level: { type: 'integer', description: 'Neue Lautstärke in Prozent (0 bis 100).' },
        change: { type: 'integer', description: 'Relative Änderung in Prozentpunkten (-100 bis 100).' },
        mute: { type: 'boolean', description: 'true = stumm, false = wieder hörbar.' },
      },
    },
  },
  {
    name: 'set_audio_device',
    description: 'Wechselt das Standard-Ausgabegerät (Lautsprecher, Kopfhörer, Bildschirm …). device = Name oder Teil davon aus audio_status.',
    input_schema: {
      type: 'object',
      properties: { device: { type: 'string', description: 'Name des Ausgabegeräts, z. B. «Kopfhörer».' } },
      required: ['device'],
    },
  },
  {
    name: 'set_microphone',
    description: 'Schaltet das Standard-Mikrofon stumm (mute: true) oder wieder an (mute: false).',
    input_schema: {
      type: 'object',
      properties: { mute: { type: 'boolean' } },
      required: ['mute'],
    },
  },
  {
    name: 'list_apps',
    description:
      'Listet Apps auf: kind «running» = offene Fenster (mit window_id, Prozess, Zustand, Titel), kind «installed» = installierte Apps aus dem Startmenü. ' +
      'query filtert nach Name.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['running', 'installed'] },
        query: { type: 'string', description: 'Optional: nur Apps, deren Name dies enthält.' },
      },
    },
  },
  {
    name: 'launch_app',
    description: 'Startet eine installierte App aus dem Startmenü nach Name (z. B. «Discord», «Word»). Für die festen Apps geht auch open_app.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name der App wie im Startmenü.' } },
      required: ['name'],
    },
  },
  {
    name: 'close_app',
    description:
      'Schliesst eine App sanft (wie ein Klick aufs X), damit sie selbst ans Speichern erinnern kann. app = Prozessname oder Teil des Fenstertitels, oder window_id aus list_apps. ' +
      'Meldet das Werkzeug ungespeicherte Änderungen, frag den Nutzer und ruf es erst nach seinem Ja mit allow_unsaved: true auf (Buddy zeigt dann eine Freigabe). ' +
      'force: true beendet die App hart (Daten können verloren gehen): nur wenn der Nutzer das ausdrücklich will und sanftes Schliessen nicht ging; Buddy fragt immer um Freigabe. ' +
      'Buddy selbst und Windows-Systemprozesse werden nie beendet.',
    input_schema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'string' },
        allow_unsaved: { type: 'boolean' },
        force: { type: 'boolean' },
      },
    },
  },
  {
    name: 'window_control',
    description:
      'Ordnet ein Fenster an: focus (in den Vordergrund), minimize, maximize, restore, left / right (Bildschirmhälfte), center, next_monitor (auf den nächsten Bildschirm), ' +
      'move (x, y, width, height in Prozent des Bildschirms). app = Prozessname oder Teil des Titels, oder window_id aus list_apps.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'left', 'right', 'center', 'next_monitor', 'move'] },
        app: { type: 'string' },
        window_id: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['action'],
    },
  },
];

const NAMES = new Set(DEFINITIONS.map((d) => d.name));

const cap = (s) => { const x = String(s || ''); return x.charAt(0).toUpperCase() + x.slice(1); };

// Beschriftung vor dem Ergebnis (Freigabe-Dialog, Fallback)
function describe(name, input = {}) {
  const app = cap(input.app || (input.window_id ? t('Fenster') : ''));
  switch (name) {
    case 'audio_status': return t('Ton angeschaut');
    case 'list_apps': return t('Apps angeschaut');
    case 'launch_app': return t('{app} geöffnet', { app: cap(input.name || 'App') });
    case 'set_audio_device': return t('Ausgabe: {device}', { device: String(input.device || '') });
    case 'set_microphone': return input.mute ? t('Mikrofon stumm') : t('Mikrofon an');
    case 'set_volume': {
      if (input.mute === true) return app ? t('{app} stumm', { app }) : t('Ton stumm');
      if (input.mute === false && input.level == null && input.change == null) return app ? t('{app} wieder hörbar', { app }) : t('Ton wieder an');
      const value = input.level != null ? `${input.level} %` : `${input.change > 0 ? '+' : ''}${input.change} %`;
      return app ? t('Lautstärke {app}: {value}', { app, value }) : t('Lautstärke: {value}', { value });
    }
    case 'close_app': return input.force ? t('{app} beendet', { app: app || 'App' }) : t('{app} geschlossen', { app: app || 'App' });
    case 'window_control': return windowLabel(input.action, app || t('Fenster'));
    default: return name;
  }
}

function windowLabel(action, app) {
  const key = {
    focus: '{app} im Vordergrund', minimize: '{app} minimiert', maximize: '{app} maximiert', restore: '{app} wiederhergestellt',
    left: '{app} links angeordnet', right: '{app} rechts angeordnet', center: '{app} zentriert', move: '{app} verschoben',
    next_monitor: '{app} auf anderen Bildschirm',
  }[action];
  return key ? t(key, { app }) : t('Fenster angeordnet');
}

const SHOW_CMD = { minimize: 6, maximize: 3, restore: 9 };

function createControlTools({ control, getOwn = () => ({ pids: [process.pid] }), launch = defaultLaunch, now = Date.now }) {
  let installed = null; // { at, list }

  async function windows() {
    return P.parseWindows(await control.call('windows'));
  }

  async function installedApps() {
    if (installed && now() - installed.at < INSTALLED_TTL) return installed.list;
    installed = { at: now(), list: P.parseInstalled(await control.call('installed')) };
    return installed.list;
  }

  function winLine(w) {
    return `${w.id} · ${w.process} · ${w.state}${w.front ? ' · vorne' : ''} · ${w.title}`;
  }

  function pick(list, input) {
    const found = P.findWindows(list, { app: input.app, windowId: input.window_id });
    if (!found.length) {
      return { error: `Kein offenes Fenster passt zu «${input.window_id || input.app || ''}». Offene Fenster:\n${list.slice(0, 25).map(winLine).join('\n') || '(keine)'}` };
    }
    return { found };
  }

  const blockedText = {
    self: 'Buddy schliesst sich nicht selbst. Der Nutzer kann Buddy über das Symbol im Infobereich beenden.',
    system: 'Das ist ein Teil von Windows. Buddy beendet Systemprozesse nie, auch nicht mit Freigabe.',
    many: 'Das passt auf mehr als 10 Fenster. Nenne die App genauer oder nimm eine window_id aus list_apps.',
    none: 'Kein passendes Fenster.',
  };

  async function run(name, input = {}) {
    switch (name) {
      case 'audio_status': {
        const [status, devices] = await Promise.all([control.call('status'), control.call('devices')]);
        const s = P.parseStatus(status);
        const d = P.parseDevices(devices);
        const lines = [];
        if (s.master) lines.push(`Gesamt: ${s.master.level} %${s.master.muted ? ' (stumm)' : ''} · Ausgabe: ${s.master.device}`);
        if (s.mic) lines.push(`Mikrofon: ${s.mic.muted ? 'stumm' : 'an'} (${s.mic.level} %) · ${s.mic.device}`);
        const apps = groupApps(s.apps);
        lines.push(apps.length ? `Apps mit Ton:\n${apps.map((a) => `- ${a.process}: ${a.level} %${a.muted ? ' (stumm)' : ''}`).join('\n')}` : 'Gerade hat keine App eine Ton-Sitzung.');
        const outs = d.filter((x) => x.flow === 'out');
        const ins = d.filter((x) => x.flow === 'in');
        if (outs.length) lines.push(`Ausgabegeräte:\n${outs.map((x) => `- ${x.name}${x.isDefault ? ' (aktiv)' : ''}`).join('\n')}`);
        if (ins.length) lines.push(`Mikrofone:\n${ins.map((x) => `- ${x.name}${x.isDefault ? ' (aktiv)' : ''}`).join('\n')}`);
        return { text: lines.join('\n') };
      }

      case 'set_volume': {
        const args = P.volumeArgs(input);
        if (args.error) return { error: true, text: args.error };
        const s = P.parseStatus(await control.call('status'));
        if (!input.app) {
          const base = s.master ? s.master.level : 50;
          const level = args.level >= 0 ? args.level : args.change ? clamp(base + args.change) : -1;
          const [, b, bm, a, am] = (await control.call('master', level, args.mute)).trim().split('\t');
          const label = volumeLabel(null, b, bm, a, am);
          return { text: `Gesamtlautstärke: vorher ${b} %${bm === '1' ? ' stumm' : ''}, jetzt ${a} %${am === '1' ? ' stumm' : ''}.`, label };
        }
        const sessions = P.findSessions(s.apps, input.app);
        if (!sessions.length) {
          const names = groupApps(s.apps).map((a) => a.process).join(', ') || 'keine';
          return { error: true, text: `«${input.app}» hat gerade keinen Ton. Apps mit Ton: ${names}. Startet die App gleich Ton, versuch es danach nochmals.` };
        }
        const base = sessions[0].level;
        const level = args.level >= 0 ? args.level : args.change ? clamp(base + args.change) : -1;
        const pids = [...new Set(sessions.map((x) => x.pid))].join(',');
        const res = String(await control.call('app', pids, level, args.mute)).split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
        if (!res.length) return { error: true, text: 'Die Ton-Sitzung der App ist inzwischen weg.' };
        const [, , proc, b, bm, a, am] = res[0];
        return {
          text: `${proc}: vorher ${b} %${bm === '1' ? ' stumm' : ''}, jetzt ${a} %${am === '1' ? ' stumm' : ''}.`,
          label: volumeLabel(cap(proc), b, bm, a, am),
        };
      }

      case 'set_audio_device': {
        const devices = P.parseDevices(await control.call('devices'));
        const dev = P.findDevice(devices, input.device, 'out');
        if (!dev) {
          return { error: true, text: `Kein Ausgabegerät passt zu «${input.device}». Vorhanden: ${devices.filter((d) => d.flow === 'out').map((d) => d.name).join(', ') || 'keine'}` };
        }
        if (dev.isDefault) return { text: `${dev.name} ist schon das Ausgabegerät.`, label: t('Ausgabe: {device}', { device: dev.name }) };
        try {
          await control.call('default', dev.id);
        } catch (err) {
          return { error: true, text: `Windows hat den Wechsel abgelehnt (${err.message}). Öffne mit open_settings «ton» die Ton-Einstellungen, dort kann der Nutzer das Gerät wählen.` };
        }
        const after = P.parseDevices(await control.call('devices')).find((d) => d.id === dev.id);
        if (!after?.isDefault) return { error: true, text: `Der Wechsel zu ${dev.name} hat nicht gegriffen. Öffne mit open_settings «ton» die Ton-Einstellungen.` };
        return { text: `Ausgabe jetzt: ${dev.name}.`, label: t('Ausgabe: {device}', { device: dev.name }) };
      }

      case 'set_microphone': {
        const mute = input.mute === true || input.mute === 'true';
        const [, , bm, , am] = (await control.call('mic', -1, mute ? 1 : 0)).trim().split('\t');
        const label = am === '1' ? t('Mikrofon stumm') : t('Mikrofon an');
        return { text: `Mikrofon: vorher ${bm === '1' ? 'stumm' : 'an'}, jetzt ${am === '1' ? 'stumm' : 'an'}.`, label };
      }

      case 'list_apps': {
        const q = P.norm(input.query);
        if (input.kind === 'installed') {
          const list = (await installedApps()).filter((a) => !q || P.norm(a.name).includes(q));
          if (!list.length) return { text: q ? `Keine installierte App passt zu «${input.query}».` : 'Keine Apps gefunden.' };
          return { text: `${list.length} Apps${list.length > 80 ? ' (die ersten 80)' : ''}:\n${list.slice(0, 80).map((a) => a.name).join('\n')}` };
        }
        const own = getOwn();
        const list = (await windows()).filter((w) => !P.isSelf(w, own)).filter((w) => !q || P.norm(w.title).includes(q) || P.norm(w.process).includes(q));
        if (!list.length) return { text: q ? `Kein offenes Fenster passt zu «${input.query}».` : 'Keine offenen Fenster.' };
        return { text: `Offene Fenster (window_id · Prozess · Zustand · Titel):\n${list.slice(0, 40).map(winLine).join('\n')}` };
      }

      case 'launch_app': {
        const matches = P.findInstalled(await installedApps(), input.name);
        if (!matches.length) return { error: true, text: `Keine installierte App heisst «${input.name}». Schau mit list_apps (installed) nach.` };
        if (matches.length > 1 && P.norm(matches[0].name) !== P.norm(input.name)) {
          return { error: true, text: `Mehrere Apps passen: ${matches.slice(0, 8).map((a) => a.name).join(', ')}. Welche?` };
        }
        const app = matches[0];
        if (!P.safeAppId(app.id)) return { error: true, text: 'Diese App kann Buddy nicht starten.' };
        await launch(app.id);
        return { text: `${app.name} wird gestartet.`, label: t('{app} geöffnet', { app: app.name }) };
      }

      case 'close_app': {
        const list = await windows();
        const picked = pick(list, input);
        if (picked.error) return { error: true, text: picked.error };
        const force = input.force === true;
        const check = P.closeCheck(picked.found, { force, allowUnsaved: input.allow_unsaved === true, own: getOwn() });
        if (check.blocked) return { error: true, text: blockedText[check.blocked] };
        if (check.unsaved) {
          return {
            error: true,
            text: `Nicht geschlossen: ${check.unsaved.map((w) => `«${w.title}»`).join(', ')} hat wohl ungespeicherte Änderungen. ` +
              'Frag den Nutzer, ob er zuerst speichern will. Nur wenn er trotzdem schliessen will: close_app mit allow_unsaved: true (Buddy fragt dann um Freigabe).',
          };
        }
        const name = appName(picked.found[0]);
        if (force) {
          const pids = [...new Set(picked.found.map((w) => w.pid))];
          const res = [];
          for (const pid of pids) res.push((await control.call('kill', pid)).trim());
          const ok = res.every((r) => r === 'killed');
          return ok
            ? { text: `${name} wurde hart beendet.`, label: t('{app} beendet', { app: name }) }
            : { error: true, text: `${name} läuft noch (vielleicht mit Administratorrechten). Buddy kann es nicht beenden.` };
        }
        const still = [];
        for (const w of picked.found) {
          if ((await control.call('close', w.id)).trim() !== 'closed') still.push(w);
        }
        if (still.length === picked.found.length) {
          return {
            error: true,
            text: `${name} ist noch offen. Wahrscheinlich fragt die App gerade, ob gespeichert werden soll, oder sie läuft mit Administratorrechten. ` +
              'Sag dem Nutzer, er soll im Fenster entscheiden. Beende sie nicht hart, ausser er will das ausdrücklich.',
          };
        }
        return {
          text: still.length ? `${name}: ${picked.found.length - still.length} Fenster geschlossen, ${still.length} noch offen (fragt vielleicht nach dem Speichern).` : `${name} wurde geschlossen.`,
          label: t('{app} geschlossen', { app: name }),
        };
      }

      case 'window_control': {
        const list = await windows();
        const picked = pick(list, input);
        if (picked.error) return { error: true, text: picked.error };
        const w = picked.found[0];
        if (P.windowCheck(w, getOwn())) return { error: true, text: 'Buddys eigenes Fenster ordnet Buddy nicht an.' };
        const name = appName(w);
        const label = windowLabel(input.action, name);
        let out;
        if (input.action === 'focus') out = (await control.call('focus', w.id)).trim();
        else if (SHOW_CMD[input.action]) out = (await control.call('show', w.id, SHOW_CMD[input.action])).trim();
        else if (input.action === 'next_monitor') out = (await control.call('move', w.id, 'next', 0, 0, 0, 0)).trim();
        else if (input.action === 'move') {
          const pct = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : d);
          out = (await control.call('move', w.id, 'move', pct(input.x, 10), pct(input.y, 10), pct(input.width, 60), pct(input.height, 70))).trim();
        } else if (['left', 'right', 'center'].includes(input.action)) out = (await control.call('move', w.id, input.action, 0, 0, 0, 0)).trim();
        else return { error: true, text: 'Unbekannte Aktion.' };
        if (out === 'single') return { error: true, text: 'Es ist nur ein Bildschirm angeschlossen.' };
        if (input.action === 'focus' && out !== 'front') return { error: true, text: `Windows hat ${name} nicht nach vorne gelassen. In der Taskleiste blinkt es jetzt wohl.` };
        return { text: `${label}${picked.found.length > 1 ? ` (oberstes von ${picked.found.length} Fenstern: «${w.title}»)` : ''}.`, label };
      }

      default:
        return { error: true, text: `Unbekanntes Werkzeug: ${name}` };
    }
  }

  return { definitions: DEFINITIONS, names: NAMES, run, describe };
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Mehrere Sitzungen derselben App zusammenfassen (Chrome hat oft mehrere)
function groupApps(apps) {
  const map = new Map();
  for (const a of apps) {
    const key = P.procName(a.process);
    if (!map.has(key)) map.set(key, { process: a.process, level: a.level, muted: a.muted });
  }
  return [...map.values()];
}

// who = null: Gesamtlautstärke
function volumeLabel(who, b, bm, a, am) {
  if (bm !== am) {
    if (!who) return am === '1' ? t('Ton stumm') : t('Ton wieder an');
    return am === '1' ? t('{app} stumm', { app: who }) : t('{app} wieder hörbar', { app: who });
  }
  return who ? t('Lautstärke {app}: {before} → {after} %', { app: who, before: b, after: a }) : t('Lautstärke: {before} → {after} %', { before: b, after: a });
}

// Name für Verlauf und Antworten: bei Wirt-Prozessen (Store-Apps, Explorer-Ordner) der Fenstertitel
function appName(w) {
  return P.isSystem(w) && w.title ? w.title.slice(0, 60) : cap(w.process);
}

function defaultLaunch(id) {
  return new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [`shell:AppsFolder\\${id}`], { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

module.exports = { createControlTools, DEFINITIONS, NAMES, describe, groupApps };
