// Werkzeuge, die Buddy auf dem PC benutzen darf.
// Bewusst nur harmlose Aktionen: Timer, Apps/Websites öffnen, Medien & Lautstärke.
// Volle Maus-/Tastatursteuerung kommt später mit Freigabe vor jeder Aktion.

const { shell } = require('electron');
const { spawn } = require('child_process');
const os = require('os');

// App-Name -> wie sie unter Windows geöffnet wird
const APPS = {
  rechner: { uri: 'calculator:' },
  editor: { exe: 'notepad.exe' },
  paint: { exe: 'mspaint.exe' },
  explorer: { path: os.homedir() },
  einstellungen: { uri: 'ms-settings:' },
  uhr: { uri: 'ms-clock:' },
  kamera: { uri: 'microsoft.windows.camera:' },
  store: { uri: 'ms-windows-store:' },
  taskmanager: { exe: 'taskmgr.exe' },
  spotify: { uri: 'spotify:' },
  whatsapp: { uri: 'whatsapp:' },
  edge: { uri: 'microsoft-edge:' },
};

// Windows-Einstellungsseiten, die Buddy öffnen darf (nur öffnen, nicht ändern)
const SETTINGS_PAGES = {
  start: 'ms-settings:',
  anzeige: 'ms-settings:display',
  ton: 'ms-settings:sound',
  bluetooth: 'ms-settings:bluetooth',
  wlan: 'ms-settings:network-wifi',
  netzwerk: 'ms-settings:network',
  mitteilungen: 'ms-settings:notifications',
  nicht_stoeren: 'ms-settings:quiethours',
  apps: 'ms-settings:appsfeatures',
  standard_apps: 'ms-settings:defaultapps',
  autostart: 'ms-settings:startupapps',
  speicher: 'ms-settings:storagesense',
  energie: 'ms-settings:powersleep',
  akku: 'ms-settings:batterysaver',
  maus: 'ms-settings:mousetouchpad',
  tastatur: 'ms-settings:typing',
  hintergrund: 'ms-settings:personalization-background',
  farben: 'ms-settings:colors',
  taskleiste: 'ms-settings:taskbar',
  datum_uhrzeit: 'ms-settings:dateandtime',
  sprache: 'ms-settings:regionlanguage',
  konten: 'ms-settings:yourinfo',
  datenschutz: 'ms-settings:privacy',
  windows_update: 'ms-settings:windowsupdate',
};

// Virtuelle Tastencodes für Medientasten (über WScript.Shell SendKeys)
const MEDIA_KEYS = {
  play_pause: 179,
  next: 176,
  previous: 177,
  volume_up: 175,
  volume_down: 174,
  mute: 173,
};

