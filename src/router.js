// Modell-Router: bewertet jede Anfrage und wählt das günstigste geeignete
// Modell und den passenden Denkaufwand. Einfache Fälle entscheidet eine Regel
// ohne API-Aufruf, alles andere Claude Haiku als Dispatcher.

const models = require('./models');
const { t, language, LANGS } = require('./i18n');

const CACHE_MS = 10 * 60 * 1000;
// Länger wartet Buddy nicht auf den Dispatcher; danach entscheidet die Regel (die Antwort soll nicht warten)
const DISPATCH_TIMEOUT_MS = 6000;
const CACHE_MAX = 60;

// Antwortformat des Dispatchers (strukturierte Ausgabe)
const SCHEMA = {
  type: 'object',
  properties: {
    komplexitaet: { type: 'string', enum: ['einfach', 'mittel', 'hoch', 'sehr_hoch'] },
    reasoning: { type: 'string', enum: ['niedrig', 'mittel', 'hoch'] },
    schritte: { type: 'integer' },
    faehigkeiten: {
      type: 'array',
      items: { type: 'string', enum: ['gespraech', 'wissen', 'werkzeuge', 'pc_steuerung', 'dateien', 'programmieren', 'fehlersuche', 'planung', 'kreativ', 'rechnen'] },
    },
    risiko: { type: 'string', enum: ['niedrig', 'mittel', 'hoch'] },
    risiken: { type: 'array', items: { type: 'string' } },
    tokens: { type: 'integer' },
    modell: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
    aufwand: { type: 'string', enum: ['low', 'medium', 'high'] },
    begruendung: { type: 'string' },
  },
  required: ['komplexitaet', 'reasoning', 'schritte', 'faehigkeiten', 'risiko', 'risiken', 'tokens', 'modell', 'aufwand', 'begruendung'],
  additionalProperties: false,
};

const DISPATCH_SYSTEM = `Du bist der Dispatcher von Buddy Island, einem KI-Assistenten auf einem Windows-PC. Du beantwortest die Anfrage NICHT, du bewertest sie nur.

Buddy kann: Fragen beantworten und plaudern, Timer stellen, Apps, Websites und Windows-Einstellungsseiten öffnen, Musik und Lautstärke steuern, Kalender und Mitteilungen lesen, Systeminfos anzeigen, Dateien in den Benutzerordnern auflisten, Duplikate finden, Ordner anlegen, Dateien verschieben und in den Papierkorb legen, und den PC mit Maus und Tastatur steuern (mit Bildschirmfotos).

Modelle:
- haiku: günstig und schnell. Fragen, Gespräche, Programme öffnen, einfache Windows-Befehle, einfache Dateioperationen, kurze Texte.
- sonnet: mehrstufige Windows-Automatisierung, komplexe Dateiorganisation, Fehlerdiagnose, Programmieraufgaben, komplexe Bedienung von Anwendungen.
- opus: teuer. Nur für besonders schwierige technische Probleme, umfangreiche Planung, anspruchsvolles Debugging oder sehr hohen Reasoning-Bedarf.

Wähle immer das günstigste Modell, das die Aufgabe zuverlässig schafft. aufwand: low für einfache, medium für normale, high für komplexe Aufgaben.
schritte = ungefähre Anzahl Arbeitsschritte (1 bei einer reinen Antwort). tokens = geschätzte Länge der Antwort in Tokens.
risiken: kurze Stichworte (z. B. «Dateien löschen»), leer wenn keine. begruendung: höchstens 8 Wörter auf Deutsch.`;

// Die Begründung erscheint in der Oberfläche, darum in deren Sprache
function dispatchSystem() {
  const lang = language();
  if (lang === 'de') return DISPATCH_SYSTEM;
  const name = { en: 'English', fr: 'French' }[lang] || LANGS[lang]?.name || 'English';
  return DISPATCH_SYSTEM.replace('höchstens 8 Wörter auf Deutsch.', `höchstens 8 Wörter auf ${name} (in English: at most 8 words in ${name}).`);
}

