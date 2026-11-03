// KI-Nutzung auf einen Blick: Buddy selbst, Claude API (Organisation), Claude Code,
// Codex, ChatGPT, Grok und laufende KI-Programme. Jeder Anbieter ist ein eigenes
// Modul mit collect(); neue Anbieter kommen einfach in PROVIDERS dazu.
//
// Grundsätze: nur offizielle APIs oder lokale Dateien der Programme selbst, keine
// erfundenen Werte. Was es nicht gibt, steht als «nicht verfügbar» da. Gemessenes
// (kind: 'measured') und Geschätztes (kind: 'estimate') bleiben getrennt.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const models = require('./models');

const DAY = 864e5;
const LOOKBACK_DAYS = 7;
const ACTIVE_MS = 3 * 60 * 1000; // Datei so frisch = Sitzung läuft wohl gerade
const CACHE_MS = 45 * 1000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const short = (text, n = 80) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
const baseName = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).pop() || '';
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---------- Hilfen zum Lesen von JSONL-Dateien ----------

async function eachLine(file, onLine) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line.length > 5 * 1024 * 1024) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      onLine(obj);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function recentFiles(dir, { since, ext = '.jsonl', depth = 2 }) {
  const out = [];
  async function walk(d, level) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (level < depth) await walk(full, level + 1); continue; }
      if (!e.isFile() || !e.name.endsWith(ext)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (st && st.mtimeMs >= since && st.size <= MAX_FILE_BYTES) out.push({ file: full, mtime: st.mtimeMs, size: st.size });
    }
  }
  await walk(dir, 0);
  return out;
}

// Ergebnisse pro Datei merken, solange sie sich nicht ändert
function fileCache() {
  const map = new Map();
  return async (entry, parse) => {
    const hit = map.get(entry.file);
    if (hit && hit.mtime === entry.mtime && hit.size === entry.size) return hit.value;
    const value = await parse(entry.file);
    map.set(entry.file, { mtime: entry.mtime, size: entry.size, value });
    return value;
  };
}

// ---------- Claude Code (lokale Protokolle) ----------

function isRealPrompt(text) {
  const t = String(text || '').trim();
  return t && !t.startsWith('<') && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted') && !t.startsWith('This session is being continued');
}

async function parseClaudeCodeFile(file) {
  const s = { id: path.basename(file, '.jsonl'), cwd: '', title: '', start: 0, end: 0, tools: {}, errors: 0, messages: new Map(), byDay: {} };
  await eachLine(file, (o) => {
    const t = Date.parse(o.timestamp || '') || 0;
    if (t) { s.start = s.start ? Math.min(s.start, t) : t; s.end = Math.max(s.end, t); }
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    if (o.type === 'summary' && o.summary && !s.summary) s.summary = short(o.summary, 90);
    const msg = o.message;
    if (!msg) return;
    if (o.type === 'user' && !o.isSidechain) {
      if (typeof msg.content === 'string') {
        if (!s.title && isRealPrompt(msg.content)) s.title = short(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'tool_result' && b.is_error) s.errors += 1;
          if (b.type === 'text' && !s.title && isRealPrompt(b.text)) s.title = short(b.text);
        }
      }
    }
    if (o.type === 'assistant' && msg.usage) {
      // Beim Streamen steht dieselbe Nachricht mehrmals im Protokoll: nur einmal zählen
      const key = msg.id || o.requestId || o.uuid;
      // Claude Code schreibt eine Antwort oft auf mehrere Zeilen (ein Block pro Zeile): nach Aufruf-ID zusammenführen
      const prev = s.messages.get(key);
      const tools = { ...(prev?.tools || {}) };
      for (const b of Array.isArray(msg.content) ? msg.content : []) if (b.type === 'tool_use' && b.name) tools[b.id || `${b.name}:${Object.keys(tools).length}`] = b.name;
      s.messages.set(key, { model: msg.model, usage: msg.usage, day: startOfDay(t || s.end), tools });
    }
  });
  for (const m of s.messages.values()) for (const name of Object.values(m.tools)) s.tools[name] = (s.tools[name] || 0) + 1;
  // Tokens und geschätzte Kosten pro Tag
  for (const m of s.messages.values()) {
    const d = s.byDay[m.day] || (s.byDay[m.day] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {} });
    d.input += num(m.usage.input_tokens);
    d.output += num(m.usage.output_tokens);
    d.cacheRead += num(m.usage.cache_read_input_tokens);
    d.cacheWrite += num(m.usage.cache_creation_input_tokens);
    if (m.model && !/synthetic/i.test(m.model)) {
      d.cost += models.costOf(m.model, m.usage);
      d.models[m.model] = (d.models[m.model] || 0) + 1;
    }
  }
  s.requests = s.messages.size;
  delete s.messages;
  return s;
}

