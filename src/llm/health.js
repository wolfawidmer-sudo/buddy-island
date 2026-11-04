// @ts-check
// Verbindungstest pro Anbieter: prüft die KI-Kommunikation Schritt für Schritt, damit klar
// wird, wo genau es hakt. Jeder Schritt läuft unabhängig: Schlägt die einfache Antwort fehl,
// werden Streaming, Verlauf, Werkzeuge und Router trotzdem geprüft.
//
// Jeder Schritt bekommt einen Status:
//   ok          Funktioniert
//   limited     Eingeschränkt (Antwort kam, aber nicht ganz wie erwartet)
//   unavailable Temporär nicht verfügbar (Überlastung, Rate-Limit, Serverfehler, Netz)
//   unsupported Nicht unterstützt (dieses Modell kann das nicht, das ist kein Defekt)
//   config      Konfigurationsfehler (Key, Konto, Berechtigung, Modellwahl)
//   error       Fehler in der Integration (Format, Fortsetzung, Antwort unlesbar)
//   skipped     Nicht geprüft (z. B. ohne Key)
//
// Ist das Hauptmodell gerade überlastet, prüft der Test die übrigen Funktionen mit einem
// Modell, das in diesem Durchlauf funktioniert hat. So trennt er «Google ist überlastet» von
// «Buddy macht etwas falsch». Der Bericht enthält keine Keys und keine persönlichen Inhalte.

const { publicError, testStatusOf } = require('./errors');
const models = require('../models');
const { t } = require('../i18n');

/** @typedef {import('./types').LlmClient} LlmClient */
/** @typedef {'ok'|'limited'|'unavailable'|'unsupported'|'config'|'error'|'skipped'} StepStatus */
/** @typedef {'ok'|'limited'|'unavailable'|'unsupported'|'config'|'error'} ProviderStatus */
/**
 * @typedef {{
 *   provider: string, model: string, apiVersion: string, requestType: string, ms: number,
 *   httpStatus: number, errorType: string, retries: number, fallbackModel: string, ok: boolean,
 * }} StepDiag
 * @typedef {{
 *   id: string, label: string, model?: string, ok: boolean|null, status: StepStatus, ms?: number, note?: string,
 *   error?: ReturnType<typeof publicError>, fallbackModel?: string, diag?: StepDiag, temporary?: boolean,
 * }} HealthStep
 */

const NUMBER_TOOL = {
  name: 'get_number',
  description: 'Returns a secret number for the given key.',
  input_schema: { type: 'object', properties: { key: { type: 'string', description: 'Any key, e.g. "a".' } }, required: ['key'] },
};

// Im Test nicht lange auf ein überlastetes Modell warten: eine Wiederholung reicht für die Diagnose
const TEST_RETRIES = 1;

const STATUS_LABEL = {
  ok: 'Funktioniert', limited: 'Eingeschränkt', unavailable: 'Temporär nicht verfügbar', unsupported: 'Nicht unterstützt',
  config: 'Konfigurationsfehler', error: 'Fehler in der Integration', skipped: 'Nicht geprüft',
};
/** @param {string} status */
const statusLabel = (status) => t(STATUS_LABEL[/** @type {keyof typeof STATUS_LABEL} */ (status)] || status);

/** «v1beta» aus https://…/v1beta @param {string} providerId */
function apiVersionOf(providerId) {
  const p = models.PROVIDERS[/** @type {import('./types').ProviderId} */ (providerId)];
  if (!p) return '';
  if (p.kind === 'anthropic') return 'v1';
  if (p.kind === 'huggingface') return 'lokal';
  return (String(p.baseUrl).match(/\/(v\d+[a-z0-9]*)\/?$/i) || [])[1] || '';
}

/**
 * Gesamtstatus eines Anbieters aus seinen Schritten.
 * @param {HealthStep[]} steps
 * @returns {ProviderStatus}
 */
function overallStatus(steps) {
  const real = steps.filter((s) => s.status !== 'skipped' && s.status !== 'unsupported');
  if (steps.some((s) => s.status === 'config')) return 'config';
  if (!real.length) return steps.some((s) => s.status === 'unsupported') ? 'unsupported' : 'config';
  const good = real.filter((s) => s.status === 'ok' || s.status === 'limited');
  if (good.length === real.length) return real.every((s) => s.status === 'ok') ? 'ok' : 'limited';
  if (!good.length) return real.some((s) => s.status === 'error') ? 'error' : 'unavailable';
  return 'limited';
}