const TOOL_DEFINITIONS = [
  {
    name: 'set_timer',
    description:
      'Stellt einen Timer auf dem PC. Der Countdown erscheint im Island, am Ende gibt es einen Ton und eine Windows-Benachrichtigung. ' +
      'Nutze das, wenn der Nutzer einen Timer, Wecker in X Minuten oder eine Erinnerung in kurzer Zeit will.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Dauer in Minuten (kann mit seconds kombiniert werden).' },
        seconds: { type: 'number', description: 'Zusätzliche Sekunden.' },
        label: { type: 'string', description: 'Kurzer Name, z. B. «Pizza» oder «Pause».' },
      },
    },
  },
  {
    name: 'list_timers',
    description: 'Zeigt alle laufenden Timer mit Restzeit.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_timer',
    description: 'Stoppt einen laufenden Timer anhand seines Namens oder seiner ID. Ohne Angabe werden alle Timer gestoppt.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
      },
    },
  },
  {
    name: 'open_website',
    description: 'Öffnet eine Website im Standardbrowser des Nutzers. Nur http(s)-Adressen.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Vollständige Adresse mit https://' } },
      required: ['url'],
    },
  },
  {
    name: 'open_app',
    description: 'Öffnet ein Programm auf dem Windows-PC.',
    input_schema: {
      type: 'object',
      properties: { app: { type: 'string', enum: Object.keys(APPS) } },
      required: ['app'],
    },
  },
  {
    name: 'now_playing',
    description: 'Zeigt, welcher Song oder welches Video gerade auf dem PC läuft (Spotify, YouTube im Browser usw.).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'calendar_events',
    description:
      'Liest Termine aus dem Kalender des Nutzers (falls in Buddy verbunden). ' +
      'Nutze das bei Fragen wie «Was steht heute an?» oder «Wann ist mein nächster Termin?».',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Wie viele Tage ab heute (1 bis 31, Standard 1 = heute).' },
        query: { type: 'string', description: 'Optional nur Termine, deren Titel diesen Text enthält.' },
      },
    },
  },
  {
    name: 'recent_notifications',
    description:
      'Liest die letzten Windows-Mitteilungen (z. B. WhatsApp, Mail, Discord), die Buddy seit dem Start gesehen hat. ' +
      'Nur benutzen, wenn der Nutzer fragt, was er verpasst hat oder was in einer Mitteilung stand.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Wie viele (1 bis 30, Standard 10).' },
        app: { type: 'string', description: 'Optional nur Mitteilungen dieser App, z. B. «WhatsApp».' },
      },
    },
  },
  {
    name: 'system_info',
    description: 'Zeigt Infos zum PC: Windows-Version, Prozessor, Arbeitsspeicher, freier Speicherplatz, Laufzeit seit dem Start. Nur lesen.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_settings',
    description:
      'Öffnet eine Seite der Windows-Einstellungen, damit der Nutzer (oder du per Bildschirmsteuerung) dort etwas nachsehen kann. Öffnen ändert nichts. ' +
      'Etwas in den Einstellungen zu ändern ist mittleres oder hohes Risiko und braucht vorher request_permission. ' +
      'Will der Nutzer die Windows-Banner unten rechts loswerden, öffne «mitteilungen» und erkläre: «Nicht stören» einschalten oder bei einzelnen Apps «Benachrichtigungsbanner anzeigen» ausschalten.',
    input_schema: {
      type: 'object',
      properties: { page: { type: 'string', enum: Object.keys(SETTINGS_PAGES) } },
      required: ['page'],
    },
  },
  {
    name: 'media_control',
    description:
      'Steuert Musik und Lautstärke wie die Medientasten der Tastatur: abspielen/pausieren, nächster/vorheriger Titel, lauter, leiser, stumm. ' +
      'Ein Lautstärke-Schritt entspricht etwa 2 Prozent.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: Object.keys(MEDIA_KEYS) },
        steps: { type: 'integer', description: 'Wie oft die Taste gedrückt wird (nur für lauter/leiser, 1 bis 50).' },
      },
      required: ['action'],
    },
  },
];

// Kurze, deutsche Beschriftung für die Anzeige im Island
function describe(name, input = {}) {
  switch (name) {
    case 'set_timer': return `Timer ${formatDuration(durationMs(input))}${input.label ? ` · ${input.label}` : ''}`;
    case 'list_timers': return 'Timer angeschaut';
    case 'recent_notifications': return 'Mitteilungen gelesen';
    case 'now_playing': return 'Musik angeschaut';
    case 'calendar_events': return 'Kalender angeschaut';
    case 'cancel_timer': return 'Timer gestoppt';
    case 'open_website': return `Website geöffnet`;
    case 'open_app': return `${capitalize(input.app || 'App')} geöffnet`;
    case 'system_info': return 'Systeminfos gelesen';
    case 'open_settings': return `Einstellungen: ${capitalize(String(input.page || '').replace(/_/g, ' '))}`;
    case 'media_control': return {
      play_pause: 'Wiedergabe umgeschaltet', next: 'Nächster Titel', previous: 'Vorheriger Titel',
      volume_up: 'Lauter', volume_down: 'Leiser', mute: 'Stumm umgeschaltet',
    }[input.action] || 'Medien gesteuert';
    default: return name;
  }
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function durationMs({ minutes = 0, seconds = 0 } = {}) {
  return Math.round((Number(minutes) || 0) * 60000 + (Number(seconds) || 0) * 1000);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} Std. ${m} Min.`;
  if (m && s) return `${m} Min. ${s} Sek.`;
  if (m) return `${m} Min.`;
  return `${s} Sek.`;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
}

function pressMediaKey(code, times) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Medientasten gehen nur unter Windows.'));
      return;
    }
    const script = `$s = New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $s.SendKeys([char]${code}) }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('PowerShell-Fehler'))));
  });
}

