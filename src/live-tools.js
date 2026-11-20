// @ts-check
// Buddy Live: Werkzeuge im Gespräch. Gleiche Werkzeuge und gleiche Freigaben wie im Chat
// (permissions.classify/decide, Freigabe-Karte im Island, nie mündlich bestätigt).
// PC-Steuerung und Befehle laufen NICHT im Gespräch: dafür übergibt Buddy die Aufgabe an den Chat
// (hand_off_to_chat), wo Freigabe pro Aufgabe, Leuchtrand, Stopp und Sperrliste gelten.

const permissions = require('./permissions');
const { validateInput } = require('./agent');

const TOOL_TIMEOUT_MS = 20000;
const MAX_OUTPUT = 6000;

// Eigene Werkzeuge nur für Live
const LIVE_TOOLS = [
  {
    name: 'end_conversation',
    description: 'Beendet das Gespräch. Rufe das auf, sobald sich der Nutzer verabschiedet oder das Gespräch beenden will (z. B. «tschüss», «stopp», «danke Buddy», «bye», «merci», «das wärs»). Sag vorher höchstens zwei, drei Worte.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'hand_off_to_chat',
    description: 'Übergibt eine Aufgabe an den Chat von Buddy und beendet das Gespräch. Nur für Aufgaben, die du hier nicht kannst: den PC mit Maus/Tastatur steuern, Bildschirm ansehen, Befehle (PowerShell) ausführen, Dateien bearbeiten, längere Texte schreiben.',
    input_schema: { type: 'object', properties: { task: { type: 'string', description: 'Die Aufgabe in einem Satz, in der Sprache des Nutzers.' } }, required: ['task'] },
  },
];

/** Anthropic-Format ({ name, description, input_schema }) → Realtime-Funktion */
function toRealtime(def) {
  return { type: 'function', name: def.name, description: String(def.description || '').slice(0, 1000), parameters: def.input_schema || { type: 'object', properties: {} } };
}

function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Zeitlimit')), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ tools: any, getPolicy: () => any, askPermission: (id: string, request: any, send: Function) => Promise<any>, send: Function, log?: Function, t?: (s: string, v?: any) => string }} deps
 */
function createLiveTools({ tools, getPolicy, askPermission, send, log = () => {}, t = (s) => s }) {
  const grants = {}; // gilt für ein Gespräch (wie «für diese Aufgabe erlauben»)
  const defs = () => [...(tools?.definitions || []), ...LIVE_TOOLS];
  const definitions = () => defs().map(toRealtime);

  /**
   * Ein Werkzeug ausführen. Gibt immer Text für das Modell zurück (nie werfen).
   * @param {string} liveId @param {string} name @param {string} argsJson
   * @returns {Promise<{ output: string, action?: 'end'|'handoff', task?: string, label?: string }>}
   */
  async function run(liveId, name, argsJson) {
    let input;
    try { input = argsJson ? JSON.parse(argsJson) : {}; } catch { return { output: 'Ungültiger Aufruf: Die Eingabe war kein gültiges JSON.' }; }
    const def = defs().find((d) => d.name === name);
    if (!def) return { output: `Unbekanntes Werkzeug: ${name}.` };
    const err = validateInput(def, input);
    if (err) return { output: `Ungültiger Aufruf von ${name}: ${err}` };
    if (name === 'end_conversation') return { output: 'Gespräch wird beendet.', action: 'end' };
    if (name === 'hand_off_to_chat') {
      const task = String(input.task || '').trim().slice(0, 1000);
      if (!task) return { output: 'Aufgabe fehlt.' };
      return { output: 'Aufgabe an den Chat übergeben. Sag dem Nutzer kurz, dass Buddy es im Chat erledigt.', action: 'handoff', task };
    }

    const call = { name, input };
    const risk = permissions.classify(call);
    const verdict = permissions.decide(risk, getPolicy() || {}, grants);
    if (verdict === 'deny' || verdict === 'ask-control') {
      log(`Live: ${name} gesperrt (${risk.label})`);
      return { output: `Gesperrt: «${risk.label}» ist in Buddys Einstellungen nicht erlaubt. Sag dem Nutzer, dass er es selbst tun oder unter «Berechtigungen» freigeben kann.` };
    }
    if (verdict === 'ask') {
      const request = { level: risk.level, levelLabel: risk.levelLabel, category: risk.category, label: risk.label, summary: risk.summary || tools.describe?.(name, input) || name, details: risk.details || '' };
      send('live', { kind: 'asking' });
      const allowed = await withTimeout(askPermission(liveId, request, send), 60000).catch(() => false);
      log(`Live: Freigabe ${request.label}: ${allowed ? 'ja' : 'nein'}`);
      if (!allowed) return { output: `Der Nutzer hat das im Island abgelehnt (${request.label}). Führe es nicht aus und versuche keinen Umweg.` };
      if (risk.level === 'medium') grants.medium = true;
    }
    let out;
    try {
      out = await withTimeout(Promise.resolve(tools.run(name, input)), TOOL_TIMEOUT_MS);
    } catch (e) {
      out = { error: true, text: e?.message || String(e) };
    }
    const label = (typeof out?.label === 'string' && out.label) || tools.describe?.(name, input) || name;
    send('live', { kind: 'tool', id: liveId, label: out?.error ? `${label} · ${t('Fehler')}` : label, error: Boolean(out?.error) });
    log(`Live: ${label}${out?.error ? ' (Fehler)' : ''}`);
    return { output: `${out?.error ? 'Fehler: ' : ''}${String(out?.text ?? '').slice(0, MAX_OUTPUT)}`, label };
  }

  return { definitions, run };
}

module.exports = { createLiveTools, LIVE_TOOLS, toRealtime };
