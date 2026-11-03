// Ausführungsverlauf: was Buddy bei welcher Aufgabe gemacht hat.
// Bleibt nur auf dem PC. Gespeichert wird ein kurzer Titel, keine Antworten.
const fs = require('fs');
const path = require('path');

const MAX_TASKS = 150;
const MAX_STEPS = 120;

function createHistory({ file, enabled = () => true, now = () => Date.now(), log = () => {} } = {}) {
  let tasks = [];
  let saveTimer = null;

  try {
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) tasks = parsed;
    }
  } catch (err) {
    log(`Verlauf unlesbar, starte neu: ${err.message}`);
  }
  // Aufgaben, die beim letzten Beenden noch liefen, sauber abschliessen
  for (const t of tasks) if (t.status === 'running') t.status = 'interrupted';

  function save() {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 1000);
  }

  function flush() {
    if (!file) return;
    clearTimeout(saveTimer);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(tasks.slice(0, MAX_TASKS)));
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      log(`Verlauf nicht gespeichert: ${err.message}`);
    }
  }

  function start({ id, title, route }) {
    const task = {
      id,
      title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      started: now(),
      ended: null,
      status: 'running',
      route: route || null,
      models: [],
      steps: [],
      escalations: [],
      cost: 0,
      tokens: { input: 0, output: 0 },
      verified: null,
      error: null,
    };
    if (enabled()) {
      tasks.unshift(task);
      tasks = tasks.slice(0, MAX_TASKS);
      save();
    }

    const api = {
      task,
      step(kind, label, status = 'ok', extra = {}) {
        const entry = { time: now(), kind, label: String(label || '').slice(0, 140), status, ...extra };
        if (task.steps.length < MAX_STEPS) task.steps.push(entry);
        save();
        return entry;
      },
      useModel(model) {
        if (task.models[task.models.length - 1] !== model) task.models.push(model);
        save();
      },
      escalate(from, to, reason) {
        task.escalations.push({ time: now(), from, to, reason: String(reason || '').slice(0, 160) });
        save();
      },
      addCost(cost, usage = {}) {
        task.cost += cost;
        task.tokens.input += (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0);
        task.tokens.output += Number(usage.output_tokens) || 0;
        save();
      },
      finish(status, { verified = null, error = null } = {}) {
        task.status = status;
        task.ended = now();
        task.verified = verified;
        task.error = error ? String(error).slice(0, 200) : null;
        save();
      },
    };
    return api;
  }

  function list(limit = 30) {
    return tasks.slice(0, limit);
  }

  function clear() {
    tasks = [];
    flush();
  }

  return { start, list, clear, flush };
}

module.exports = { createHistory };
