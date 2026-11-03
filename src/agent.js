// Autonomer Ausführungsagent: plant, führt Schritt für Schritt aus, prüft
// Ergebnisse, behandelt Fehler, wechselt bei Bedarf das Modell und fragt bei
// riskanten Aktionen um Erlaubnis. Alle Modelle teilen denselben Verlauf.

const crypto = require('crypto');
const models = require('./models');
const permissions = require('./permissions');
const { tierForStep, budgetCap, availableTier, STEP_EFFORT } = require('./router');

const MAX_TOOL_ROUNDS = 16;
const MAX_COMPUTER_ROUNDS = 60;
const MAX_ESCALATIONS = 2;
const ESCALATE_AFTER_ERRORS = 2;
const REPEAT_LIMIT = 2; // dieselbe Eingabe höchstens 2× direkt hintereinander ohne Prüfung
const KEEP_IMAGES = 3;
const PRUNE_IMAGES_AT = 8;
const MAX_GUARDS = 2;
const MAX_STREAM_RETRIES = 2;
const TIMEOUTS = { tool: 20000, files: 180000, computer: 30000, permission: 10 * 60 * 1000 };

const COMPUTER_MEMBERS = new Set([
  'screenshot', 'zoom', 'cursor_position', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'mouse_move', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'wait',
]);
const COMPUTER_READ = new Set(['screenshot', 'zoom', 'cursor_position', 'wait']);
const COMPUTER_IDEMPOTENT = new Set(['screenshot', 'zoom', 'cursor_position']);
// Werkzeuge mit Wirkung: doppelte Ausführung in derselben Aufgabe verhindern
const SIDE_EFFECT_TOOLS = new Set(['set_timer', 'open_app', 'open_website', 'open_settings', 'create_folder', 'move_files', 'delete_files']);