// Eindeutig einfache Anfragen ohne API-Aufruf erkennen
const SIMPLE_RULES = [
  { test: /^(hallo|hoi|hey|hi|salü|sali|grüezi|guten (morgen|tag|abend)|gute nacht|danke( dir| schön| vielmal)?|merci( vielmal)?|ok(ay)?|super|cool|perfekt|tschüss|ciao|bis später)[\s!.,?]*$/i, reason: 'Kurzes Gespräch', caps: ['gespraech'] },
  // Begrüssung plus Smalltalk («Hallo! Wie geht es dir heute?», «na, alles gut?», «how are you?»)
  { test: /^((hallo|hoi|hey|hi|hello|salü|sali|grüezi|grüss dich|servus|moin|yo|bonjour|salut|guten (morgen|tag|abend))\s*(buddy)?[\s!.,]*)?(na[\s,]*)?(wie geht'?s|wie geht es (dir|ihnen|euch)|wie läuft'?s|wie war dein tag|alles (gut|klar|fit|easy|okay|ok)|was geht( ab)?|was machst du( so| gerade)?|wer bist du|was kannst du|how are you( doing)?|how'?s it going|what'?s up|ça va|comment (ça va|vas-tu|allez-vous))(\s+(dir|denn|so|heute|bei dir|today|so far))*[\s!.,?]*$/i, reason: 'Kurzes Gespräch', caps: ['gespraech'] },
  { test: /\b(timer|wecker|countdown|erinner mich in)\b/i, reason: 'Timer stellen', caps: ['werkzeuge'] },
  { test: /\b(pausier\w*|musik (an|aus|weiter)|nächste[sn]? (lied|song|titel)|vorherige[sn]? (lied|song|titel)|lauter|leiser|stumm|was läuft (gerade)?)\b/i, reason: 'Musik steuern', caps: ['werkzeuge'] },
  { test: /^(bitte )?(öffne|starte|mach)\s+(mir\s+)?(den |die |das )?[\wäöü.-]+( auf| an)?( bitte)?[\s!.]*$/i, reason: 'Programm öffnen', caps: ['werkzeuge'] },
  { test: /\b(wie spät|wieviel uhr|wie viel uhr|welcher tag ist|welches datum)\b/i, reason: 'Uhrzeit oder Datum', caps: ['wissen'] },
  { test: /\b(was steht (heute|morgen)? ?an|meine termine|nächster termin|kalender)\b/i, reason: 'Kalender lesen', caps: ['werkzeuge'] },
  { test: /\b(was hab(e)? ich verpasst|neue mitteilungen|meine mitteilungen)\b/i, reason: 'Mitteilungen lesen', caps: ['werkzeuge'] },
  { test: /\b(usage|nutzung|limits?|kontingent|verbrauch\w*|tokens?|ai-agents?|ki-agents?|agents?|codex|chatgpt|grok|claude code)\b/i, reason: 'KI-Nutzung abfragen', caps: ['werkzeuge'] },
];

// Hinweise auf anspruchsvollere Aufgaben: dann immer den Dispatcher fragen
const COMPLEX_HINT = /\b(und (dann|danach|anschliessend)|danach|anschliessend|debug\w*|fehler\w*|bug|programm\w*|code|skript|script|funktion|python|javascript|typescript|html|css|sql|formel|analysier\w*|vergleich\w*|plan\w*|organisier\w*|sortier\w*|aufräum\w*|doppelt\w*|duplikat\w*|ordner|dateien|zusammenfass\w*|recherch\w*|erklär\w*|warum|berechne\w*|optimier\w*|installier\w*|einstellung\w*|konfigur\w*|steuer\w*|klick\w*|bildschirm|schreib\w*)\b/i;

// Kurze Fortsetzungen («ja», «mach weiter») bleiben beim bisherigen Modell
const FOLLOW_UP = /^(ja|jo|jep|ok(ay)?|gerne?|bitte|mach (weiter|das|es)|weiter|nochmal|noch einmal|los|go|passt|genau|richtig|nein|stopp?)\b[\s\w!.,]{0,30}$/i;

