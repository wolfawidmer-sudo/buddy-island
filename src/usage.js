// Token- und Kostenstatistik. Speichert nur Zahlen, keine Inhalte.
const fs = require('fs');
const path = require('path');
const models = require('./models');

const KEEP_MONTHS = 12;
const KEEP_RECENT = 60;

const monthKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const emptyTotals = () => ({ requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });

function addTo(totals, usage, cost) {
  totals.requests += 1;
  totals.input += Number(usage.input_tokens) || 0;
  totals.output += Number(usage.output_tokens) || 0;
  totals.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
  totals.cacheRead += Number(usage.cache_read_input_tokens) || 0;
  totals.cost += cost;
}

function createUsage({ file, now = () => Date.now(), log = () => {} } = {}) {
  let data = { months: {}, recent: [] };
  const session = { started: now(), totals: emptyTotals(), models: {} };
  let saveTimer = null;

  try {
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') data = { months: parsed.months || {}, recent: Array.isArray(parsed.recent) ? parsed.recent : [] };
    }
  } catch (err) {
    log(`Nutzungsdaten unlesbar, starte neu: ${err.message}`);
  }

  function save() {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 1500);
  }

  function flush() {
    if (!file) return;
    clearTimeout(saveTimer);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const keys = Object.keys(data.months).sort().slice(-KEEP_MONTHS);
      const months = {};
      for (const k of keys) months[k] = data.months[k];
      data.months = months;
      fs.writeFileSync(file + '.tmp', JSON.stringify(data));
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      log(`Nutzungsdaten nicht gespeichert: ${err.message}`);
    }
  }

  function month(key = monthKey(now())) {
    if (!data.months[key]) data.months[key] = { totals: emptyTotals(), models: {}, days: {} };
    return data.months[key];
  }

  // Eine API-Anfrage verbuchen. purpose: 'Router', 'Antwort', 'Steuerung' …
  function record({ model, usage = {}, purpose = 'Antwort', task = null }) {
    const cost = models.costOf(model, usage);
    const t = now();
    const m = month();
    addTo(m.totals, usage, cost);
    m.models[model] = m.models[model] || emptyTotals();
    addTo(m.models[model], usage, cost);
    const day = String(new Date(t).getDate());
    m.days[day] = (m.days[day] || 0) + cost;

    addTo(session.totals, usage, cost);
    session.models[model] = session.models[model] || emptyTotals();
    addTo(session.models[model], usage, cost);

    data.recent.unshift({
      time: t,
      model,
      purpose,
      task,
      input: (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0),
      output: Number(usage.output_tokens) || 0,
      cost,
    });
    data.recent = data.recent.slice(0, KEEP_RECENT);
    save();
    return cost;
  }

  function spentThisMonth() {
    return month().totals.cost;
  }

  // Hochrechnung: bisherige Kosten / vergangene Tage × Tage im Monat
  function estimateMonth() {
    const d = new Date(now());
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const elapsed = Math.max(1, d.getDate() - 1 + (d.getHours() * 60 + d.getMinutes()) / 1440);
    const spent = spentThisMonth();
    return spent <= 0 ? 0 : (spent / elapsed) * daysInMonth;
  }

  // Wie viel vom Limit übrig ist. level: ok | warn | tight | blocked | none
  function budget(limit) {
    const max = Number(limit) || 0;
    const spent = spentThisMonth();
    if (!max) return { limit: 0, spent, left: Infinity, ratio: 0, level: 'none' };
    const ratio = spent / max;
    const level = ratio >= 1 ? 'blocked' : ratio >= 0.95 ? 'tight' : ratio >= 0.8 ? 'warn' : 'ok';
    return { limit: max, spent, left: Math.max(0, max - spent), ratio, level };
  }

  function summary(limit) {
    const key = monthKey(now());
    const m = month(key);
    const byModel = Object.entries(m.models)
      .map(([id, t]) => ({ id, name: models.info(id).short, ...t }))
      .sort((a, b) => b.cost - a.cost);
    return {
      month: key,
      totals: { ...m.totals },
      models: byModel,
      session: { ...session.totals, started: session.started },
      estimate: estimateMonth(),
      budget: budget(limit),
      recent: data.recent.slice(0, 20),
    };
  }

  function reset() {
    data = { months: {}, recent: [] };
    session.totals = emptyTotals();
    session.models = {};
    flush();
  }

  return { record, budget, summary, estimateMonth, spentThisMonth, reset, flush };
}

module.exports = { createUsage, monthKey };
