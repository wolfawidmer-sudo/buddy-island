// @ts-check
// Verbindungstest pro Anbieter: prüft die KI-Kommunikation von unten nach oben, damit klar
// wird, wo genau es hakt. Zuerst die einfachste Anfrage («Reply with OK.» ohne Streaming,
// ohne Verlauf, ohne Werkzeuge), dann Schritt für Schritt Streaming, Verlauf, Werkzeuge mit
// Fortsetzung, parallele Werkzeuge und strukturierte Antworten (wie der Router sie braucht).
// Der Bericht enthält keine Keys und keine persönlichen Inhalte.

const { publicError } = require('./errors');
const models = require('../models');
const { t } = require('../i18n');

/** @typedef {import('./types').LlmClient} LlmClient */
/** @typedef {{ id: string, label: string, model?: string, ok: boolean|null, ms?: number, note?: string, error?: ReturnType<typeof publicError> }} HealthStep */

const NUMBER_TOOL = {
  name: 'get_number',
  description: 'Returns a secret number for the given key.',
  input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Any key, e.g. "a".' } }, required: ['key'] },
};

/**
 * @param {{
 *   client: LlmClient, providerId: string, apiKey: string, workspaceId?: string,
 *   models: string[], signal?: AbortSignal, onStep?: (s: HealthStep) => void, stepTimeoutMs?: number,
 * }} opts
 * @returns {Promise<{ providerId: string, ok: boolean, steps: HealthStep[] }>}
 */
