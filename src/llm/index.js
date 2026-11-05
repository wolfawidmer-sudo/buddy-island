// @ts-check
// Registry der KI-Anbieter (Strategy-Muster). Agent und Router fragen hier nach dem
// Client des aktiven Anbieters und sehen nur die gemeinsame Schnittstelle LlmClient.
// Jeder Anbieter spricht sein eigenes Protokoll (Claude Messages, OpenAI Responses, xAI Chat
// Completions, Gemini generateContent, lokales Transformers). Diese Schicht ergänzt nur,
// was für alle gleich sein muss: Fehler mit Anbieter, Modell, Endpunkt und Stufe.

const { createClient: createAnthropicClient } = require('../claude');
const { createOpenAiCompatClient } = require('./openai-compat');
const { createOpenAiResponsesClient } = require('./openai-responses');
const { createGeminiClient } = require('./gemini');
const { createHuggingFaceClient } = require('./huggingface');
const { createLocalClient } = require('./local');
const learned = require('./learned');
const auth = require('./auth');
const fallback = require('./fallback');
const { ProviderError, diagnosticLine, isTransient } = require('./errors');
const models = require('../models');

/** @typedef {import('./types').LlmClient} LlmClient */
/** @typedef {import('./types').ProviderId} ProviderId */

/** Endpunkt für die Diagnose (ohne Key) @param {import('./types').ProviderInfo} provider @param {string} [model] */
function endpointFor(provider, model) {
  switch (provider.kind) {
    case 'anthropic': return 'https://api.anthropic.com/v1/messages';
    case 'gemini': return `${provider.baseUrl}/models/${model || '{model}'}:streamGenerateContent`;
    case 'huggingface': return 'local://transformers';
    case 'local': return 'http://127.0.0.1:11434/api/chat';
    case 'openai-responses': return `${provider.baseUrl}/responses`;
    default: return `${provider.baseUrl}/chat/completions`;
  }
}

/**
 * Ergänzt fehlende Angaben im Fehler. Unerwartete Fehler (Programmfehler im Adapter)
 * werden zu einem ProviderError der Stufe «adapter», damit die Oberfläche sie richtig zeigt.
 * @param {any} err @param {import('./types').ProviderInfo} provider @param {string} [model] @param {string} [stage]
 */