function claudeCodeProvider({ home, env, cached, now }) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return {
    id: 'claude_code',
    name: 'Claude Code',
    async collect() {
      const dir = path.join(base, 'projects');
      if (!fs.existsSync(dir)) {
        return { status: 'empty', note: 'Keine Claude-Code-Protokolle auf diesem PC gefunden (Ordner .claude\\projects fehlt). Läuft Claude Code in WSL, liegen sie dort und sind für Buddy nicht erreichbar.' };
      }
      const t = now();
      const files = await recentFiles(dir, { since: t - LOOKBACK_DAYS * DAY, depth: 1 });
      const sessions = [];
      for (const f of files) {
        try {
          const s = await cached(f, parseClaudeCodeFile);
          sessions.push({ ...s, mtime: f.mtime, project: baseName(s.cwd || path.dirname(f.file)) });
        } catch { /* unlesbare Datei überspringen */ }
      }
      const today = startOfDay(t);
      const sum = (days) => {
        const r = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
        for (const s of sessions) {
          for (const [day, d] of Object.entries(s.byDay)) {
            if (Number(day) < days) continue;
            r.input += d.input; r.output += d.output; r.cacheRead += d.cacheRead; r.cacheWrite += d.cacheWrite; r.cost += d.cost;
          }
        }
        return r;
      };
      const todaySum = sum(today);
      const weekSum = sum(today - 6 * DAY);
      const todaySessions = sessions.filter((s) => s.end >= today);
      const running = sessions.filter((s) => t - s.mtime < ACTIVE_MS);
      const activity = sessions
        .sort((a, b) => b.end - a.end)
        .slice(0, 12)
        .map((s) => ({
          title: s.summary || s.title || 'Sitzung ohne erkennbaren Auftrag',
          project: s.project,
          start: s.start,
          end: s.end,
          durationMs: Math.max(0, s.end - s.start),
          tools: Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} ×${c}`),
          errors: s.errors,
          running: t - s.mtime < ACTIVE_MS,
        }));
      return {
        status: sessions.length ? 'ok' : 'empty',
        source: 'Lokale Protokolle von Claude Code',
        metrics: [
          { label: 'Sitzungen heute', value: String(todaySessions.length), kind: 'measured' },
          { label: 'Tokens heute', value: tokensText(todaySum), kind: 'measured' },
          { label: 'Tokens 7 Tage', value: tokensText(weekSum), kind: 'measured' },
          { label: 'Wert zu API-Preisen heute', value: usdText(todaySum.cost), kind: 'estimate', hint: 'Mit einem Claude-Abo zahlst du das nicht so, es ist nur der Gegenwert zu API-Preisen.' },
          { label: 'Fehlgeschlagene Werkzeug-Aufrufe heute', value: String(todaySessions.reduce((a, s) => a + s.errors, 0)), kind: 'measured' },
        ],
        limits: [],
        limitsNote: 'Die Abo-Limits von Claude (5-Stunden- und Wochenlimit) gibt Anthropic über keine offizielle Schnittstelle heraus. In Claude Code siehst du sie mit /usage.',
        running: running.map((s) => ({ name: 'Claude Code', detail: `${s.project}: ${s.summary || s.title || 'Sitzung'}` })),
        activity,
      };
    },
  };
}

// ---------- Codex (lokale Protokolle inkl. Rate-Limits) ----------

async function parseCodexFile(file) {
  const s = { id: path.basename(file, '.jsonl'), cwd: '', title: '', model: '', start: 0, end: 0, tools: {}, errors: 0, total: null, byDay: {}, rate: null };
  let lastTotal = null;
  await eachLine(file, (o) => {
    const t = Date.parse(o.timestamp || '') || 0;
    if (t) { s.start = s.start ? Math.min(s.start, t) : t; s.end = Math.max(s.end, t); }
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      s.cwd = p.cwd || s.cwd;
      if (p.timestamp) s.start = Date.parse(p.timestamp) || s.start;
    } else if (o.type === 'turn_context') {
      if (p.model) s.model = p.model;
    } else if (o.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user' && !s.title) {
        const text = (p.content || []).filter((c) => c.type === 'input_text').map((c) => c.text).join(' ');
        if (text && !/^\s*(<environment_context|<user_instructions|# AGENTS\.md)/.test(text)) s.title = short(text);
      } else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
        const name = p.name || (p.type === 'local_shell_call' ? 'shell' : 'tool');
        s.tools[name] = (s.tools[name] || 0) + 1;
      }
    } else if (o.type === 'event_msg') {
      if (p.type === 'user_message' && !s.title && p.message) s.title = short(p.message);
      if (p.type === 'error' || p.type === 'stream_error') s.errors += 1;
      if (p.type === 'token_count') {
        const total = p.info?.total_token_usage;
        if (total) {
          // Zuwachs seit dem letzten Stand dem Tag zuordnen
          const prev = lastTotal || { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
          const day = startOfDay(t || s.end);
          const d = s.byDay[day] || (s.byDay[day] = { input: 0, cached: 0, output: 0 });
          d.input += Math.max(0, num(total.input_tokens) - num(prev.input_tokens));
          d.cached += Math.max(0, num(total.cached_input_tokens) - num(prev.cached_input_tokens));
          d.output += Math.max(0, num(total.output_tokens) - num(prev.output_tokens));
          lastTotal = total;
          s.total = total;
        }
        if (p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) s.rate = { at: t, limits: p.rate_limits };
      }
    }
  });
  return s;
}

function windowLabel(minutes) {
  const m = num(minutes);
  if (m === 300) return '5-Stunden-Fenster';
  if (m === 10080) return 'Wochenlimit';
  if (m >= 1440) return `${Math.round(m / 1440)}-Tage-Fenster`;
  if (m >= 60) return `${Math.round(m / 60)}-Stunden-Fenster`;
  return m ? `${m}-Minuten-Fenster` : 'Limit';
}

function codexProvider({ home, env, cached, now }) {
  const base = env.CODEX_HOME || path.join(home, '.codex');
  return {
    id: 'codex',
    name: 'Codex',
    async collect() {
      const dir = path.join(base, 'sessions');
      if (!fs.existsSync(dir)) return { status: 'empty', note: 'Keine Codex-Protokolle gefunden (Ordner .codex\\sessions fehlt).' };
      const t = now();
      const files = await recentFiles(dir, { since: t - LOOKBACK_DAYS * DAY, depth: 3 });
      const sessions = [];
      for (const f of files) {
        try {
          const s = await cached(f, parseCodexFile);
          sessions.push({ ...s, mtime: f.mtime, project: baseName(s.cwd) || 'Codex' });
        } catch { /* überspringen */ }
      }
      const today = startOfDay(t);
      const tok = (since) => sessions.reduce((r, s) => {
        for (const [day, d] of Object.entries(s.byDay)) if (Number(day) >= since) { r.input += d.input; r.cached += d.cached; r.output += d.output; }
        return r;
      }, { input: 0, cached: 0, output: 0 });
      const td = tok(today);
      const wk = tok(today - 6 * DAY);
      // Neuester Stand der Rate-Limits (kommt von OpenAI mit jeder Antwort)
      const latest = sessions.filter((s) => s.rate).sort((a, b) => b.rate.at - a.rate.at)[0]?.rate || null;
      const limits = [];
      if (latest) {
        for (const key of ['primary', 'secondary']) {
          const l = latest.limits[key];
          if (!l || l.used_percent === undefined) continue;
          let resetsAt = l.resets_at ? num(l.resets_at) * 1000 : l.resets_in_seconds !== undefined ? latest.at + num(l.resets_in_seconds) * 1000 : 0;
          const passed = resetsAt && resetsAt < t;
          limits.push({
            label: windowLabel(l.window_minutes),
            usedPercent: passed ? null : Math.round(num(l.used_percent)),
            resetsAt: resetsAt || null,
            asOf: latest.at,
            kind: 'measured',
            note: passed ? 'Seit dem letzten Stand zurückgesetzt (neuer Wert erst nach der nächsten Codex-Nutzung).' : null,
          });
        }
      }
      return {
        status: sessions.length ? 'ok' : 'empty',
        source: 'Lokale Protokolle von Codex',
        metrics: [
          { label: 'Sitzungen heute', value: String(sessions.filter((s) => s.end >= today).length), kind: 'measured' },
          { label: 'Tokens heute', value: `${fmtTokens(td.input)} ein (davon ${fmtTokens(td.cached)} aus dem Cache) · ${fmtTokens(td.output)} aus`, kind: 'measured' },
          { label: 'Tokens 7 Tage', value: `${fmtTokens(wk.input)} ein · ${fmtTokens(wk.output)} aus`, kind: 'measured' },
        ],
        limits,
        limitsNote: latest ? null : 'Noch kein Limit-Stand in den Protokollen. Er erscheint, sobald du Codex benutzt hast.',
        running: sessions.filter((s) => t - s.mtime < ACTIVE_MS).map((s) => ({ name: 'Codex', detail: `${s.project}: ${s.title || 'Sitzung'}` })),
        activity: sessions.sort((a, b) => b.end - a.end).slice(0, 12).map((s) => ({
          title: s.title || 'Sitzung ohne Text',
          project: s.project,
          start: s.start,
          end: s.end,
          durationMs: Math.max(0, s.end - s.start),
          tools: Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} ×${c}`),
          errors: s.errors,
          running: t - s.mtime < ACTIVE_MS,
          model: s.model,
        })),
      };
    },
  };
}