/**
 * @param {{
 *   client: LlmClient, providerId: string, apiKey: string, workspaceId?: string,
 *   models: string[], signal?: AbortSignal, onStep?: (s: HealthStep) => void, stepTimeoutMs?: number,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ providerId: string, ok: boolean, status: ProviderStatus, warnings: number, steps: HealthStep[] }>}
 */
async function runHealth({ client, providerId, apiKey, workspaceId, models: modelIds, signal, onStep, stepTimeoutMs = 90000, log }) {
  /** @type {HealthStep[]} */
  const steps = [];
  const local = providerId === 'huggingface';
  const main = modelIds[0];
  const apiVersion = apiVersionOf(providerId);

  /** @param {HealthStep} s */
  const record = (s) => {
    steps.push(s);
    onStep?.(s);
    if (s.diag && log) {
      const d = s.diag;
      // Diagnosezeile ohne Keys und ohne Inhalte
      log(`Verbindungstest provider=${d.provider} model=${d.model || '-'} api=${d.apiVersion || '-'} typ=${d.requestType} dauer=${d.ms}ms http=${d.httpStatus || '-'} fehler=${d.errorType || '-'} retries=${d.retries} ausweich=${d.fallbackModel || '-'} status=${s.status} erfolg=${d.ok}`);
    }
  };

  /**
   * Führt einen Schritt mit eigenem Zeitlimit aus. `fn` gibt eine Notiz zurück oder
   * { note, status: 'limited'|'unsupported' } für eingeschränkte Ergebnisse.
   * @param {string} id @param {string} label @param {string|undefined} model @param {string} requestType
   * @param {(s: AbortSignal, ctx: { onRetry: () => void, maxRetries: number }) => Promise<string|void|{ note?: string, status?: StepStatus }>} fn
   * @param {{ fallbackModel?: string, note?: string }} [extra]
   * @returns {Promise<HealthStep>}
   */
  async function attempt(id, label, model, requestType, fn, extra = {}) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), local ? Math.max(stepTimeoutMs, 15 * 60 * 1000) : stepTimeoutMs);
    const started = Date.now();
    let retries = 0;
    /** @type {HealthStep} */
    let s;
    try {
      const out = await fn(ctl.signal, { onRetry: () => { retries += 1; }, maxRetries: TEST_RETRIES });
      const res = typeof out === 'object' && out ? out : { note: out || '' };
      const status = res.status || 'ok';
      s = { id, label, model, ok: status === 'unsupported' ? null : true, status, ms: Date.now() - started, note: [extra.note, res.note].filter(Boolean).join(' · ') };
    } catch (err) {
      const aborted = /** @type {any} */ (err)?.name === 'AbortError';
      const error = aborted && !signal?.aborted
        ? { ...publicError(err), message: t('Zeitlimit des Tests überschritten.'), category: /** @type {const} */ ('timeout'), transient: true }
        : publicError(err);
      const status = /** @type {StepStatus} */ (/** @type {any} */ (err)?.name === 'EmptyAnswer' ? 'error' : testStatusOf(error));
      retries = Math.max(retries, error.retries || 0);
      s = { id, label, model, ok: status === 'unsupported' ? null : false, status, ms: Date.now() - started, error, note: extra.note || '' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (extra.fallbackModel) s.fallbackModel = extra.fallbackModel;
    if (s.status === 'unavailable') s.temporary = true;
    s.diag = {
      provider: providerId, model: model || '', apiVersion, requestType, ms: s.ms || 0,
      httpStatus: s.error?.status || 0, errorType: s.error ? `${s.error.category}${s.error.code ? `/${s.error.code}` : ''}` : '',
      retries, fallbackModel: extra.fallbackModel || '', ok: s.ok === true,
    };
    return s;
  }

  /** @param {string} id @param {string} label @param {string} why @param {StepStatus} [status] @param {string} [model] */
  const skip = (id, label, why, status = 'skipped', model) => record({ id, label, model, ok: null, status, note: why });
  const textOf = (/** @type {any} */ r) => (r.content || []).filter((/** @type {any} */ b) => b.type === 'text').map((/** @type {any} */ b) => b.text).join('').trim();
  const base = { apiKey, workspaceId, maxTokens: 256 };
  const done = () => {
    const status = overallStatus(steps);
    // ok: Buddy funktioniert mit diesem Anbieter (vorübergehende Störungen sind nur Hinweise)
    const warnings = steps.filter((s) => s.status === 'unavailable').length;
    return { providerId, ok: !steps.some((s) => s.status === 'config' || s.status === 'error'), status, warnings, steps };
  };

  // 1. Zugangsdaten
  if (!apiKey) {
    skip('key', t('API-Key vorhanden'), t('Kein Key gespeichert.'), 'config');
    return done();
  }
  if (!main) {
    skip('models', t('Modell gewählt'), t('Kein Modell verfügbar.'), 'config');
    return done();
  }

  // 2. Modellliste (beweist, dass Key, Endpunkt und Konto stimmen)
  if (!local) {
    const s = await attempt('models', t('Key und Modellliste'), undefined, 'models.list', async () => {
      const list = await client.listModels(apiKey, workspaceId);
      const ids = new Set(list.map((m) => m.id));
      const missing = modelIds.filter((m) => !ids.has(m));
      if (missing.length && list.length) return { note: t('{n} Modelle verfügbar; nicht in der Liste: {m}', { n: list.length, m: missing.join(', ') }), status: 'limited' };
      return t('{n} Modelle verfügbar', { n: list.length });
    });
    record(s);
    // Key abgelehnt oder Konto gesperrt: jeder weitere Schritt würde am selben Grund scheitern
    if (s.status === 'config' && ['auth', 'permission', 'quota'].includes(String(s.error?.category))) {
      for (const [id, label] of laterSteps()) skip(id, label, t('Nicht geprüft: zuerst den Key bzw. das Konto in Ordnung bringen.'));
      return done();
    }
  }

  // 3. Einfachste Anfrage, für jedes benutzte Modell einzeln
  /** @type {Map<string, StepStatus>} */
  const basic = new Map();
  for (const model of modelIds) {
    const s = await attempt(`basic:${model}`, t('Einfache Antwort ohne Streaming'), model, 'generate', async (sig, ctx) => {
      const r = await client.streamMessage({ ...base, model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, signal: sig, ...ctx });
      const text = textOf(r);
      if (!text) throw Object.assign(new Error(t('Leere Antwort (Grund: {r}).', { r: r.stopReason || '?' })), { name: 'EmptyAnswer' });
      return `«${text.slice(0, 40)}»`;
    });
    record(s);
    basic.set(model, s.status);
  }
  // Ersatz für die weiteren Schritte, falls das Hauptmodell gerade gestört ist:
  // ein Modell, das in diesem Durchlauf nachweislich geantwortet hat
  const working = modelIds.filter((m) => m !== main && basic.get(m) === 'ok');

  // Ausweichmodell: nur zeigen, wenn das Hauptmodell gerade nicht verfügbar ist
  if (basic.get(main) === 'unavailable') {
    if (working.length) {
      record({ id: 'fallback', label: t('Ausweichmodell bereit'), model: working[0], ok: true, status: 'ok', note: t('{a} ist gerade nicht verfügbar; Buddy weicht im Chat auf {b} aus (abschaltbar in den Einstellungen).', { a: main, b: working[0] }) });
    } else {
      record({ id: 'fallback', label: t('Ausweichmodell bereit'), ok: false, status: 'unavailable', note: t('Kein anderes getestetes Modell hat geantwortet.') });
    }
  }

  /**
   * Schritt auf dem Hauptmodell; ist es gerade gestört, derselbe Schritt mit einem Modell, das funktioniert.
   * @param {string} id @param {string} label @param {string} model @param {string} requestType
   * @param {(m: string) => boolean} canRun Kann das Modell diesen Schritt überhaupt?
   * @param {(m: string, s: AbortSignal, ctx: { onRetry: () => void, maxRetries: number }) => Promise<string|void|{ note?: string, status?: StepStatus }>} fn
   */
  async function featureStep(id, label, model, requestType, canRun, fn) {
    if (!canRun(model)) {
      skip(id, label, t('Dieses Modell kann das nicht (nur Chat).'), 'unsupported', model);
      return;
    }
    // Ist das Hauptmodell schon bei der einfachen Antwort ausgefallen, nicht nochmals warten
    let s = basic.get(model) === 'unavailable' ? null : await attempt(id, label, model, requestType, (sig, ctx) => fn(model, sig, ctx));
    if (s && s.status !== 'unavailable') {
      record(s);
      return;
    }
    const alt = working.find((m) => canRun(m));
    if (!alt) {
      if (s) record(s);
      else skip(id, label, t('Nicht geprüft: {m} ist gerade nicht verfügbar und kein anderes Modell hat geantwortet.', { m: model }), 'unavailable', model);
      return;
    }
    s = await attempt(id, label, alt, requestType, (sig, ctx) => fn(alt, sig, ctx), { fallbackModel: alt, note: t('mit {b} geprüft, weil {a} gerade nicht verfügbar ist', { a: model, b: alt }) });
    record(s);
  }

  const caps = (/** @type {string} */ m) => models.capabilities(m);

  // 4. Streaming
  await featureStep('stream', t('Antwort mit Streaming'), main, 'stream', (m) => caps(m).streaming, async (m, sig, ctx) => {
    let streamed = '';
    let chunks = 0;
    const r = await client.streamMessage({ ...base, model: m, messages: [{ role: 'user', content: 'Reply with OK.' }], signal: sig, ...ctx, onText: (x) => { streamed += x; chunks += 1; } });
    const text = textOf(r);
    if (!text) throw Object.assign(new Error(t('Leere Antwort (Grund: {r}).', { r: r.stopReason || '?' })), { name: 'EmptyAnswer' });
    if (!streamed) return { note: t('Antwort kam an, aber nicht stückweise.'), status: 'limited' };
    // Die Stücke müssen zusammen genau die fertige Antwort ergeben (Reihenfolge, nichts doppelt)
    if (streamed.trim() !== text) return { note: t('Stücke ergeben nicht die ganze Antwort.'), status: 'limited' };
    return t('{n} Stücke', { n: chunks });
  });

  // 5. Verlauf mit Systemanweisung, Nutzer- und Assistenten-Rolle
  await featureStep('history', t('Unterhaltung mit Verlauf'), main, 'generate+history', (m) => caps(m).history, async (m, sig, ctx) => {
    const r = await client.streamMessage({
      ...base, model: m, stream: false, signal: sig, ...ctx,
      system: 'You are a test assistant. Answer with a single word.',
      messages: [
        { role: 'user', content: 'Remember the codeword APFEL.' },
        { role: 'assistant', content: 'Noted.' },
        { role: 'user', content: 'What is the codeword? Reply with the codeword only.' },
      ],
    });
    const text = textOf(r);
    if (!text) throw Object.assign(new Error(t('Leere Antwort (Grund: {r}).', { r: r.stopReason || '?' })), { name: 'EmptyAnswer' });
    return /apfel/i.test(text) ? '' : { note: t('Antwort ohne Codewort: «{x}»', { x: text.slice(0, 40) }), status: 'limited' };
  });

  // 6. Werkzeug mit Fortsetzung (nur wo das Modell Werkzeuge kann)
  await featureStep('tools', t('Werkzeug-Aufruf mit Fortsetzung'), main, 'tools', (m) => caps(m).tools, async (m, sig, ctx) => {
    /** @type {any[]} */
    const conv = [{ role: 'user', content: 'Call get_number with key "a". Then reply with the number only.' }];
    const r1 = await client.streamMessage({ ...base, model: m, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: sig, ...ctx });
    const calls = r1.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) return { note: t('Modell hat das Werkzeug nicht benutzt (antwortete direkt).'), status: 'limited' };
    conv.push({ role: 'assistant', content: r1.content });
    conv.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: /** @type {any} */ (c).id, content: '4711' })) });
    // Die Fortsetzung prüft Anbieter-Metadaten (z. B. Gemini thought_signature, OpenAI tool_call_id)
    const r2 = await client.streamMessage({ ...base, model: m, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: sig, ...ctx });
    const text = textOf(r2);
    if (!text && !r2.content.some((b) => b.type === 'tool_use')) throw Object.assign(new Error(t('Leere Antwort nach dem Werkzeug (Grund: {r}).', { r: r2.stopReason || '?' })), { name: 'EmptyAnswer' });
    return /4711/.test(text) ? '' : { note: t('Fortsetzung ok, aber ohne die Zahl: «{x}»', { x: text.slice(0, 40) }), status: 'limited' };
  });

  // 7. Mehrere Werkzeug-Aufrufe in einer Antwort
  await featureStep('parallel', t('Parallele Werkzeug-Aufrufe'), main, 'tools.parallel', (m) => caps(m).tools && caps(m).parallelTools, async (m, sig, ctx) => {
    /** @type {any[]} */
    const conv = [{ role: 'user', content: 'Call get_number twice in parallel, once with key "a" and once with key "b". Then reply with both numbers.' }];
    const r1 = await client.streamMessage({ ...base, model: m, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: sig, ...ctx });
    const calls = r1.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) return { note: t('Modell hat das Werkzeug nicht benutzt.'), status: 'limited' };
    conv.push({ role: 'assistant', content: r1.content });
    conv.push({ role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: /** @type {any} */ (c).id, content: i ? '22' : '11' })) });
    const r2 = await client.streamMessage({ ...base, model: m, stream: false, tools: [NUMBER_TOOL], messages: conv, signal: sig, ...ctx });
    if (!textOf(r2) && !r2.content.some((b) => b.type === 'tool_use')) throw Object.assign(new Error(t('Leere Antwort nach dem Werkzeug (Grund: {r}).', { r: r2.stopReason || '?' })), { name: 'EmptyAnswer' });
    return calls.length > 1 ? t('{n} Aufrufe auf einmal', { n: calls.length }) : t('Modell rief nacheinander auf (auch in Ordnung).');
  });

  // 8. Strukturierte Antwort, wie der Router sie braucht (nicht beim lokalen Modell)
  if (local) {
    skip('json', t('Strukturierte Antwort (Router)'), t('Lokal wählt Buddy ohne Router.'), 'unsupported');
  } else {
    const router = modelIds[modelIds.length - 1] || main;
    await featureStep('json', t('Strukturierte Antwort (Router)'), router, 'json', (m) => caps(m).structured, async (m, sig, ctx) => {
      const r = await client.json({
        apiKey, workspaceId, model: m, signal: sig, maxTokens: 200, effort: 'low', ...ctx,
        system: 'Return JSON only.', prompt: 'Return {"ok": true}.',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      });
      if (!r.data || typeof r.data.ok !== 'boolean') throw new Error(t('Kein gültiges JSON: «{x}»', { x: String(r.raw || '').slice(0, 60) }));
      return '';
    });
  }

  return done();
}