function annotate(err, provider, model, stage) {
  if (err?.name === 'AbortError') return err;
  const name = provider.kind === 'anthropic' ? 'Claude' : provider.name.replace(/^Google |^xAI |^Anthropic /, '');
  let e = err;
  if (!(e instanceof ProviderError)) {
    e = new ProviderError(0, String(err?.message || err || ''), 'parse_error', name, { stage: 'adapter' });
    e.stack = err?.stack;
  }
  if (!e.providerId) e.providerId = provider.id;
  if (!e.provider || (provider.kind !== 'anthropic' && e.provider === 'Claude')) e.provider = name;
  if (!e.model && model) e.model = model;
  if (!e.endpoint) e.endpoint = endpointFor(provider, model);
  // Modell gibt es (für diesen Key) nicht mehr: merken, damit die Auswahl es überspringt.
  // Nennt der Anbieter einen Nachfolger («use models/gemini-…»), merkt sich Buddy auch den.
  // Überlastet oder Limit pro Modell (z. B. Gemini «high demand»): ein paar Minuten lang ein anderes Modell bevorzugen.
  // Netz- und Zeitfehler zählen nicht: die liegen meist nicht am Modell.
  if (model && isTransient(e) && (e.category === 'overloaded' || e.category === 'rate_limit' || e.category === 'server')) {
    fallback.markBusy(provider.id, model);
  }
  if (model && e.category === 'model' && (e.status === 404 || e.status === 400)) {
    learned.set(provider.id, model, 'unavailable', true);
    const next = String(e.raw || '').match(/\buse\s+(?:models\/)?([a-z0-9][\w.-]*[a-z0-9])\b/i);
    if (next && next[1] !== String(model).replace(/^models\//, '')) learned.set(provider.id, model, 'replacement', next[1]);
  }
  if (stage && (!e.stage || e.stage === 'request' || e.stage === 'connect') && stage === 'models') e.stage = 'models';
  return e;
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   scriptDir: string,
 *   getPythonRuntime: () => Promise<{exe: string, args: string[]}|null>,
 *   getHfToken?: () => string|null,
 *   log?: (m: string) => void,
 *   onLocalStatus?: (s: {state: string, model: string|null, device: string|null, error: string|null}) => void,
 *   localManager?: any,
 *   getLocalAdvanced?: () => any,
 *   allowLocalTools?: () => boolean,
 * }} opts
 */
function createLlm({ fetchImpl = globalThis.fetch, scriptDir, getPythonRuntime, getHfToken, log = () => {}, onLocalStatus, localManager, getLocalAdvanced, allowLocalTools }) {
  /** @type {Partial<Record<ProviderId, LlmClient>>} */
  const clients = {};
  const hf = createHuggingFaceClient({ scriptDir, getRuntime: getPythonRuntime, getToken: getHfToken, log, onStatus: onLocalStatus });

  /** @param {import('./types').ProviderInfo} provider @param {LlmClient} raw @returns {LlmClient} */
  function wrap(provider, raw) {
    /** @param {any} err @param {string} [model] @param {string} [stage] @param {string} [apiKey] */
    const fail = (err, model, stage, apiKey) => {
      const e = annotate(err, provider, model, stage);
      // Abgeschaltetes Key-Format (z. B. alter Gemini-Standard-Key): klar sagen, dass ein neuer Key nötig ist
      if (e?.name !== 'AbortError' && apiKey) {
        const why = auth.explain(provider.id, apiKey, e);
        if (why.code === 'retired_key') e.message = why.message;
        e.reauth = why.reauth;
      }
      if (e?.name !== 'AbortError') log(diagnosticLine(e));
      return e;
    };
    return {
      ...raw,
      provider: raw.provider,
      listModels: (apiKey, ...rest) => raw.listModels(apiKey, ...rest).catch((err) => { throw fail(err, '', 'models', apiKey); }),
      streamMessage: (req) => raw.streamMessage(req).catch((err) => { throw fail(err, req.model, undefined, req.apiKey); }),
      json: (req) => raw.json(req).catch((err) => { throw fail(err, req.model, undefined, req.apiKey); }),
    };
  }

  /** @param {ProviderId} id @returns {LlmClient} */
  function client(id) {
    const existing = clients[id];
    if (existing) return existing;
    const provider = models.PROVIDERS[id] || models.PROVIDERS.anthropic;
    /** @type {LlmClient} */
    let c;
    if (provider.kind === 'anthropic') c = /** @type {LlmClient} */ (/** @type {unknown} */ (createAnthropicClient(fetchImpl)));
    else if (provider.kind === 'huggingface') c = hf;
    else if (provider.kind === 'local') {
      if (!localManager) throw new ProviderError(0, 'Lokale KI nicht verfügbar', 'local_error', 'Lokal');
      c = createLocalClient({ manager: localManager, getAdvanced: getLocalAdvanced, allowTools: allowLocalTools, log });
    }
    else if (provider.kind === 'gemini') c = createGeminiClient({ provider, fetchImpl });
    else if (provider.kind === 'openai-responses') c = createOpenAiResponsesClient({ provider, fetchImpl });
    else c = createOpenAiCompatClient({ provider, fetchImpl });
    const wrapped = provider.kind === 'huggingface' ? { ...wrap(provider, c), stop: hf.stop, status: hf.status, preload: hf.preload } : wrap(provider, c);
    clients[provider.id] = wrapped;
    return wrapped;
  }

  function stopAll() {
    hf.stop?.();
  }

  return { client, providers: models.PROVIDERS, stopAll, hfStatus: () => hf.status(), preloadLocal: (/** @type {string} */ model) => hf.preload(model) };
}

module.exports = { createLlm, annotate, endpointFor };