// ---------- Claude API der Organisation (Admin-Key, offizielle Usage- und Cost-API) ----------

function claudeApiProvider({ getSecret, fetchJson, now }) {
  return {
    id: 'claude_api',
    name: 'Claude API (Organisation)',
    async collect() {
      const key = getSecret('anthropicAdmin');
      if (!key) {
        return { status: 'setup', note: 'Für die Nutzung aller Keys deiner Organisation braucht Buddy einen Admin-Key (beginnt mit sk-ant-admin). Ohne ihn siehst du oben nur Buddys eigene Nutzung.' };
      }
      const t = now();
      const from = new Date(startOfDay(t) - 6 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      const base = 'https://api.anthropic.com/v1/organizations';
      const usage = await fetchJson(`${base}/usage_report/messages?starting_at=${encodeURIComponent(from)}&bucket_width=1d&limit=7`, headers);
      let todayTok = { in: 0, out: 0 };
      let weekTok = { in: 0, out: 0 };
      // Der neuste Tages-Eimer ist «heute» (Anthropic rechnet in UTC-Tagen)
      const latestStart = Math.max(0, ...(usage.data || []).map((b) => Date.parse(b.starting_at) || 0));
      for (const bucket of usage.data || []) {
        const start = Date.parse(bucket.starting_at) || 0;
        for (const r of bucket.results || []) {
          const input = num(r.uncached_input_tokens) + num(r.cache_read_input_tokens) + num(r.cache_creation?.ephemeral_5m_input_tokens) + num(r.cache_creation?.ephemeral_1h_input_tokens);
          weekTok = { in: weekTok.in + input, out: weekTok.out + num(r.output_tokens) };
          if (start === latestStart) todayTok = { in: todayTok.in + input, out: todayTok.out + num(r.output_tokens) };
        }
      }
      const metrics = [
        { label: 'Tokens heute (UTC-Tag)', value: `${fmtTokens(todayTok.in)} ein · ${fmtTokens(todayTok.out)} aus`, kind: 'measured' },
        { label: 'Tokens 7 Tage', value: `${fmtTokens(weekTok.in)} ein · ${fmtTokens(weekTok.out)} aus`, kind: 'measured' },
      ];
      try {
        const cost = await fetchJson(`${base}/cost_report?starting_at=${encodeURIComponent(from)}&limit=7`, headers);
        let cents = 0;
        for (const bucket of cost.data || []) for (const r of bucket.results || []) cents += num(r.amount);
        metrics.push({ label: 'Kosten 7 Tage', value: usdText(cents / 100), kind: 'measured', hint: 'Laut Cost-API von Anthropic (in US-Dollar).' });
      } catch (err) {
        metrics.push({ label: 'Kosten 7 Tage', value: 'nicht verfügbar', kind: 'unavailable', hint: err.message });
      }
      return { status: 'ok', source: 'Anthropic Admin API (Usage- und Cost-Report)', metrics, limits: [], limitsNote: 'Rate-Limits der API stehen in der Claude Console unter «Limits».' };
    },
  };
}

// ---------- OpenAI API (Admin-Key) und ChatGPT ----------

function chatgptProvider({ getSecret, fetchJson, now }) {
  return {
    id: 'chatgpt',
    name: 'ChatGPT / OpenAI',
    async collect() {
      const base = {
        limits: [],
        limitsNote: 'OpenAI gibt die Nachrichtenlimits von ChatGPT-Abos über keine offizielle Schnittstelle heraus. Buddy kann sie darum nicht anzeigen.',
      };
      const key = getSecret('openaiAdmin');
      if (!key) return { ...base, status: 'unavailable', note: 'Mit einem OpenAI-Admin-Key (beginnt mit sk-admin-) zeigt Buddy zusätzlich Tokens und Kosten deiner OpenAI-API-Nutzung.' };
      const t = now();
      const start = Math.floor((startOfDay(t) - 6 * DAY) / 1000);
      const headers = { authorization: `Bearer ${key}` };
      const usage = await fetchJson(`https://api.openai.com/v1/organization/usage/completions?start_time=${start}&bucket_width=1d&limit=7`, headers);
      let tin = 0; let tout = 0; let reqs = 0;
      for (const b of usage.data || []) for (const r of b.results || []) { tin += num(r.input_tokens); tout += num(r.output_tokens); reqs += num(r.num_model_requests); }
      const metrics = [{ label: 'API-Tokens 7 Tage', value: `${fmtTokens(tin)} ein · ${fmtTokens(tout)} aus · ${reqs} Anfragen`, kind: 'measured' }];
      try {
        const costs = await fetchJson(`https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&limit=7`, headers);
        let usd = 0;
        for (const b of costs.data || []) for (const r of b.results || []) usd += num(r.amount?.value);
        metrics.push({ label: 'API-Kosten 7 Tage', value: usdText(usd), kind: 'measured' });
      } catch (err) {
        metrics.push({ label: 'API-Kosten 7 Tage', value: 'nicht verfügbar', kind: 'unavailable', hint: err.message });
      }
      return { ...base, status: 'ok', source: 'OpenAI Admin API (Usage und Costs)', metrics };
    },
  };
}

function grokProvider() {
  return {
    id: 'grok',
    name: 'Grok',
    async collect() {
      return {
        status: 'unavailable',
        limits: [],
        limitsNote: 'xAI bietet für Grok-Abos keine offizielle Schnittstelle für Nutzung oder Limits. Buddy zeigt darum nichts an, statt zu raten.',
      };
    },
  };
}

// ---------- Buddy selbst ----------

function buddyProvider({ getBuddyUsage, getBuddyHistory, isRunning }) {
  return {
    id: 'buddy',
    name: 'Buddy (Claude API)',
    async collect() {
      const u = getBuddyUsage();
      const tasks = getBuddyHistory();
      const today = startOfDay(Date.now());
      const todayTasks = tasks.filter((x) => x.started >= today);
      const b = u.budget;
      const limits = b.limit ? [{ label: 'Ausgabenlimit diesen Monat', usedPercent: Math.round(b.ratio * 100), resetsAt: nextMonth(), kind: 'measured', detail: `${usdText(b.spent)} von ${usdText(b.limit)}` }] : [];
      return {
        status: 'ok',
        source: 'Buddys eigene Messung (Token-Zahlen der API)',
        metrics: [
          { label: 'Kosten diesen Monat', value: usdText(u.totals.cost), kind: 'measured' },
          { label: 'Hochrechnung Monat', value: usdText(u.estimate), kind: 'estimate' },
          { label: 'Aufgaben heute', value: `${todayTasks.length}, davon ${todayTasks.filter((x) => ['error', 'partial', 'stopped'].includes(x.status)).length} mit Fehlern`, kind: 'measured' },
          { label: 'Tokens diesen Monat', value: `${fmtTokens(u.totals.input + u.totals.cacheRead + u.totals.cacheWrite)} ein · ${fmtTokens(u.totals.output)} aus`, kind: 'measured' },
        ],
        limits,
        limitsNote: b.limit ? null : 'Kein Ausgabenlimit gesetzt (Einstellungen → Kosten).',
        running: isRunning() ? [{ name: 'Buddy', detail: 'arbeitet gerade an einer Aufgabe' }] : [],
        activity: tasks.slice(0, 8).map((x) => ({
          title: x.title,
          project: (x.models || []).map((m) => models.info(m).short).join(' → '),
          start: x.started,
          end: x.ended || x.started,
          durationMs: x.ended ? x.ended - x.started : 0,
          tools: [],
          errors: (x.steps || []).filter((s) => s.status === 'error').length,
          running: x.status === 'running',
          status: x.status,
        })),
      };
    },
  };
}

function nextMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

// ---------- Laufende KI-Programme ----------

const PROGRAMS = [
  { name: 'Claude Code', test: (p) => (/^claude(\.exe)?$/i.test(p.name) && !/AnthropicClaude|\\Claude\\app|WindowsApps/i.test(p.path)) || /@anthropic-ai[\\/]claude-code|claude-code[\\/]cli/i.test(p.cmd) },
  { name: 'Claude (App)', test: (p) => /^claude(\.exe)?$/i.test(p.name) && /AnthropicClaude|\\Claude\\app|WindowsApps/i.test(p.path) },
  { name: 'Codex', test: (p) => /^codex(\.exe)?$/i.test(p.name) || /@openai[\\/]codex/i.test(p.cmd) },
  { name: 'ChatGPT (App)', test: (p) => /^chatgpt(\.exe)?$/i.test(p.name) },
  { name: 'Gemini CLI', test: (p) => /@google[\\/]gemini-cli/i.test(p.cmd) },
  { name: 'GitHub Copilot CLI', test: (p) => /@github[\\/]copilot/i.test(p.cmd) },
  { name: 'Cursor', test: (p) => /^cursor(\.exe)?$/i.test(p.name) },
  { name: 'Windsurf', test: (p) => /^windsurf(\.exe)?$/i.test(p.name) },
  { name: 'Ollama', test: (p) => /^ollama( app)?(\.exe)?$/i.test(p.name) },
  { name: 'LM Studio', test: (p) => /^lm studio(\.exe)?$/i.test(p.name) },
];

function matchPrograms(list) {
  const found = new Map();
  for (const p of list) {
    const proc = { name: String(p.name || ''), path: String(p.path || ''), cmd: String(p.cmd || '') };
    const hit = PROGRAMS.find((x) => x.test(proc));
    if (hit) found.set(hit.name, (found.get(hit.name) || 0) + 1);
  }
  return [...found.entries()].map(([name, count]) => ({ name, count }));
}

// ---------- Text für den Chat ----------

function fmtTokens(n) {
  const v = num(n);
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1e6).toFixed(2)} Mio.`;
}
const tokensText = (r) => `${fmtTokens(r.input + r.cacheRead + r.cacheWrite)} ein · ${fmtTokens(r.output)} aus`;
function usdText(v) {
  const n = num(v);
  if (n === 0) return '$0.00';
  if (n < 0.01) return '< $0.01';
  return `$${n.toFixed(2)}`;
}
const timeText = (t) => new Date(t).toLocaleString('de-CH', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const durText = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 3600e3 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600e3).toFixed(1)} h`);