const STEP_TIER = { simple: 'haiku', normal: 'sonnet', hard: 'opus' };
const STEP_EFFORT = { simple: 'low', normal: 'medium', hard: 'high' };
const EFFORT_BY_COMPLEXITY = { einfach: 'low', mittel: 'medium', hoch: 'high', sehr_hoch: 'high' };

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function approxTokens(messages) {
  let chars = 0;
  for (const m of messages || []) chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
  return Math.round(chars / 3.5);
}

// Grobe Kostenschätzung für die ganze Aufgabe (mit Prompt-Caching)
function estimateCost(modelId, { steps = 1, tokens = 400, withComputer = false, contextTokens = 0 }) {
  const rounds = Math.max(1, Math.min(30, steps));
  const base = 2200 + (withComputer ? 4600 : 0) + contextTokens;
  const perRound = withComputer ? 1500 : 500;
  return models.costOf(modelId, {
    input_tokens: 300 * rounds,
    cache_creation_input_tokens: base + perRound * (rounds - 1),
    cache_read_input_tokens: base * (rounds - 1) + (perRound * (rounds - 1) * rounds) / 2,
    output_tokens: tokens + 150 * (rounds - 1),
  });
}

// Höchste erlaubte Stufe nach Budget
function budgetCap(budget) {
  if (!budget) return 'opus';
  if (budget.level === 'tight') return 'haiku';
  if (budget.level === 'warn') return 'sonnet';
  return 'opus';
}

// Nächstbeste verfügbare Stufe (erst nach unten, dann nach oben suchen)
function availableTier(tier, tiers) {
  if (tiers[tier]) return tier;
  const i = models.TIERS.indexOf(tier);
  for (let d = 1; d < models.TIERS.length; d += 1) {
    const down = models.TIERS[i - d];
    if (down && tiers[down]) return down;
    const up = models.TIERS[i + d];
    if (up && tiers[up]) return up;
  }
  return null;
}