function laterSteps() {
  return [
    ['basic', t('Einfache Antwort ohne Streaming')], ['stream', t('Antwort mit Streaming')], ['history', t('Unterhaltung mit Verlauf')],
    ['tools', t('Werkzeug-Aufruf mit Fortsetzung')], ['parallel', t('Parallele Werkzeug-Aufrufe')], ['json', t('Strukturierte Antwort (Router)')],
  ];
}

const MARK = { ok: '✓', limited: '~', unavailable: '⏳', unsupported: '–', config: '✗', error: '✗', skipped: '–' };

/**
 * Kopierbarer Bericht ohne Keys und ohne Inhalte.
 * @param {{ providerId: string, providerName?: string, ok: boolean, status?: string, steps: HealthStep[] }[]} results
 * @param {{ version?: string, os?: string, language?: string }} [env]
 */
function healthReport(results, env = {}) {
  const lines = [`Buddy Island ${env.version || ''} · ${env.os || ''} · ${env.language || ''} · ${new Date().toISOString()}`];
  for (const r of results) {
    const status = r.status || overallStatus(r.steps);
    lines.push('', `## ${r.providerName || r.providerId}: ${statusLabel(status)}`);
    for (const s of r.steps) {
      const st = s.status || (s.ok === true ? 'ok' : s.ok === false ? 'error' : 'skipped');
      const mark = MARK[/** @type {keyof typeof MARK} */ (st)] || '?';
      lines.push(`${mark} ${s.label}${s.model ? ` [${s.model}]` : ''}${s.ms ? ` ${s.ms} ms` : ''} · ${statusLabel(st)}${s.note ? ` · ${s.note}` : ''}`);
      if (s.error) {
        const e = s.error;
        lines.push(`    ${e.message}`);
        lines.push(`    ${[e.provider, e.model, e.status ? `HTTP ${e.status}` : '', e.code, e.category, e.stage, e.origin, e.endpoint].filter(Boolean).join(' | ')}`);
        if (e.providerMessage) lines.push(`    Anbieter: ${e.providerMessage}`);
      }
      if (s.diag) {
        const d = s.diag;
        lines.push(`    ${[`API ${d.apiVersion || '-'}`, d.requestType, d.retries === 1 ? t('1 Wiederholung') : t('{n} Wiederholungen', { n: d.retries }), d.fallbackModel ? `${t('Ausweichmodell')} ${d.fallbackModel}` : ''].filter(Boolean).join(' · ')}`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = { runHealth, healthReport, overallStatus, statusLabel, apiVersionOf, NUMBER_TOOL, STATUS_LABEL, TEST_RETRIES };
