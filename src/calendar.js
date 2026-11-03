// Kalender über einen privaten iCal-Link (Google, Outlook, iCloud).
// Kein Login nötig: Buddy lädt den Link alle 15 Minuten, rechnet
// Wiederholungen aus und erinnert kurz vor Terminen im Island.

const { t } = require('./i18n');

const REFRESH_MS = 15 * 60 * 1000;
const WINDOW_DAYS = 31;
const MAX_ITER = 5000;

// Häufige Windows-Zeitzonennamen (Outlook) -> IANA
const WINDOWS_TZ = {
  'W. Europe Standard Time': 'Europe/Zurich',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

const DAY = 24 * 3600 * 1000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ---------- Zeitzonen ----------

const fmtCache = new Map();
function zoneFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

function validZone(tz) {
  if (!tz) return null;
  const clean = String(tz).replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, '');
  const mapped = WINDOWS_TZ[clean] || clean;
  try {
    zoneFormatter(mapped).format(0);
    return mapped;
  } catch {
    return null;
  }
}

function zoneOffset(ms, tz) {
  const parts = {};
  for (const p of zoneFormatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wanduhrzeit (y, m, d, h, mi, s) in einer Zeitzone -> Zeitpunkt in ms
function wallToMs(f, tz) {
  if (!tz) return new Date(f.y, f.m, f.d, f.h, f.mi, f.s).getTime(); // lokale Zeit
  const guess = Date.UTC(f.y, f.m, f.d, f.h, f.mi, f.s);
  let ms = guess - zoneOffset(guess, tz);
  ms = guess - zoneOffset(ms, tz);
  return ms;
}

// ---------- ICS lesen ----------

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescapeText(v) {
  return String(v || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

function parseProp(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

// Liefert { f: Wanduhr-Felder, tz, allDay, utc }
function parseDate(value, params = {}) {
  const v = String(value).trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === 'DATE') {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { f: { y: +m[1], m: +m[2] - 1, d: +m[3], h: 0, mi: 0, s: 0 }, tz: null, allDay: true };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const f = { y: +m[1], m: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  if (m[7]) return { f, tz: 'UTC', allDay: false };
  return { f, tz: validZone(params.TZID), allDay: false };
}

function toMs(date) {
  return wallToMs(date.f, date.tz);
}

function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+m[2] || 0) * 7 * DAY + (+m[3] || 0) * DAY + (+m[4] || 0) * 3600e3 + (+m[5] || 0) * 60e3 + (+m[6] || 0) * 1e3);
}

function parseICS(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseProp(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      case 'DTSTART': cur.start = parseDate(p.value, p.params); break;
      case 'DTEND': cur.end = parseDate(p.value, p.params); break;
      case 'DURATION': cur.duration = parseDuration(p.value); break;
      case 'RRULE': cur.rrule = parseRule(p.value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(p.value, p.params); break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const d = parseDate(v, p.params);
          if (d) cur.exdates.push(d);
        }
        break;
      default:
    }
  }
  return events;
}

function parseRule(value) {
  const rule = {};
  for (const part of String(value).split(';')) {
    const [k, v] = part.split('=');
    if (k && v) rule[k.toUpperCase()] = v;
  }
  return {
    freq: rule.FREQ,
    interval: Math.max(1, +rule.INTERVAL || 1),
    count: rule.COUNT ? +rule.COUNT : null,
    until: rule.UNTIL ? parseDate(rule.UNTIL, {}) : null,
    byday: rule.BYDAY ? rule.BYDAY.split(',').map((d) => {
      const m = d.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/);
      return m ? { n: m[1] ? +m[1] : null, wd: WEEKDAYS.indexOf(m[2]) } : null;
    }).filter(Boolean) : null,
    bymonthday: rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : null,
  };
}

// ---------- Wiederholungen ----------

// Rechnen mit Wanduhr-Daten über UTC-Hilfsdaten (ohne Sommerzeit-Probleme)
const asDate = (f) => new Date(Date.UTC(f.y, f.m, f.d));
const fromDate = (dt, f) => ({ y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), h: f.h, mi: f.mi, s: f.s });
const addDays = (f, n) => { const dt = asDate(f); dt.setUTCDate(dt.getUTCDate() + n); return fromDate(dt, f); };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function nthWeekday(y, m, wd, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return d <= daysInMonth(y, m) ? d : null;
  }
  const lastDay = daysInMonth(y, m);
  const last = new Date(Date.UTC(y, m, lastDay)).getUTCDay();
  const d = lastDay - ((last - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : null;
}

// Erzeugt Wanduhr-Starts eines Termins (sortiert), bis max. `limitMs`
function* occurrences(ev, limitMs) {
  const base = ev.start.f;
  const tz = ev.start.tz;
  const rule = ev.rrule;
  if (!rule || !rule.freq) { yield base; return; }
  const untilMs = rule.until ? toMs(rule.until) + (rule.until.allDay ? DAY - 1 : 0) : Infinity;
  const startMs = wallToMs(base, tz);
  let produced = 0;
  let iter = 0;

  const emit = function* (f) {
    const ms = wallToMs(f, tz);
    if (ms < startMs) return false;
    if (ms > untilMs || ms > limitMs) return 'stop';
    produced += 1;
    yield f;
    if (rule.count && produced >= rule.count) return 'stop';
    return true;
  };

  if (rule.freq === 'DAILY') {
    let f = base;
    // ohne COUNT direkt nahe an heute springen
    if (!rule.count) {
      const skip = Math.floor((Date.now() - 2 * DAY - startMs) / (rule.interval * DAY));
      if (skip > 0) f = addDays(base, skip * rule.interval);
    }
    while (iter++ < MAX_ITER) {
      const r = yield* emit(f);
      if (r === 'stop') return;
      f = addDays(f, rule.interval);
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byday && rule.byday.length ? rule.byday.map((b) => b.wd).sort((a, b) => a - b) : [asDate(base).getUTCDay()];
    // Wochenbeginn (Montag) der ersten Woche
    const baseWd = asDate(base).getUTCDay();
    let weekStart = addDays(base, -((baseWd + 6) % 7));
    if (!rule.count) {
      const skip = Math.floor((Date.now() - 8 * DAY - startMs) / (rule.interval * 7 * DAY));
      if (skip > 0) weekStart = addDays(weekStart, skip * rule.interval * 7);
    }
    while (iter++ < MAX_ITER) {
      for (const wd of days.map((d) => (d + 6) % 7).sort((a, b) => a - b)) {
        const r = yield* emit(addDays(weekStart, wd));
        if (r === 'stop') return;
      }
      weekStart = addDays(weekStart, 7 * rule.interval);
    }
  } else if (rule.freq === 'MONTHLY') {
    let y = base.y;
    let m = base.m;
    while (iter++ < MAX_ITER) {
      let daysList = [];
      if (rule.bymonthday) daysList = rule.bymonthday.map((d) => (d < 0 ? daysInMonth(y, m) + d + 1 : d));
      else if (rule.byday) daysList = rule.byday.map((b) => (b.n ? nthWeekday(y, m, b.wd, b.n) : null));
      else daysList = [base.d];
      for (const d of daysList.filter((x) => x && x <= daysInMonth(y, m)).sort((a, b) => a - b)) {
        const r = yield* emit({ ...base, y, m, d });
        if (r === 'stop') return;
      }
      m += rule.interval;
      y += Math.floor(m / 12);
      m %= 12;
    }
  } else if (rule.freq === 'YEARLY') {
    let y = base.y;
    while (iter++ < MAX_ITER) {
      if (base.d <= daysInMonth(y, base.m)) {
        const r = yield* emit({ ...base, y });
        if (r === 'stop') return;
      }
      y += rule.interval;
    }
  } else {
    yield base;
  }
}

// Alle Termine im Zeitfenster [fromMs, toMs]
function expand(events, fromT, toT) {
  const overrides = new Map(); // uid -> Set(Start ms)
  for (const ev of events) {
    if (ev.recurrenceId && ev.uid) {
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Set());
      overrides.get(ev.uid).add(toMs(ev.recurrenceId));
    }
  }
  const out = [];
  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue;
    const length = ev.end ? toMs(ev.end) - toMs(ev.start) : ev.duration ?? (ev.start.allDay ? DAY : 0);
    const ex = new Set(ev.exdates.map(toMs));
    const replaced = !ev.recurrenceId && ev.uid ? overrides.get(ev.uid) : null;
    for (const f of occurrences(ev, toT)) {
      const start = wallToMs(f, ev.start.tz);
      if (ex.has(start) || replaced?.has(start)) continue;
      const end = start + Math.max(0, length);
      if (end < fromT || start > toT) continue;
      out.push({ title: ev.title || '(Ohne Titel)', location: ev.location || '', start, end, allDay: ev.start.allDay });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------- Kalender-Dienst ----------

function createCalendar({ fetchText, getUrl, onReminder, onUpdate, log }) {
  let events = [];
  let upcoming = [];
  let lastSync = 0;
  let lastError = null;
  let refreshTimer = null;
  const reminded = new Set();
  const reminderTimers = [];
  let leadMinutes = 10;

  async function refresh() {
    clearTimeout(refreshTimer);
    const url = getUrl();
    if (!url) {
      events = [];
      upcoming = [];
      scheduleReminders();
      onUpdate?.(status());
      return status();
    }
    try {
      const text = await fetchText(url);
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error(t('Das ist kein Kalender-Link (iCal/ICS).'));
      events = parseICS(text);
      lastSync = Date.now();
      lastError = null;
      recompute();
    } catch (err) {
      lastError = err.message || String(err);
      log?.(`Kalender: ${lastError}`);
    }
    refreshTimer = setTimeout(refresh, REFRESH_MS);
    onUpdate?.(status());
    return status();
  }

  function recompute() {
    const now = Date.now();
    upcoming = expand(events, now - DAY, now + WINDOW_DAYS * DAY);
    scheduleReminders();
  }

  function scheduleReminders() {
    reminderTimers.splice(0).forEach(clearTimeout);
    const now = Date.now();
    for (const ev of upcoming) {
      if (ev.allDay) continue;
      const at = ev.start - leadMinutes * 60e3;
      const key = `${ev.title}|${ev.start}`;
      if (reminded.has(key) || ev.start < now || at - now > DAY) continue;
      reminderTimers.push(setTimeout(() => {
        reminded.add(key);
        onReminder?.(ev, Math.max(0, Math.round((ev.start - Date.now()) / 60e3)));
      }, Math.max(0, at - now)));
    }
    // einmal pro Stunde neu planen (für Termine, die später in das 24-h-Fenster rutschen)
    reminderTimers.push(setTimeout(recompute, 3600e3));
  }

  function setLead(minutes) {
    leadMinutes = Math.max(0, Math.min(120, Number(minutes) || 10));
    scheduleReminders();
  }

  function list(fromMs, toMs) {
    return upcoming.filter((e) => e.end >= fromMs && e.start <= toMs);
  }

  function status() {
    return { configured: Boolean(getUrl()), events: upcoming.length, lastSync, error: lastError };
  }

  function stop() {
    clearTimeout(refreshTimer);
    reminderTimers.splice(0).forEach(clearTimeout);
  }

  return { refresh, list, status, setLead, stop };
}

module.exports = { createCalendar, parseICS, expand, wallToMs };