const AGENT_TOOLS = [
  {
    name: 'update_plan',
    description:
      'Legt den Ausführungsplan einer mehrstufigen Aufgabe fest oder aktualisiert ihn. Zu Beginn aufrufen und immer dann, wenn ein Schritt fertig ist, ' +
      'fehlschlägt oder sich der Plan ändert. Immer die ganze Liste schicken, genau ein Schritt ist in_progress. ' +
      'difficulty bestimmt, welches Modell den Schritt übernimmt: simple (günstig, z. B. Zusammenfassung), normal, hard (nur für wirklich schwierige Teile).',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'] },
              difficulty: { type: 'string', enum: ['simple', 'normal', 'hard'] },
              note: { type: 'string', description: 'Kurz: Ergebnis oder Grund für einen Fehler.' },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'request_permission',
    description:
      'Fragt den Nutzer um Erlaubnis, bevor du über die Bildschirmsteuerung etwas mit mittlerem oder hohem Risiko tust: Software installieren, ' +
      'Einstellungen in Apps oder Windows ändern, Dateien löschen, Befehle mit Administratorrechten, Sicherheitseinstellungen. Halte dich an die Antwort.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Was genau du tun willst, ein Satz.' },
        risk: { type: 'string', enum: ['medium', 'high'] },
        category: { type: 'string', enum: ['settings', 'install', 'delete', 'admin', 'system', 'security', 'send'] },
        details: { type: 'string' },
      },
      required: ['action', 'risk'],
    },
  },
  {
    name: 'escalate',
    description: 'Bittet um ein leistungsfähigeres Modell, wenn die Aufgabe für dich zu schwierig ist oder du wiederholt scheiterst. Verlauf und Plan bleiben erhalten.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

const AGENT_RULES = `

Arbeitsweise als Agent:
- Mehrstufige Aufgaben: Lege zuerst mit update_plan einen kurzen Plan an (2 bis 8 Schritte, genau einer in_progress) und aktualisiere ihn, sobald ein Schritt fertig ist oder sich etwas ändert. difficulty: simple für Leichtes wie die Schlusszusammenfassung, normal für das Übliche, hard nur für wirklich Schwieriges.
- Beobachte nach jeder Aktion das Ergebnis und prüfe wichtige Schritte (Bildschirmfoto, Datei-Liste, Rückmeldung des Werkzeugs). Behaupte nie, etwas sei erledigt, ohne es geprüft zu haben. Hat etwas nicht geklappt, sag das ehrlich und nenne den Grund.
- Schlägt ein Schritt fehl: Ursache überlegen, einen anderen Weg versuchen und den Plan anpassen. Wiederhole keine Aktion, die schon nichts bewirkt hat.
- Für Dateien nimm die Datei-Werkzeuge (list_files, find_duplicates, create_folder, move_files, delete_files) statt Maus und Tastatur. Sie arbeiten nur in den Benutzerordnern, und delete_files legt in den Papierkorb.
- Risiko: mittel = Dateien verschieben, App-Einstellungen ändern, normale Software installieren. Hoch = Dateien löschen, Admin-Befehle, System- oder Sicherheitseinstellungen. Für so etwas über die Bildschirmsteuerung rufe vorher request_permission auf.
- Deaktiviere oder umgehe nie Windows-Sicherheitsfunktionen (Virenschutz, Firewall, Benutzerkontensteuerung, SmartScreen), auch nicht auf Umwegen. Ist das wirklich nötig, erkläre es und bitte den Nutzer, es selbst zu tun.
- Lehnt der Nutzer etwas ab, versuche keinen Umweg.
- Ist die Aufgabe für dich zu schwer oder scheiterst du wiederholt, rufe escalate auf.
- Schliesse mit einer kurzen Zusammenfassung, was du gemacht und geprüft hast.`;

const STATUS_LABEL = { pending: 'offen', in_progress: 'läuft', done: 'erledigt', failed: 'fehlgeschlagen', skipped: 'übersprungen' };

const abortError = () => Object.assign(new Error('abgebrochen'), { name: 'AbortError' });

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} hat zu lange gedauert (über ${Math.round(ms / 1000)} s) und wurde abgebrochen.`), { timeout: true })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t) return t;
  }
  return '';
}

// Einfache Prüfung der Eingaben gegen das Schema (Pflichtfelder und Typen)
function validateInput(def, input) {
  if (!def) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Die Eingabe muss ein Objekt sein.';
  const schema = def.input_schema || {};
  for (const req of schema.required || []) {
    if (input[req] === undefined || input[req] === null || input[req] === '') return `Pflichtfeld «${req}» fehlt.`;
  }
  for (const [k, v] of Object.entries(input)) {
    const prop = schema.properties?.[k];
    if (!prop || v === undefined || v === null) continue;
    const t = prop.type;
    const ok = !t
      || (t === 'string' && typeof v === 'string')
      || ((t === 'number' || t === 'integer') && typeof v === 'number' && Number.isFinite(v))
      || (t === 'boolean' && typeof v === 'boolean')
      || (t === 'array' && Array.isArray(v))
      || (t === 'object' && typeof v === 'object');
    if (!ok) return `Feld «${k}» hat den falschen Typ (erwartet: ${t}).`;
    if (prop.enum && !prop.enum.includes(v)) return `Feld «${k}» muss einer dieser Werte sein: ${prop.enum.join(', ')}.`;
  }
  return null;
}

// Alte Bildschirmfotos durch Text ersetzen (spart viele Tokens). Nur in Schüben,
// damit der Prompt-Cache nicht bei jeder Runde neu geschrieben werden muss.
function pruneImages(conversation, keep = KEEP_IMAGES, at = PRUNE_IMAGES_AT) {
  const refs = [];
  for (const m of conversation) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
      b.content.forEach((c, i) => { if (c.type === 'image') refs.push([b, i]); });
    }
  }
  if (refs.length < at) return 0;
  const drop = refs.slice(0, refs.length - keep);
  for (const [b, i] of drop) b.content[i] = { type: 'text', text: '[Älteres Bildschirmfoto entfernt]' };
  return drop.length;
}

function planText(plan) {
  if (!plan || !plan.length) return 'Kein Plan.';
  return plan.map((s, i) => `${i + 1}. [${STATUS_LABEL[s.status] || s.status}] ${s.title}${s.note ? ` – ${s.note}` : ''}`).join('\n');
}

function createAgent(deps) {
  const {
    claude, router, usage, history, getKey, getSettings, getTools, getComputer, getFiles, isComputerAvailable,
    getAvailableModels, getGame, systemPrompt, askControl, askPermission, onControl, onAuthError, log = () => {},
  } = deps;

  async function run({ id, messages, meta = {}, send, signal }) {
    const apiKey = getKey();
    if (!apiKey) {
      send('chat:error', { id, message: 'Noch kein API-Key verbunden. Öffne die Einstellungen.', code: 'key' });
      return;
    }
    const settings = getSettings();
    const auto = settings.autoModel !== false;
    const policy = permissions.cleanPolicy(settings.permissions);
    const limit = Number(settings.monthlyLimit) || 0;
    let budget = usage.budget(limit);
    if (budget.level === 'blocked') {
      send('chat:error', { id, code: 'budget', message: `Dein Ausgabenlimit von $${limit.toFixed(2)} für diesen Monat ist erreicht. Du kannst es in den Einstellungen unter «Kosten» anpassen.` });
      return;
    }

    const tools = getTools();
    const computer = getComputer();
    const files = getFiles();
    let withComputer = Boolean(isComputerAvailable());
    const conversation = messages.map((m) => ({ role: m.role, content: m.content }));
    const userText = lastUserText(conversation);
    const tiers = models.resolveTiers(await getAvailableModels().catch(() => []));

    const st = {
      round: 0,
      model: null,
      tier: null,
      effort: null,
      floor: null,
      plan: null,
      escalations: 0,
      lastEscalationRound: -10,
      consecutiveErrors: 0,
      invalidCalls: 0,
      repeat: { sig: '', count: 0 },
      unverified: false,
      lastShotHash: null,
      shotBeforeInput: null,
      guards: 0,
      streamRetries: 0,
      executed: new Map(),
      grants: { control: settings.confirmControl === false ? true : null, medium: false, recent: null },
      actions: 0,
      cost: 0,
      tokens: { input: 0, output: 0 },
      notes: [],
      inControl: false,
      failedStepEscalated: false,
      wroteText: false,
    };

    let task = null;
    let decision = null;

    const startControl = () => {
      if (st.inControl) return;
      st.inControl = true;
      onControl?.(true);
      send('agent:control', { id, active: true });
    };
    const endControl = () => {
      if (!st.inControl) return;
      st.inControl = false;
      onControl?.(false);
      send('agent:control', { id, active: false, actions: st.actions });
    };

    const routeInfo = (extra = {}) => ({
      id,
      model: st.model,
      modelName: models.info(st.model).short,
      tier: st.tier,
      effort: st.effort,
      reason: decision?.reason || '',
      source: decision?.source || '',
      estimate: decision?.estimate || 0,
      cost: st.cost,
      auto,
      ...extra,
    });

    // Welches Modell die nächste Runde macht
    function pick() {
      if (!auto) {
        return { model: decision.model, tier: decision.tier, effort: decision.effort, why: null };
      }
      budget = usage.budget(limit);
      const active = st.plan?.find((s) => s.status === 'in_progress');
      let tier = decision.tier;
      let effort = decision.effort;
      let why = null;
      if (active && active.difficulty) {
        tier = tierForStep(active.difficulty, { decision, budget, tiers });
        if (!(settings.effort && settings.effort !== 'auto')) effort = STEP_EFFORT[active.difficulty] || effort;
        why = `Schritt «${active.title}»`;
      }
      // Nach einer Eskalation nicht mehr darunter, ausser für einen leichten Abschluss-Schritt
      const others = (st.plan || []).filter((s) => s !== active);
      const finalSimple = active?.difficulty === 'simple' && others.length > 0 && others.every((s) => s.status !== 'pending' && s.status !== 'in_progress');
      if (st.floor && !finalSimple) {
        tier = models.maxTier(tier, st.floor);
        if (effort === 'low') effort = 'medium';
      }
      tier = models.minTier(tier, st.floor ? models.maxTier(budgetCap(budget), st.floor) : budgetCap(budget));
      tier = availableTier(tier, tiers) || decision.tier;
      const model = tiers[tier] || decision.model;
      return { model, tier, effort: models.supportedEffort(model, effort), why };
    }

    function escalate(reason, { force = false } = {}) {
      if (!auto) return { ok: false, text: 'Das Modell wurde manuell gewählt, darum wechselt Buddy nicht automatisch.' };
      if (st.escalations >= MAX_ESCALATIONS) return { ok: false, text: 'Es wurde schon zweimal gewechselt. Mach mit dem aktuellen Modell weiter oder erkläre dem Nutzer, was nicht geht.' };
      if (!force && st.round - st.lastEscalationRound < 2) return { ok: false, text: 'Gerade erst gewechselt.' };
      const current = st.tier || decision.tier;
      const next = models.nextTier(models.maxTier(current, st.floor || 'haiku'));
      if (!next || !tiers[next]) return { ok: false, text: 'Es gibt kein stärkeres Modell. Mach mit dem aktuellen weiter.' };
      budget = usage.budget(limit);
      if (budget.level === 'tight' || budget.level === 'blocked') return { ok: false, text: 'Das Ausgabenlimit ist fast erreicht, darum kein Wechsel auf ein teureres Modell.' };
      st.floor = next;
      st.escalations += 1;
      st.lastEscalationRound = st.round;
      st.consecutiveErrors = 0;
      st.invalidCalls = 0;
      const toName = models.info(tiers[next]).name;
      task?.escalate(st.model, tiers[next], reason);
      task?.step('escalate', `${models.info(st.model).short} → ${models.info(tiers[next]).short}: ${reason}`, 'ok');
      send('agent:escalate', { id, from: models.info(st.model).short, to: models.info(tiers[next]).short, reason });
      log(`Eskalation ${st.model} -> ${tiers[next]}: ${reason}`);
      st.notes.push(`[Buddy: ${reason} Ab jetzt übernimmt ${toName}. Verlauf und Plan bleiben gleich. Mach dort weiter, wo es nicht geklappt hat, und versuche einen anderen Weg.\nAktueller Plan:\n${planText(st.plan)}]`);
      return { ok: true, text: `Gewechselt auf ${toName}.` };
    }

    function permissionLabel(call) {
      if (call.toolset_name === 'computer') return computer?.describe(call.name, call.input) || call.name;
      if (files?.names.has(call.name)) return files.summarize(call.name, call.input);
      return tools.describe(call.name, call.input);
    }

    // ---------- Einzelne Aktion ausführen ----------

    async function execute(call, ctx) {
      const isComputer = call.toolset_name === 'computer';
      const base = isComputer
        ? { type: 'tool_result', tool_use_id: call.id, toolset_name: 'computer' }
        : { type: 'tool_result', tool_use_id: call.id };
      const fail = (text, { invalid = false, counts = true } = {}) => {
        if (invalid) st.invalidCalls += 1;
        if (counts) st.consecutiveErrors += 1;
        if (isComputer) ctx.computerFailed = true;
        return { ...base, is_error: true, content: text };
      };

      if (isComputer && ctx.computerFailed) return { ...base, is_error: true, content: 'Not executed: an earlier computer action in this turn failed.' };
      if (call.invalidJson) {
        task?.step('error', `Ungültiger Aufruf von ${call.name}`, 'error');
        return fail('Ungültiger Aufruf: Die Eingabe war kein gültiges JSON. Schicke den Aufruf nochmals korrekt.', { invalid: true });
      }

      // --- Agent-Werkzeuge ---
      if (!isComputer && call.name === 'update_plan') {
        const err = validateInput(AGENT_TOOLS[0], call.input);
        if (err) return fail(`Ungültiger Plan: ${err}`, { invalid: true });
        const steps = call.input.steps.slice(0, 12).map((s) => ({
          title: String(s.title || 'Schritt').slice(0, 100),
          status: STATUS_LABEL[s.status] ? s.status : 'pending',
          difficulty: ['simple', 'normal', 'hard'].includes(s.difficulty) ? s.difficulty : 'normal',
          note: s.note ? String(s.note).slice(0, 160) : '',
        }));
        const prevActive = st.plan?.find((s) => s.status === 'in_progress')?.title;
        const newlyFailed = steps.filter((s) => s.status === 'failed' && !st.plan?.some((p) => p.title === s.title && p.status === 'failed'));
        st.plan = steps;
        send('agent:plan', { id, steps });
        const active = steps.find((s) => s.status === 'in_progress');
        if (active && active.title !== prevActive) task?.step('plan', `Schritt: ${active.title}`, 'ok');
        if (newlyFailed.length) {
          st.consecutiveErrors += 1;
          task?.step('plan', `Fehlgeschlagen: ${newlyFailed.map((s) => s.title).join(', ')}`, 'error');
          if (!st.failedStepEscalated) {
            st.failedStepEscalated = true;
            const e = escalate('Ein Planschritt ist fehlgeschlagen.');
            if (e.ok) ctx.escalated = true;
          }
        }
        return { ...base, content: `Plan gespeichert.\n${planText(steps)}` };
      }
      if (!isComputer && call.name === 'escalate') {
        const reason = String(call.input?.reason || 'Aufgabe zu schwierig.').slice(0, 160);
        const e = escalate(`Das Modell bat um Hilfe: ${reason}`, { force: true });
        if (e.ok) ctx.escalated = true;
        return { ...base, content: e.text };
      }

      // --- Bekannt und gültig? ---
      let def = null;
      if (isComputer) {
        if (!withComputer || !COMPUTER_MEMBERS.has(call.name)) return fail(`Unbekannte Steuerungs-Aktion: ${call.name}`, { invalid: true });
      } else {
        def = [...tools.definitions, ...(files?.definitions || []), ...AGENT_TOOLS].find((d) => d.name === call.name);
        if (!def) {
          task?.step('error', `Unbekanntes Werkzeug ${call.name}`, 'error');
          return fail(`Unbekanntes Werkzeug: ${call.name}. Benutze nur die angebotenen Werkzeuge.`, { invalid: true });
        }
        const err = validateInput(def, call.input);
        if (err) {
          task?.step('error', `Ungültiger Aufruf von ${call.name}: ${err}`, 'error');
          return fail(`Ungültiger Aufruf von ${call.name}: ${err}`, { invalid: true });
        }
      }

      if (isComputer && getGame().active) {
        return fail(`Gerade läuft ein Spiel (${getGame().name}). Im Spielmodus steuert Buddy den PC nicht. Sag dem Nutzer, dass du das nach dem Spiel machen kannst.`, { counts: false });
      }

      // --- Doppelte Aktionen verhindern ---
      const sig = `${isComputer ? 'c:' : ''}${call.name}:${JSON.stringify(call.input || {})}`;
      if (!isComputer && SIDE_EFFECT_TOOLS.has(call.name) && st.executed.has(sig)) {
        const ago = Math.round((Date.now() - st.executed.get(sig)) / 1000);
        task?.step('skip', `Doppelt, übersprungen: ${tools.describe?.(call.name, call.input) || call.name}`, 'skipped');
        return { ...base, content: `Nicht nochmals ausgeführt: Genau diese Aktion wurde in dieser Aufgabe vor ${ago} s schon erfolgreich gemacht.` };
      }
      if (isComputer && !COMPUTER_READ.has(call.name)) {
        if (st.repeat.sig === sig) st.repeat.count += 1;
        else st.repeat = { sig, count: 1 };
        if (st.repeat.count > REPEAT_LIMIT) {
          ctx.stuck = true;
          task?.step('skip', `Wiederholung blockiert: ${computer.describe(call.name, call.input)}`, 'skipped');
          return fail('Nicht ausgeführt: Genau diese Aktion wurde gerade mehrmals hintereinander ausgeführt, ohne dass du das Ergebnis geprüft hast. Mach ein Bildschirmfoto, prüfe den Zustand und versuche einen anderen Weg.');
        }
      }

      // --- Berechtigungen ---
      const risk = permissions.classify(call);
      let verdict = permissions.decide(risk, policy, st.grants);
      // Gerade erteilte Erlaubnis (request_permission) deckt die passende Aktion
      if (verdict === 'ask' && risk.level === 'high' && st.grants.recent && st.grants.recent.category === risk.category && st.round - st.grants.recent.round <= 3) {
        verdict = 'allow';
        st.grants.recent = null;
      }
      if (verdict === 'ask-control') {
        send('agent:action', { id, label: 'fragt um Erlaubnis' });
        const allowed = await withTimeout(askControl(id, send), TIMEOUTS.permission, 'Die Frage nach der Erlaubnis').catch(() => false);
        if (signal.aborted) throw abortError();
        st.grants.control = Boolean(allowed);
        task?.step('permission', 'PC-Steuerung', allowed ? 'ok' : 'denied');
        if (!allowed) {
          ctx.computerFailed = true;
          return { ...base, is_error: true, content: 'Der Nutzer hat die PC-Steuerung für diese Aufgabe abgelehnt. Mach ohne Steuerung weiter oder erkläre, wie er es selbst tun kann.' };
        }
        computer?.warmUp();
        verdict = permissions.decide(risk, policy, st.grants);
        if (verdict === 'allow' && risk.level === 'high') verdict = 'ask';
      }
      if (verdict === 'ask' && isComputer && st.grants.control !== true) {
        // Erst die allgemeine Steuerungs-Erlaubnis, dann die hohe
        const allowed = await withTimeout(askControl(id, send), TIMEOUTS.permission, 'Die Frage nach der Erlaubnis').catch(() => false);
        st.grants.control = Boolean(allowed);
        if (!allowed) {
          ctx.computerFailed = true;
          return { ...base, is_error: true, content: 'Der Nutzer hat die PC-Steuerung für diese Aufgabe abgelehnt.' };
        }
        computer?.warmUp();
      }
      if (verdict === 'deny') {
        task?.step('permission', `${risk.label} gesperrt`, 'denied', { risk: risk.level });
        return fail(`Gesperrt: «${risk.label}» (Risiko ${risk.levelLabel}) ist in Buddys Einstellungen nicht erlaubt. Führe das nicht aus und versuche keinen Umweg, sondern sag dem Nutzer, dass er es selbst tun oder in den Einstellungen unter «Berechtigungen» freigeben kann.`, { counts: false });
      }
      if (verdict === 'ask') {
        if (isComputer) endControl();
        const request = {
          level: risk.level,
          levelLabel: risk.levelLabel,
          category: risk.category,
          label: risk.label,
          summary: risk.summary || (call.name === 'request_permission' ? String(call.input.action || '') : permissionLabel(call)),
          details: risk.details || '',
        };
        send('agent:action', { id, label: 'fragt um Erlaubnis' });
        const allowed = await withTimeout(askPermission(id, request, send), TIMEOUTS.permission, 'Die Frage nach der Erlaubnis').catch(() => false);
        if (signal.aborted) throw abortError();
        task?.step('permission', `${request.label}: ${request.summary}`, allowed ? 'ok' : 'denied', { risk: risk.level });
        if (!allowed) {
          if (isComputer) ctx.computerFailed = true;
          return { ...base, is_error: true, content: `Der Nutzer hat das abgelehnt (${request.label}, Risiko ${risk.levelLabel}). Führe es nicht aus und versuche keinen Umweg.` };
        }
        if (risk.level === 'medium') st.grants.medium = true;
        if (call.name === 'request_permission') {
          if (risk.level === 'high') st.grants.recent = { category: risk.category, round: st.round };
          return { ...base, content: `Der Nutzer hat erlaubt: ${request.summary}` };
        }
      } else if (call.name === 'request_permission') {
        return { ...base, content: `Erlaubt (Einstellung «ohne Nachfrage»): ${String(call.input.action || '')}` };
      }

      // --- Ausführen ---
      if (isComputer) {
        startControl();
        send('agent:action', { id, label: computer.describe(call.name, call.input) });
        const isInput = !COMPUTER_READ.has(call.name);
        if (isInput && !st.unverified) st.shotBeforeInput = st.lastShotHash;
        let content;
        for (let attempt = 0; ; attempt += 1) {
          try {
            content = await withTimeout(computer.run(call.name, call.input, signal), TIMEOUTS.computer, 'Die Aktion');
            break;
          } catch (err) {
            if (err?.name === 'AbortError' || signal.aborted) throw abortError();
            // Nur Lese-Aktionen wiederholen (Klicks nie doppelt)
            if (attempt === 0 && COMPUTER_IDEMPOTENT.has(call.name)) {
              log(`Steuerung: ${call.name} wiederholt nach Fehler: ${err.message}`);
              if (err.timeout) computer.stop();
              continue;
            }
            if (err.timeout) computer.stop();
            task?.step('computer', `${computer.describe(call.name, call.input)}: ${err.message}`, 'error');
            return fail(err.message || String(err));
          }
        }
        st.actions += 1;
        if (signal.aborted) throw abortError();
        if (isInput) {
          st.unverified = true;
        } else if (call.name === 'screenshot' || call.name === 'zoom') {
          const img = content.find((c) => c.type === 'image');
          const hash = img ? crypto.createHash('sha1').update(img.source.data).digest('hex') : null;
          if (call.name === 'screenshot') {
            // Hat sich nach den letzten Eingaben sichtbar etwas verändert?
            if (st.unverified && hash && st.shotBeforeInput && hash === st.shotBeforeInput) {
              content = [...content, { type: 'text', text: 'Hinweis von Buddy: Der Bildschirm sieht genau gleich aus wie vor deinen letzten Aktionen. Sie hatten offenbar keine sichtbare Wirkung.' }];
              st.consecutiveErrors += 1;
              task?.step('computer', 'Keine sichtbare Änderung nach der Aktion', 'warn');
            } else if (st.unverified) {
              st.consecutiveErrors = 0;
            }
            st.lastShotHash = hash;
            st.repeat = { sig: '', count: 0 };
          }
          st.unverified = false;
        }
        if (isInput) task?.step('computer', computer.describe(call.name, call.input), 'ok');
        return { ...base, content };
      }

      const isFile = files?.names.has(call.name);
      let output;
      try {
        output = await withTimeout(
          isFile ? files.run(call.name, call.input, signal) : tools.run(call.name, call.input),
          isFile ? TIMEOUTS.files : TIMEOUTS.tool,
          'Das Werkzeug',
        );
      } catch (err) {
        if (err?.name === 'AbortError' || signal.aborted) throw abortError();
        output = { error: true, text: err.message || String(err) };
      }
      const label = isFile ? files.describe(call.name, call.input) : tools.describe(call.name, call.input);
      send('chat:tool', { id, name: call.name, label: output.error ? `${label} · Fehler` : label, error: Boolean(output.error) });
      task?.step(isFile ? 'file' : 'tool', output.error ? `${label}: ${String(output.text).slice(0, 100)}` : label, output.error ? 'error' : 'ok');
      if (output.error) st.consecutiveErrors += 1;
      else {
        st.consecutiveErrors = 0;
        if (SIDE_EFFECT_TOOLS.has(call.name)) st.executed.set(sig, Date.now());
      }
      return { ...base, content: String(output.text ?? ''), ...(output.error ? { is_error: true } : {}) };
    }

    // ---------- Eine Runde mit Claude (mit Wiederholung bei Abbruch im Stream) ----------

    async function callModel({ model, effort, system, toolList, maxTokens, holdText }) {
      let pending = '';
      let emitted = 0;
      let firstInRound = true;
      const onText = (text) => {
        const prefix = firstInRound && st.wroteText ? '\n\n' : '';
        firstInRound = false;
        if (holdText) {
          pending += prefix + text;
          return;
        }
        st.wroteText = true;
        emitted += (prefix + text).length;
        send('chat:delta', { id, text: prefix + text });
      };
      for (;;) {
        try {
          const result = await claude.streamMessage({
            apiKey, workspaceId: settings.workspaceId, model, system, messages: conversation, tools: toolList, maxTokens, effort, signal, onText,
            onRetry: (n, err) => {
              log(`API-Wiederholung ${n} (${err.status || ''} ${err.type || err.message})`);
              send('agent:action', { id, label: `Verbindung, Versuch ${n + 1}` });
              task?.step('retry', `API-Wiederholung ${n}: ${err.message}`, 'warn');
            },
          });
          return { result, pending, flush: () => { if (pending) { st.wroteText = true; send('chat:delta', { id, text: pending }); pending = ''; } } };
        } catch (err) {
          if (err?.name === 'AbortError' || signal.aborted) throw abortError();
          // Abbruch mitten im Stream: Runde einmal neu starten (es wurde noch nichts ausgeführt)
          if (err?.status === 0 && st.streamRetries < MAX_STREAM_RETRIES) {
            st.streamRetries += 1;
            if (emitted) send('chat:rewind', { id, chars: emitted });
            emitted = 0;
            pending = '';
            firstInRound = true;
            task?.step('retry', 'Verbindung unterbrochen, Runde neu gestartet', 'warn');
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw err;
        }
      }
    }

    // ---------- Ablauf ----------

    try {
      send('agent:action', { id, label: 'wählt Modell' });
      decision = await router.route({
        text: userText, messages: conversation, withComputer, tiers, budget, settings, meta, apiKey, signal, task: id,
      });
      task = history.start({ id, title: userText, route: { model: decision.model, effort: decision.effort, reason: decision.reason, source: decision.source } });
      if (decision.routerCost) {
        st.cost += decision.routerCost;
        task.addCost(decision.routerCost, decision.routerUsage || {});
      }
      task.step('route', `${decision.modelName} · ${decision.effort || 'Standard'} · ${decision.reason}`, 'ok', { source: decision.source });

      // Hinweis an das Modell, wenn die Aufgabe mehrstufig ist
      if (decision.needsPlan) {
        const last = conversation[conversation.length - 1];
        const hint = { type: 'text', text: '[Buddy-Router: Das ist eine mehrstufige Aufgabe. Lege zuerst mit update_plan einen Plan an.]' };
        last.content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }, hint] : [...last.content, hint];
      }

      const system = systemPrompt(withComputer) + AGENT_RULES;
      const baseTools = () => {
        const list = [...tools.definitions, ...(files?.definitions || []), ...AGENT_TOOLS];
        if (withComputer) list.push({ type: 'computer_toolset_20260801' });
        return list;
      };
      let toolList = baseTools();

      for (;;) {
        if (signal.aborted) throw abortError();
        budget = usage.budget(limit);
        if (budget.level === 'blocked') {
          endControl();
          task.step('budget', 'Ausgabenlimit erreicht', 'error');
          task.finish('stopped', { error: 'Ausgabenlimit erreicht' });
          send('chat:notice', { id, text: `Ausgabenlimit von $${limit.toFixed(2)} erreicht. Buddy hat die Aufgabe angehalten.` });
          send('chat:done', { id, stopReason: 'budget', usage: summaryUsage() });
          return;
        }

        const maxRounds = st.grants.control ? MAX_COMPUTER_ROUNDS : MAX_TOOL_ROUNDS;
        const lastRound = st.round >= maxRounds;
        const next = pick();
        if (next.model !== st.model) {
          const switched = Boolean(st.model);
          const from = st.model;
          st.model = next.model;
          st.tier = next.tier;
          st.effort = next.effort;
          task.useModel(next.model);
          if (switched) {
            task.step('model', `${models.info(from).short} → ${models.info(next.model).short}${next.why ? ` (${next.why})` : ''}`, 'ok');
            if (!st.notes.some((n) => n.includes('übernimmt'))) st.notes.push(`[Buddy: Ab hier arbeitet ${models.info(next.model).name} weiter${next.why ? ` (${next.why})` : ''}. Aktueller Stand:\n${planText(st.plan)}]`);
          }
          send('agent:route', routeInfo({ switched, why: next.why }));
        } else if (next.effort !== st.effort) {
          st.effort = next.effort;
          send('agent:route', routeInfo());
        }

        const pruned = pruneImages(conversation);
        if (pruned) log(`Kontext: ${pruned} alte Bildschirmfotos entfernt`);

        if (lastRound) {
          st.notes.push('[Buddy: Das Rundenlimit ist erreicht. Rufe keine Werkzeuge mehr auf, sondern fasse den Stand ehrlich zusammen: was erledigt und geprüft ist und was noch offen ist.]');
        }
        // Hinweise aus der letzten Runde an die letzte Nutzer-Nachricht hängen
        if (st.notes.length) {
          const last = conversation[conversation.length - 1];
          const text = { type: 'text', text: st.notes.join('\n\n') };
          last.content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }, text] : [...last.content, text];
          st.notes = [];
        }

        const holdText = st.unverified && withComputer;
        const maxTokens = models.maxTokensFor(st.effort, settings.maxTokens);
        let call;
        try {
          call = await callModel({ model: st.model, effort: st.effort, system, toolList, maxTokens, holdText });
        } catch (err) {
          // Überlastet trotz Wiederholungen: einmal auf ein anderes Modell ausweichen
          if (auto && (err?.status === 529 || err?.type === 'overloaded_error') && !st.overloadFallback) {
            st.overloadFallback = true;
            const alt = ['sonnet', 'haiku', 'opus'].find((t) => tiers[t] && tiers[t] !== st.model && models.tierRank(t) <= models.tierRank(budgetCap(usage.budget(limit))));
            if (alt) {
              task.step('model', `${models.info(st.model).short} überlastet, weiter mit ${models.info(tiers[alt]).short}`, 'warn');
              st.model = tiers[alt];
              st.tier = alt;
              st.effort = models.supportedEffort(st.model, st.effort);
              send('agent:route', routeInfo({ switched: true, why: 'Ausweichmodell wegen Überlastung' }));
              call = await callModel({ model: st.model, effort: st.effort, system, toolList, maxTokens, holdText });
            } else throw err;
          } else throw err;
        }
        const { result } = call;
        if (result.droppedComputer && withComputer) {
          withComputer = false;
          toolList = baseTools();
        }
        const cost = usage.record({ model: st.model, usage: result.usage, purpose: st.inControl || st.grants.control ? 'Steuerung' : 'Antwort', task: id });
        st.cost += cost;
        st.tokens.input += (result.usage.input_tokens || 0) + (result.usage.cache_creation_input_tokens || 0) + (result.usage.cache_read_input_tokens || 0);
        st.tokens.output += result.usage.output_tokens || 0;
        task.addCost(cost, result.usage);
        send('agent:cost', { id, cost: st.cost });

        const calls = result.content.filter((b) => b.type === 'tool_use');
        const wantsTools = result.stopReason === 'tool_use' && calls.length;

        if (!wantsTools || lastRound) {
          // Ergebnis prüfen, bevor Buddy «fertig» sagt
          if (!lastRound && st.guards < MAX_GUARDS && result.stopReason !== 'max_tokens') {
            if (st.unverified && withComputer) {
              st.guards += 1;
              conversation.push({ role: 'assistant', content: result.content });
              conversation.push({ role: 'user', content: [{ type: 'text', text: '[Buddy-Prüfung: Nach deiner letzten Aktion hast du das Ergebnis noch nicht geprüft. Mach ein Bildschirmfoto und prüfe, ob es geklappt hat, bevor du dem Nutzer etwas als erledigt meldest. Hat es nicht geklappt, sag das ehrlich.]' }] });
              task.step('verify', 'Ergebnis noch nicht geprüft, Buddy prüft nach', 'warn');
              send('agent:action', { id, label: 'prüft das Ergebnis' });
              st.round += 1;
              continue;
            }
            let open = (st.plan || []).filter((s) => s.status === 'pending' || s.status === 'in_progress');
            const failed = (st.plan || []).filter((s) => s.status === 'failed');
            // Die Schlussantwort erledigt den letzten laufenden Schritt (z. B. die Zusammenfassung)
            const hasText = result.content.some((b) => b.type === 'text' && b.text.trim());
            if (hasText && open.length === 1 && open[0].status === 'in_progress') {
              open[0].status = 'done';
              send('agent:plan', { id, steps: st.plan });
              open = [];
            }
            if (open.length || (failed.length && st.escalations < MAX_ESCALATIONS && auto)) {
              st.guards += 1;
              call.flush();
              conversation.push({ role: 'assistant', content: result.content });
              let text;
              if (failed.length && !open.length) {
                const e = escalate('Die Aufgabe ist nicht vollständig gelungen.');
                text = e.ok
                  ? '[Buddy-Prüfung: Laut Plan ist mindestens ein Schritt fehlgeschlagen. Versuche ihn mit einem anderen Weg nochmals, oder erkläre ehrlich, warum es nicht geht.]'
                  : null;
              } else {
                text = `[Buddy-Prüfung: Laut Plan sind noch Schritte offen:\n${open.map((s) => `- ${s.title}`).join('\n')}\nMach weiter, oder aktualisiere den Plan und erkläre, warum sie nicht nötig oder nicht möglich sind.]`;
              }
              if (text) {
                const notes = st.notes.splice(0);
                conversation.push({ role: 'user', content: [{ type: 'text', text: [text, ...notes].join('\n\n') }] });
                task.step('verify', open.length ? 'Plan noch nicht fertig, Buddy macht weiter' : 'Fehlgeschlagenen Schritt nochmals versuchen', 'warn');
                st.round += 1;
                continue;
              }
              conversation.pop();
            }
          }
          if (!st.unverified || !withComputer) call.flush();
          else if (call.pending) {
            // Unbestätigte Erfolgsmeldung nicht als Tatsache zeigen
            send('chat:delta', { id, text: `${st.wroteText ? '\n\n' : ''}_(Nicht geprüft)_ ${call.pending.trim()}` });
          }
          endControl();
          const verified = !(st.unverified && withComputer);
          const failedSteps = (st.plan || []).filter((s) => s.status === 'failed').length;
          task.finish(lastRound && wantsTools ? 'limit' : failedSteps ? 'partial' : 'done', { verified });
          if (lastRound && wantsTools) send('chat:notice', { id, text: 'Buddy hat das Rundenlimit erreicht und angehalten.' });
          send('chat:done', { id, stopReason: result.stopReason, usage: summaryUsage(), verified });
          return;
        }

        call.flush();
        conversation.push({ role: 'assistant', content: result.content });
        const ctx = { computerFailed: false, escalated: false, stuck: false };
        const results = [];
        for (const c of calls) {
          results.push(await execute(c, ctx));
          if (signal.aborted) throw abortError();
        }
        conversation.push({ role: 'user', content: results });

        // Automatisch neu bewerten, wenn es hakt
        if (!ctx.escalated) {
          if (st.consecutiveErrors >= ESCALATE_AFTER_ERRORS) escalate('Mehrere Aktionen hintereinander sind fehlgeschlagen.');
          else if (st.invalidCalls >= 2) escalate('Mehrere ungültige Werkzeug-Aufrufe.');
          else if (ctx.stuck) escalate('Dieselbe Aktion wurde ohne Erfolg wiederholt.');
        }
        st.round += 1;
      }
    } catch (err) {
      endControl();
      if (err?.name === 'AbortError') {
        task?.finish('aborted');
        send('chat:done', { id, stopReason: 'aborted', usage: summaryUsage() });
      } else {
        log(`Agent-Fehler: ${err.status || ''} ${err.type || ''} ${err.raw || err.message || err}`);
        if (err?.status === 401 || err?.type === 'authentication_error') onAuthError?.();
        task?.finish('error', { error: err.message });
        send('chat:error', { id, message: err.message || String(err), code: err?.status === 401 ? 'key' : undefined });
      }
    } finally {
      endControl();
    }

    function summaryUsage() {
      return {
        cost: st.cost,
        input_tokens: st.tokens.input,
        output_tokens: st.tokens.output,
        models: task?.task.models.map((m) => models.info(m).short) || [],
        escalations: st.escalations,
      };
    }
  }

  return { run };
}

module.exports = { createAgent, AGENT_TOOLS, AGENT_RULES, validateInput, pruneImages, planText, withTimeout };