async function runHealth({ client, providerId, apiKey, workspaceId, models: modelIds, signal, onStep, stepTimeoutMs = 90000 }) {
  /** @type {HealthStep[]} */
  const steps = [];
  const local = providerId === 'huggingface';
  const main = modelIds[0];

  /**
   * Führt einen Schritt mit eigenem Zeitlimit aus.
   * @param {string} id @param {string} label @param {string|undefined} model @param {(s: AbortSignal) => Promise<string|void>} fn
   */
  async function step(id, label, model, fn) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), local ? Math.max(stepTimeoutMs, 15 * 60 * 1000) : stepTimeoutMs);
    const started = Date.now();
    /** @type {HealthStep} */
    let s;
    try {
      const note = await fn(ctl.signal);
      s = { id, label, model, ok: true, ms: Date.now() - started, note: note || '' };
    } catch (err) {
      const aborted = /** @type {any} */ (err)?.name === 'AbortError';
      s = { id, label, model, ok: false, ms: Date.now() - started, error: aborted && !signal?.aborted ? { ...publicError(err), message: t('Zeitlimit des Tests überschritten.'), category: 'timeout' } : publicError(err) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    steps.push(s);
    onStep?.(s);
    return s.ok;
  }
  /** @param {string} id @param {string} label @param {string} why */
  const skip = (id, label, why) => {
    /** @type {HealthStep} */
    const s = { id, label, ok: null, note: why };
    steps.push(s);
    onStep?.(s);
  };
  const textOf = (/** @type {any} */ r) => (r.content || []).filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.text).join('').trim();
  const base = { apiKey, workspaceId, maxTokens: 256 };

  // 1. Zugangsdaten
  if (!apiKey) {
    skip('key', t('API-Key vorhanden'), t('Kein Key gespeichert.'));
    return { providerId, ok: false, steps };
  }
  if (!main) {
    skip('models', t('Modell gewählt'), t('Kein Modell verfügbar.'));
    return { providerId, ok: false, steps };
  }

  // 2. Modellliste (beweist, dass Key, Endpunkt und Konto stimmen)
  if (!local) {
    await step('models', t('Key und Modellliste'), undefined, async () => {
      const list = await client.listModels(apiKey, workspaceId);
      const ids = new Set(list.map((m) => m.id));
      const missing = modelIds.filter((m) => !ids.has(m));
      if (missing.length && list.length) return t('{n} Modelle verfügbar; nicht in der Liste: {m}', { n: list.length, m: missing.join(', ') });
      return t('{n} Modelle verfügbar', { n: list.length });
    });
  }

  // 3. Einfachste Anfrage, für jedes benutzte Modell einzeln
  let basicOk = false;
  for (const model of modelIds) {
    const ok = await step(`basic:${model}`, t('Einfache Antwort ohne Streaming'), model, async (s) => {
      const r = await client.streamMessage({ ...base, model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, signal: s });
      const text = textOf(r);
      if (!text) throw Object.assign(new Error(t('Leere Antwort (Grund: {r}).', { r: r.stopReason || '?' })), { name: 'EmptyAnswer' });
      return `«${text.slice(0, 40)}»`;
    });
    if (ok && model === main) basicOk = true;
  }
  const later = [
    ['stream', t('Antwort mit Streaming')], ['history', t('Unterhaltung mit Verlauf')],
    ['tools', t('Werkzeug-Aufruf mit Fortsetzung')], ['parallel', t('Parallele Werkzeug-Aufrufe')], ['json', t('Strukturierte Antwort (Router)')],
  ];
  if (!basicOk) {
    for (const [id, label] of later) skip(id, label, t('Übersprungen, weil schon die einfache Antwort nicht klappt.'));
    return { providerId, ok: false, steps };
  }

  // 4. Streaming
  await step('stream', t('Antwort mit Streaming'), main, async (s) => {
    let streamed = '';
    const r = await client.streamMessage({ ...base, model: main, messages: [{ role: 'user', content: 'Reply with OK.' }], signal: s, onText: (x) => { streamed += x; } });
    if (!textOf(r)) throw new Error(t('Leere Antwort (Grund: {r}).', { r: r.stopReason || '?' }));
    if (!streamed) return t('Antwort kam an, aber nicht stückweise.');
    return '';
  });

  // 5. Verlauf
  await step('history', t('Unterhaltung mit Verlauf'), main, async (s) => {
    const r = await client.streamMessage({
      ...base, model: main, stream: false, signal: s,
      system: 'You are a test assistant. Answer with a single word.',
      messages: [
        { role: 'user', content: 'Remember the codeword APFEL.' },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'What is the codeword? Reply with the codeword only.' },
      ],
    });
    const text = textOf(r);
    if (!text) throw new Error(t('Leere Antwort (Grund: {r}).', { r: r.stopReason || '?' }));
    return /apfel/i.test(text) ? '' : t('Antwort ohne Codewort: «{x}»', { x: text.slice(0, 40) });
  });

  // 6./7. Werkzeuge (nur wo das Modell sie kann)
  const caps = models.capabilities(main);
  if (!caps.tools) {
    skip('tools', t('Werkzeug-Aufruf mit Fortsetzung'), t('Dieses Modell hat keine Werkzeuge (nur Chat).'));
    skip('parallel', t('Parallele Werkzeug-Aufrufe'), t('Dieses Modell hat keine Werkzeuge (nur Chat).'));
  } else {
    await step('tools', t('Werkzeug-Aufruf mit Fortsetzung'), main, async (s) => {
      /** @type {any[]} */
      const conv = [{ role: 'user', content: 'Call get_number with key "a". Then reply with the number only.' }];
      const r1 = await client.streamMessage({ ...base, model: main, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: s });
      const calls = r1.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) return t('Modell hat das Werkzeug nicht benutzt (antwortete direkt).');
      conv.push({ role: 'assistant', content: r1.content });
      conv.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: /** @type {any} */ (c).id, content: '4711' })) });
      // Die Fortsetzung prüft Anbieter-Metadaten (z. B. Gemini thought_signature, OpenAI tool_call_id)
      const r2 = await client.streamMessage({ ...base, model: main, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: s });
      const text = textOf(r2);
      if (!text && !r2.content.some((b) => b.type === 'tool_use')) throw new Error(t('Leere Antwort nach dem Werkzeug (Grund: {r}).', { r: r2.stopReason || '?' }));
      return /4711/.test(text) ? '' : t('Fortsetzung ok, aber ohne die Zahl: «{x}»', { x: text.slice(0, 40) });
    });
    await step('parallel', t('Parallele Werkzeug-Aufrufe'), main, async (s) => {
      /** @type {any[]} */
      const conv = [{ role: 'user', content: 'Call get_number twice in parallel, once with key "a" and once with key "b". Then reply with both numbers.' }];
      const r1 = await client.streamMessage({ ...base, model: main, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: s });
      const calls = r1.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) return t('Modell hat das Werkzeug nicht benutzt.');
      conv.push({ role: 'assistant', content: r1.content });
      conv.push({ role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: /** @type {any} */ (c).id, content: i ? '22' : '11' })) });
      const r2 = await client.streamMessage({ ...base, model: main, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: s });
      if (!textOf(r2) && !r2.content.some((b) => b.type === 'tool_use')) throw new Error(t('Leere Antwort nach dem Werkzeug (Grund: {r}).', { r: r2.stopReason || '?' }));
      return calls.length > 1 ? t('{n} Aufrufe auf einmal', { n: calls.length }) : t('Modell rief nacheinander auf (auch in Ordnung).');
    });
  }

  // 8. Strukturierte Antwort, wie der Router sie braucht (nicht beim lokalen Modell)
  if (local) {
    skip('json', t('Strukturierte Antwort (Router)'), t('Lokal wählt Buddy ohne Router.'));
  } else {
    const router = modelIds[modelIds.length - 1] || main;
    await step('json', t('Strukturierte Antwort (Router)'), router, async (s) => {
      const r = await client.json({
        apiKey, workspaceId, model: router, signal: s, maxTokens: 200, effort: 'low',
        system: 'Return JSON only.', prompt: 'Return {"ok": true}.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      });
      if (!r.data || typeof r.data.ok !== 'boolean') throw new Error(t('Kein gültiges JSON: «{x}»', { x: String(r.raw || '').slice(0, 60) }));
      return '';
    });
  }

  return { providerId, ok: steps.every((s) => s.ok !== false), steps };
}

/**
 * Kopierbarer Bericht ohne Keys und ohne Inhalte.
 * @param {{ providerId: string, providerName?: string, ok: boolean, steps: HealthStep[] }[]} results
 * @param {{ version?: string, os?: string, language?: string }} [env]
 */
function healthReport(results, env = {}) {
  const lines = [`Buddy Island ${env.version || ''} · ${env.os || ''} · ${env.language || ''} · ${new Date().toISOString()}`];
  for (const r of results) {
    lines.push('', `## ${r.providerName || r.providerId}: ${r.ok ? 'OK' : 'FEHLER'}`);
    for (const s of r.steps) {
      const mark = s.ok === true ? '✓' : s.ok === false ? '✗' : '–';
      lines.push(`${mark} ${s.label}${s.model ? ` [${s.model}]` : ''}${s.ms ? ` ${s.ms} ms` : ''}${s.note ? ` · ${s.note}` : ''}`);
      if (s.error) {
        const e = s.error;
        lines.push(`    ${e.message}`);
        lines.push(`    ${[e.provider, e.model, e.status ? `HTTP ${e.status}` : '', e.code, e.category, e.stage, e.origin, e.endpoint].filter(Boolean).join(' | ')}`);
        if (e.providerMessage) lines.push(`    Anbieter: ${e.providerMessage}`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = { runHealth, healthReport, NUMBER_TOOL };