function toText(report, only) {
  const lines = [`KI-Nutzung, Stand ${timeText(report.updatedAt)}. Markierung: [gemessen], [Schätzung], [nicht verfügbar].`];
  for (const p of report.providers) {
    if (only && only !== 'alle' && p.id !== only && !(only === 'claude' && /claude/.test(p.id))) continue;
    lines.push(`\n## ${p.name}${p.source ? ` (Quelle: ${p.source})` : ''}`);
    if (p.status === 'error') lines.push(`Fehler beim Abrufen: ${p.error}`);
    if (p.note) lines.push(p.note);
    for (const m of p.metrics || []) lines.push(`- ${m.label}: ${m.value} [${m.kind === 'estimate' ? 'Schätzung' : m.kind === 'unavailable' ? 'nicht verfügbar' : 'gemessen'}]`);
    for (const l of p.limits || []) {
      lines.push(`- ${l.label}: ${l.usedPercent === null ? 'zurückgesetzt' : `${l.usedPercent} % genutzt, ${100 - l.usedPercent} % übrig`}${l.resetsAt ? `, setzt zurück ${timeText(l.resetsAt)}` : ''}${l.asOf ? ` (Stand ${timeText(l.asOf)})` : ''} [gemessen]`);
    }
    if (p.limitsNote) lines.push(`- Limits: ${p.limitsNote} [nicht verfügbar]`);
    for (const a of (p.activity || []).slice(0, 6)) {
      lines.push(`- ${a.running ? 'läuft: ' : ''}${timeText(a.end)} · ${a.project ? `${a.project}: ` : ''}${a.title} (${durText(a.durationMs)}${a.tools?.length ? `, Werkzeuge: ${a.tools.join(', ')}` : ''}${a.errors ? `, ${a.errors} Fehler` : ''})`);
    }
  }
  if (!only || only === 'alle' || only === 'agents') {
    lines.push('\n## Laufende KI-Programme');
    if (report.programsError) lines.push(`Nicht prüfbar: ${report.programsError}`);
    else if (!report.programs.length && !report.running.length) lines.push('Keine bekannten KI-Programme laufen gerade.');
    for (const r of report.programs) lines.push(`- ${r.name}`);
    for (const r of report.running) lines.push(`- aktive Sitzung: ${r.name} · ${r.detail}`);
  }
  return lines.join('\n');
}