function openApp(name) {
  const entry = APPS[name];
  if (!entry) throw new Error(`Unbekannte App: ${name}`);
  if (entry.uri) return shell.openExternal(entry.uri);
  if (entry.path) return shell.openPath(entry.path);
  return new Promise((resolve, reject) => {
    const child = spawn(entry.exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

function createTools({
  onTimersChanged, onTimerDone, getNotifications = () => [], getNowPlaying = () => null,
  mediaCommand = () => false, getCalendar = null,
}) {
  const timers = new Map(); // id -> { id, label, endsAt, durationMs, handle }
  let counter = 0;

  function snapshot() {
    return [...timers.values()]
      .map(({ id, label, endsAt, durationMs: total }) => ({ id, label, endsAt, durationMs: total }))
      .sort((a, b) => a.endsAt - b.endsAt);
  }

  function changed() {
    onTimersChanged(snapshot());
  }

  function addTimer(ms, label) {
    const id = `t${++counter}`;
    const endsAt = Date.now() + ms;
    const handle = setTimeout(() => {
      const timer = timers.get(id);
      timers.delete(id);
      changed();
      if (timer) onTimerDone({ id, label: timer.label, durationMs: timer.durationMs });
    }, ms);
    timers.set(id, { id, label, endsAt, durationMs: ms, handle });
    changed();
    return { id, endsAt };
  }

  function cancel({ id, label } = {}) {
    let removed = [];
    for (const timer of timers.values()) {
      const match = id ? timer.id === id : label ? timer.label.toLowerCase() === String(label).toLowerCase() : true;
      if (match) {
        clearTimeout(timer.handle);
        removed.push(timer);
      }
    }
    removed.forEach((t) => timers.delete(t.id));
    if (removed.length) changed();
    return removed;
  }

  async function run(name, input = {}) {
    switch (name) {
      case 'set_timer': {
        const ms = durationMs(input);
        if (ms < 1000) return { error: true, text: 'Die Dauer muss mindestens 1 Sekunde sein.' };
        if (ms > 24 * 3600 * 1000) return { error: true, text: 'Timer können höchstens 24 Stunden dauern.' };
        const label = String(input.label || 'Timer').slice(0, 40);
        const { id, endsAt } = addTimer(ms, label);
        return { text: `Timer «${label}» (ID ${id}) gestellt auf ${formatDuration(ms)}, klingelt um ${clock(endsAt)} Uhr.` };
      }
      case 'list_timers': {
        const list = snapshot();
        if (!list.length) return { text: 'Es läuft kein Timer.' };
        return {
          text: list.map((t) => `${t.id}: «${t.label}», noch ${formatDuration(t.endsAt - Date.now())} (bis ${clock(t.endsAt)} Uhr)`).join('\n'),
        };
      }
      case 'cancel_timer': {
        const removed = cancel(input);
        if (!removed.length) return { error: true, text: 'Kein passender Timer gefunden.' };
        return { text: `Gestoppt: ${removed.map((t) => `«${t.label}»`).join(', ')}` };
      }
      case 'now_playing': {
        const np = getNowPlaying();
        if (!np) return { text: 'Gerade läuft nichts (oder Windows meldet keine Wiedergabe).' };
        return { text: `${np.playing ? 'Läuft' : 'Pausiert'} in ${np.app}: «${np.title}»${np.artist ? ` von ${np.artist}` : ''}${np.album ? ` (Album: ${np.album})` : ''}` };
      }
      case 'calendar_events': {
        if (!getCalendar) return { error: true, text: 'Es ist kein Kalender verbunden. Der Nutzer kann in Buddys Einstellungen unter «Kalender» einen iCal-Link einfügen.' };
        const days = Math.min(31, Math.max(1, Math.round(Number(input.days) || 1)));
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = start.getTime() + days * 864e5 - 1;
        const q = String(input.query || '').toLowerCase();
        const list = getCalendar(Math.max(Date.now() - 3600e3, start.getTime()), end).filter((e) => !q || e.title.toLowerCase().includes(q));
        if (!list.length) return { text: `Keine Termine in den nächsten ${days === 1 ? 'Stunden (heute)' : `${days} Tagen`}.` };
        const day = (ts) => new Date(ts).toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' });
        return {
          text: list.slice(0, 40).map((e) => `${day(e.start)} ${e.allDay ? 'ganztägig' : `${clock(e.start)}–${clock(e.end)}`} · ${e.title}${e.location ? ` (${e.location})` : ''}`).join('\n'),
        };
      }
      case 'recent_notifications': {
        const limit = Math.min(30, Math.max(1, Math.round(Number(input.limit) || 10)));
        const app = String(input.app || '').toLowerCase();
        const list = getNotifications().filter((n) => !app || n.app.toLowerCase().includes(app)).slice(0, limit);
        if (!list.length) return { text: 'Keine Mitteilungen gefunden (Buddy sieht nur Mitteilungen seit seinem Start).' };
        return {
          text: list.map((n) => `${clock(n.time)} · ${n.app}: ${[n.title, n.body].filter(Boolean).join(' – ')}`).join('\n'),
        };
      }
      case 'open_website': {
        const url = String(input.url || '').trim();
        if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: true, text: 'Nur http(s)-Adressen sind erlaubt.' };
        await shell.openExternal(url);
        return { text: `Geöffnet: ${url}` };
      }
      case 'open_app': {
        await openApp(input.app);
        return { text: `${capitalize(input.app)} wurde geöffnet.` };
      }
      case 'system_info': {
        const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
        const cpus = os.cpus();
        const up = os.uptime();
        const lines = [
          `System: ${os.type()} ${os.release()} (${os.arch()})`,
          `Prozessor: ${cpus[0]?.model?.trim() || 'unbekannt'} (${cpus.length} Threads)`,
          `Arbeitsspeicher: ${gb(os.totalmem() - os.freemem())} von ${gb(os.totalmem())} belegt`,
          `Läuft seit: ${Math.floor(up / 86400)} T ${Math.floor((up % 86400) / 3600)} h ${Math.floor((up % 3600) / 60)} min`,
        ];
        try {
          const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/';
          const fsStat = require('fs').statfsSync(root);
          lines.push(`Speicherplatz ${root}: ${gb(fsStat.bavail * fsStat.bsize)} frei von ${gb(fsStat.blocks * fsStat.bsize)}`);
        } catch {
          /* nicht verfügbar */
        }
        return { text: lines.join('\n') };
      }
      case 'open_settings': {
        const uri = SETTINGS_PAGES[input.page];
        if (!uri) return { error: true, text: `Unbekannte Seite. Möglich: ${Object.keys(SETTINGS_PAGES).join(', ')}` };
        if (process.platform !== 'win32') return { error: true, text: 'Windows-Einstellungen gibt es nur unter Windows.' };
        await shell.openExternal(uri);
        return { text: `Einstellungen geöffnet: ${input.page}` };
      }
      case 'media_control': {
        const code = MEDIA_KEYS[input.action];
        if (!code) return { error: true, text: 'Unbekannte Aktion.' };
        // Wiedergabe lieber direkt über die Windows-Mediensitzung steuern
        const session = { play_pause: 'playpause', next: 'next', previous: 'previous' }[input.action];
        if (session && mediaCommand(session)) return { text: `Erledigt (${input.action}).` };
        const isVolume = input.action === 'volume_up' || input.action === 'volume_down';
        const steps = isVolume ? Math.min(50, Math.max(1, Math.round(Number(input.steps) || 5))) : 1;
        await pressMediaKey(code, steps);
        return { text: `Erledigt (${input.action}${isVolume ? `, ${steps} Schritte` : ''}).` };
      }
      default:
        return { error: true, text: `Unbekanntes Werkzeug: ${name}` };
    }
  }

  return { definitions: TOOL_DEFINITIONS, run, cancel, snapshot, describe };
}

module.exports = { createTools, formatDuration, describe, TOOL_DEFINITIONS };