// Regeln, damit das Ergebnis immer «günstigstes geeignetes Modell» ist
function policy(a) {
  const caps = new Set(a.faehigkeiten || []);
  let min = 'haiku';
  if (caps.has('programmieren') || caps.has('fehlersuche')) min = 'sonnet';
  if ((caps.has('pc_steuerung') || caps.has('dateien') || caps.has('planung')) && a.schritte >= 3) min = 'sonnet';
  if (a.komplexitaet === 'hoch') min = models.maxTier(min, 'sonnet');
  if (a.komplexitaet === 'sehr_hoch') min = 'opus';

  let tier = models.TIERS.includes(a.modell) ? a.modell : 'sonnet';
  if (a.komplexitaet === 'einfach' && min === 'haiku') tier = 'haiku';
  tier = models.maxTier(tier, min);
  // Opus nur, wenn es wirklich nötig ist
  const allowOpus = a.komplexitaet === 'sehr_hoch' || (a.komplexitaet === 'hoch' && a.reasoning === 'hoch');
  if (tier === 'opus' && !allowOpus) tier = 'sonnet';
  return { tier, allowOpus };
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function createRouter({ claude, usage, log = () => {} }) {
  const cache = new Map();

  function cached(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) return hit.analysis;
    cache.delete(key);
    return null;
  }

  function remember(key, analysis) {
    cache.set(key, { time: Date.now(), analysis });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function quickRule(text) {
    const q = String(text || '').trim();
    if (!q || q.length > 140 || COMPLEX_HINT.test(q)) return null;
    const rule = SIMPLE_RULES.find((r) => r.test.test(q));
    if (!rule) return null;
    return {
      komplexitaet: 'einfach', reasoning: 'niedrig', schritte: rule.caps.includes('werkzeuge') ? 2 : 1,
      faehigkeiten: rule.caps, risiko: 'niedrig', risiken: [], tokens: 150, modell: 'haiku', aufwand: 'low', begruendung: t(rule.reason),
    };
  }

  function contextFor(messages) {
    const recent = (messages || []).slice(-5, -1).map((m) => {
      const text = typeof m.content === 'string' ? m.content : '';
      return `${m.role === 'user' ? 'Nutzer' : 'Buddy'}: ${text.replace(/\s+/g, ' ').slice(0, 280)}`;
    });
    return recent.length ? `Bisheriger Verlauf (gekürzt):\n${recent.join('\n')}\n\n` : '';
  }

  async function askDispatcher({ text, messages, withComputer, apiKey, workspaceId, haiku, signal, task, client }) {
    const prompt = `${contextFor(messages)}PC-Steuerung ist ${withComputer ? 'erlaubt' : 'ausgeschaltet'}.\n\nNeue Anfrage: «${String(text).slice(0, 3000)}»`;
    const local = new AbortController();
    const onAbort = () => local.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; local.abort(); }, DISPATCH_TIMEOUT_MS);
    let result;
    try {
      result = await (client || claude).json({ apiKey, workspaceId, model: haiku, system: dispatchSystem(), prompt, schema: SCHEMA, maxTokens: 700, effort: 'low', signal: local.signal });
    } catch (err) {
      if (timedOut && !signal?.aborted) throw Object.assign(new Error(`Dispatcher langsamer als ${DISPATCH_TIMEOUT_MS / 1000} s`), { status: 0 });
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    const cost = usage ? usage.record({ model: haiku, usage: result.usage, purpose: 'Router', task }) : 0;
    const a = result.data;
    if (!a || typeof a !== 'object' || !a.komplexitaet) throw new Error('Router-Antwort unlesbar');
    return { analysis: a, cost, usage: result.usage };
  }

  // Hauptfunktion. Gibt eine Entscheidung zurück, die der Agent ausführt.
  async function route({ text, messages = [], withComputer = false, tiers, budget, settings = {}, meta = {}, apiKey, signal, task, client, providerId = 'anthropic' }) {
    const manualEffort = settings.effort && settings.effort !== 'auto' ? settings.effort : null;
    const contextTokens = approxTokens(messages);

    // Lokales Hugging-Face-Modell: es gibt nur dieses eine, kein Router-Aufruf
    if (providerId === 'huggingface') {
      const model = tiers.sonnet || settings.model;
      return decision({
        source: 'lokal', tier: 'sonnet', model, effort: null, reason: t('Lokales Modell (Hugging Face)'), analysis: null,
        allowOpus: false, needsPlan: false, estimate: 0, routerCost: 0,
      });
    }
    const auto = settings.autoModel !== false;

    // Manuell: genau das gewählte Modell (falls es zum Anbieter passt)
    if (!auto) {
      const model = (settings.model && models.providerOf(settings.model) === providerId ? settings.model : null) || tiers.sonnet || models.CATALOG[1].id;
      const effort = models.supportedEffort(model, manualEffort) || null;
      return decision({
        source: 'manuell', tier: models.tierOf(model), model, effort,
        reason: t('Manuell gewählt'), analysis: null, allowOpus: true, needsPlan: false,
        estimate: estimateCost(model, { steps: 2, withComputer, contextTokens }), routerCost: 0,
      });
    }

    let analysis = null;
    let source = 'regel';
    let routerCost = 0;
    let routerUsage = null;
    const key = normalize(text);

    // Fortsetzung: bisherige Stufe behalten, kein Router-Aufruf
    if (meta.lastTier && FOLLOW_UP.test(String(text || '').trim()) && models.TIERS.includes(meta.lastTier)) {
      analysis = {
        komplexitaet: meta.lastTier === 'haiku' ? 'einfach' : 'mittel', reasoning: 'mittel', schritte: 3, faehigkeiten: ['werkzeuge'],
        risiko: 'niedrig', risiken: [], tokens: 400, modell: meta.lastTier, aufwand: meta.lastTier === 'haiku' ? 'low' : 'medium', begruendung: t('Fortsetzung der letzten Aufgabe'),
      };
      source = 'regel';
    }
    if (!analysis) analysis = quickRule(text);
    if (!analysis && key.length >= 25) {
      const hit = cached(key);
      if (hit) { analysis = hit; source = 'cache'; }
    }
    if (!analysis) {
      const haiku = tiers.haiku;
      if (haiku && budget?.level !== 'blocked') {
        try {
          const r = await askDispatcher({ text, messages, withComputer, apiKey, workspaceId: settings.workspaceId, haiku, signal, task, client });
          analysis = r.analysis;
          routerCost = r.cost;
          routerUsage = r.usage;
          source = 'haiku';
          if (key.length >= 25) remember(key, analysis);
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          if (err?.status === 401) throw err;
          log(`Router: Dispatcher nicht erreichbar (${err.status || ''} ${err.message}), nehme Regel`);
        }
      }
    }
    if (!analysis) {
      // Ohne Dispatcher: vorsichtig mittel
      const complex = COMPLEX_HINT.test(String(text || ''));
      analysis = {
        komplexitaet: complex ? 'mittel' : 'einfach', reasoning: 'mittel', schritte: complex ? 3 : 1, faehigkeiten: complex ? ['werkzeuge'] : ['gespraech'],
        risiko: 'niedrig', risiken: [], tokens: 500, modell: complex ? 'sonnet' : 'haiku', aufwand: complex ? 'medium' : 'low', begruendung: t('Standardwahl (Router nicht erreichbar)'),
      };
      source = 'standard';
    }

    analysis.schritte = clampInt(analysis.schritte, 1, 50, 1);
    analysis.tokens = clampInt(analysis.tokens, 50, 32000, 500);
    analysis.faehigkeiten = Array.isArray(analysis.faehigkeiten) ? analysis.faehigkeiten.slice(0, 8) : [];
    analysis.risiken = Array.isArray(analysis.risiken) ? analysis.risiken.slice(0, 6).map((r) => String(r).slice(0, 60)) : [];

    let { tier, allowOpus } = policy(analysis);
    let capped = null;
    const cap = budgetCap(budget);
    if (models.tierRank(tier) > models.tierRank(cap)) {
      tier = cap;
      capped = 'budget';
    }
    tier = availableTier(tier, tiers) || 'sonnet';
    const model = tiers[tier] || tiers.sonnet || settings.model;

    let effort = manualEffort || analysis.aufwand || EFFORT_BY_COMPLEXITY[analysis.komplexitaet] || 'medium';
    if (!manualEffort) {
      if (analysis.komplexitaet === 'einfach') effort = 'low';
      if (analysis.komplexitaet === 'sehr_hoch' && effort === 'low') effort = 'medium';
    }
    effort = models.supportedEffort(model, effort);

    const caps = new Set(analysis.faehigkeiten);
    const needsPlan = analysis.schritte >= 3 && (caps.has('pc_steuerung') || caps.has('dateien') || caps.has('planung') || caps.has('werkzeuge') || caps.has('programmieren'));
    let reason = String(analysis.begruendung || '').replace(/\s+/g, ' ').trim().slice(0, 80) || t('Automatisch gewählt');
    if (capped) reason += ' · ' + t('Budget fast aufgebraucht');

    return decision({
      source, tier, model, effort, reason, analysis, allowOpus, needsPlan, capped,
      estimate: estimateCost(model, { steps: analysis.schritte, tokens: analysis.tokens, withComputer: withComputer && caps.has('pc_steuerung'), contextTokens }) + routerCost,
      routerCost, routerUsage,
    });
  }

  function decision(d) {
    return { ...d, modelName: models.info(d.model).short };
  }

  return { route };
}

// Welche Stufe ein Planschritt braucht (begrenzt durch die Entscheidung und das Budget)
function tierForStep(difficulty, { decision, budget, tiers }) {
  let tier = STEP_TIER[difficulty] || decision.tier;
  const ceiling = decision.allowOpus ? 'opus' : models.maxTier(decision.tier, 'sonnet');
  tier = models.minTier(tier, ceiling);
  tier = models.minTier(tier, budgetCap(budget));
  return availableTier(tier, tiers) || decision.tier;
}

module.exports = { createRouter, tierForStep, budgetCap, availableTier, estimateCost, policy, STEP_TIER, STEP_EFFORT, SCHEMA, SIMPLE_RULES, DISPATCH_TIMEOUT_MS };
