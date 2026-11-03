// @ts-check
// Registry der KI-Anbieter (Strategy-Muster). Agent und Router fragen hier nach dem
// Client des aktiven Anbieters und sehen nur die gemeinsame Schnittstelle LlmClient.

const { createClient: createAnthropicClient } = require('../claude');
const { createOpenAiCompatClient } = require('./openai-compat');
const { createHuggingFaceClient } = require('./huggingface');
const models = require('../models');

/** @typedef {import('./types').LlmClient} LlmClient */
/** @typedef {import('./types').ProviderId} ProviderId */

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   scriptDir: string,
 *   getPythonRuntime: () => Promise<{exe: string, args: string[]}|null>,
 *   getHfToken?: () => string|null,
 *   log?: (m: string) => void,
 *   onLocalStatus?: (s: {state: string, model: string|null, device: string|null, error: string|null}) => void,
 * }} opts
 */
function createLlm({ fetchImpl = globalThis.fetch, scriptDir, getPythonRuntime, getHfToken, log = () => {}, onLocalStatus }) {
  /** @type {Partial<Record<ProviderId, LlmClient>>} */
  const clients = {};
  const hf = createHuggingFaceClient({ scriptDir, getRuntime: getPythonRuntime, getToken: getHfToken, log, onStatus: onLocalStatus });

  /** @param {ProviderId} id @returns {LlmClient} */
  function client(id) {
    const existing = clients[id];
    if (existing) return existing;
    const provider = models.PROVIDERS[id] || models.PROVIDERS.anthropic;
    /** @type {LlmClient} */
    let c;
    if (provider.kind === 'anthropic') c = /** @type {LlmClient} */ (/** @type {unknown} */ (createAnthropicClient(fetchImpl)));
    else if (provider.kind === 'huggingface') c = hf;
    else c = createOpenAiCompatClient({ provider, fetchImpl });
    clients[provider.id] = c;
    return c;
  }

  function stopAll() {
    hf.stop?.();
  }

  return { client, providers: models.PROVIDERS, stopAll, hfStatus: () => hf.status(), preloadLocal: (/** @type {string} */ model) => hf.preload(model) };
}

module.exports = { createLlm };