const TOOL_DEFINITIONS = [
  {
    name: 'ai_usage',
    description:
      'Zeigt die Nutzung der KI-Dienste des Nutzers: Buddy, Claude API, Claude Code, Codex, ChatGPT/OpenAI, Grok und welche KI-Programme gerade laufen. ' +
      'Liefert gemessene Werte, Schätzungen und nicht verfügbare Daten getrennt markiert. Nenne nie Werte, die nicht im Ergebnis stehen.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['alle', 'buddy', 'claude', 'claude_api', 'claude_code', 'codex', 'chatgpt', 'grok', 'agents'], description: 'Standard: alle' },
      },
    },
  },
];

function createAiUsage({ home, env = process.env, getSecret, fetchJson, getBuddyUsage, getBuddyHistory, isBuddyRunning = () => false, listProcesses, isEnabled = () => true, log = () => {}, now = () => Date.now() }) {
  const cached = fileCache();
  const providers = [
    buddyProvider({ getBuddyUsage, getBuddyHistory, isRunning: isBuddyRunning }),
    claudeApiProvider({ getSecret, fetchJson, now }),
    claudeCodeProvider({ home, env, cached, now }),
    codexProvider({ home, env, cached, now }),
    chatgptProvider({ getSecret, fetchJson, now }),
    grokProvider(),
  ];
  const LOCAL = new Set(['claude_code', 'codex']);
  let last = null;
  let pending = null;

  async function collect({ force = false } = {}) {
    if (!force && last && now() - last.updatedAt < CACHE_MS) return last;
    if (pending) return pending;
    pending = (async () => {
      const results = await Promise.all(providers.map(async (p) => {
        const startedAt = now();
        if (LOCAL.has(p.id) && !isEnabled()) {
          return { id: p.id, name: p.name, status: 'off', note: 'Lesen lokaler Protokolle ist in den Einstellungen ausgeschaltet.', updatedAt: startedAt };
        }
        try {
          const r = await p.collect();
          return { id: p.id, name: p.name, updatedAt: now(), metrics: [], limits: [], activity: [], running: [], ...r };
        } catch (err) {
          log(`KI-Nutzung ${p.id}: ${err.message}`);
          return { id: p.id, name: p.name, status: 'error', error: err.message, updatedAt: now(), metrics: [], limits: [], activity: [], running: [] };
        }
      }));
      let programs = [];
      let programsError = null;
      try {
        programs = matchPrograms(await listProcesses());
      } catch (err) {
        programsError = err.message;
      }
      const running = results.flatMap((r) => r.running || []);
      last = { updatedAt: now(), providers: results, programs, programsError, running };
      return last;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  async function run(name, input = {}) {
    if (name !== 'ai_usage') return { error: true, text: `Unbekanntes Werkzeug: ${name}` };
    const report = await collect({ force: true });
    return { text: toText(report, input.provider || 'alle') };
  }

  return {
    collect,
    run,
    definitions: TOOL_DEFINITIONS,
    names: new Set(TOOL_DEFINITIONS.map((t) => t.name)),
    describe: () => 'KI-Nutzung abgefragt',
  };
}

module.exports = { createAiUsage, matchPrograms, parseClaudeCodeFile, parseCodexFile, toText, windowLabel, TOOL_DEFINITIONS };
