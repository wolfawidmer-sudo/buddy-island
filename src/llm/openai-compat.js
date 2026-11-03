// @ts-check
// Adapter für Anbieter mit OpenAI-kompatibler Chat-Completions-API:
// OpenAI und xAI Grok (Chat Completions). Gemini hat einen eigenen, nativen Adapter (gemini.js).
// Übersetzt Buddys Content-Block-Format (wie Claude) in Chat Completions und zurück,
// inklusive Streaming, Function Calling, Bildern und strukturierten Antworten.

const { parseSSE } = require('../claude');
const { ProviderError, isRetryable, abortError, wait, RETRY_STATUS } = require('./errors');
const models = require('../models');

/** @typedef {import('./types').LlmClient} LlmClient */
/** @typedef {import('./types').ProviderInfo} ProviderInfo */
/** @typedef {import('./types').Message} Message */
/** @typedef {import('./types').ContentBlock} ContentBlock */
/** @typedef {import('./types').Tool} Tool */
/** @typedef {import('./types').StreamRequest} StreamRequest */
/** @typedef {import('./types').StreamResult} StreamResult */
/** @typedef {import('./types').Usage} Usage */

const RETRY_DELAYS = [1500, 4000, 10000];
const CONNECT_TIMEOUT_MS = 45000;
const IDLE_TIMEOUT_MS = 90000;

// Nur für Tests: lokale Mock-Server statt der echten API
/** @param {ProviderInfo} provider */
function baseUrl(provider) {
  const override = process.env[`BUDDY_${provider.id.toUpperCase()}_BASE`];
  if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(override)) return override.replace(/\/$/, '');
  return provider.baseUrl;
}

/**
 * Buddys Nachrichten → Chat-Completions-Nachrichten.
 * @param {Message[]} messages
 * @param {string|undefined} system
 * @param {{ vision: boolean }} caps
 */
function toChatMessages(messages, system, caps) {
  /** @type {any[]} */
  const out = [];
  if (system && system.trim()) out.push({ role: 'system', content: system.trim() });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => /** @type {any} */ (b).text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => {
        const u = /** @type {import('./types').ToolUseBlock} */ (b);
        return { id: u.id, type: 'function', function: { name: u.name, arguments: JSON.stringify(u.input || {}) } };
      });
      /** @type {any} */
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      if (text || calls.length) out.push(msg);
      continue;
    }
    // Nutzer: zuerst Werkzeug-Ergebnisse (müssen direkt auf den Aufruf folgen), dann Text und Bilder
    /** @type {any[]} */
    const parts = [];
    /** @type {any[]} */
    const images = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const r = /** @type {import('./types').ToolResultBlock} */ (b);
        const blocks = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : r.content || [];
        const text = blocks.filter((x) => x.type === 'text').map((x) => /** @type {any} */ (x).text).join('\n');
        const imgs = blocks.filter((x) => x.type === 'image');
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: `${r.is_error ? 'FEHLER: ' : ''}${text || (imgs.length ? '[Bild im nächsten Beitrag]' : 'OK')}` });
        images.push(...imgs);
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: /** @type {any} */ (b).text });
      } else if (b.type === 'image') {
        images.push(b);
      }
    }
    for (const img of images) {
      const src = /** @type {import('./types').ImageBlock} */ (img).source;
      if (caps.vision) parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
      else parts.push({ type: 'text', text: '[Bild weggelassen: dieses Modell kann keine Bilder sehen]' });
    }
    if (parts.length) out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  return out;
}

/** @param {Tool[]|undefined} tools */
function toChatTools(tools) {
  const out = [];
  let dropped = false;
  for (const tool of tools || []) {
    if ('name' in tool && tool.name) {
      out.push({ type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.input_schema || { type: 'object', properties: {} } } });
    } else {
      dropped = true; // Anbieter-eigene Werkzeuge (z. B. Claude Computer Use) gibt es hier nicht
    }
  }
  return { tools: out, dropped };
}

/** @param {string|null|undefined} reason */
function mapStop(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'refusal';
    case 'stop': return 'end_turn';
    default: return reason || 'end_turn';
  }
}

/**
 * @param {{ provider: ProviderInfo, fetchImpl?: typeof fetch, connectTimeoutMs?: number, idleTimeoutMs?: number }} opts
 * @returns {LlmClient}
 */
function createOpenAiCompatClient({ provider, fetchImpl = globalThis.fetch, connectTimeoutMs = CONNECT_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
  const name = provider.name.replace(/^Google |^xAI /, '');
  const base = () => baseUrl(provider);

  /** @param {string} apiKey */
  const headers = (apiKey) => ({ authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' });

  /** @param {Response} response @param {any} [ctx] */
  async function toError(response, ctx = {}) {
    let raw = '';
    let type = '';
    try {
      const json = await response.json();
      const e = Array.isArray(json) ? json[0]?.error : json?.error;
      raw = e?.message || '';
      type = e?.type || e?.code || e?.status || '';
    } catch { /* kein JSON */ }
    const err = new ProviderError(response.status, raw, String(type), name, { providerId: provider.id, endpoint: `${base()}/chat/completions`, ...ctx });
    const after = Number(response.headers?.get?.('retry-after'));
    if (Number.isFinite(after) && after > 0) err.retryAfterMs = Math.min(20000, after * 1000);
    return err;
  }

  /** @param {string} apiKey */
  async function listModels(apiKey) {
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), 20000);
    let response;
    try {
      response = await fetchImpl(`${base()}/models`, { headers: headers(apiKey), signal: local.signal });
    } catch {
      throw new ProviderError(0, '', local.signal.aborted ? 'timeout_error' : '', name, { providerId: provider.id, endpoint: `${base()}/models`, stage: 'models' });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await toError(response, { endpoint: `${base()}/models`, stage: 'models' });
    const json = await response.json();
    return (json.data || []).map((/** @type {any} */ m) => {
      const id = String(m.id || '').replace(/^models\//, '');
      return { id, name: m.display_name || models.info(id).name };
    }).filter((/** @type {{id:string}} */ m) => m.id);
  }

  /**
   * Ein Versuch mit Zeitlimit bis zur ersten Antwort.
   * @param {string} apiKey @param {any} body @param {AbortSignal|undefined} signal
   */
  async function postOnce(apiKey, body, signal) {
    const local = new AbortController();
    const onAbort = () => local.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; local.abort(); }, connectTimeoutMs);
    try {
      const response = await fetchImpl(`${base()}/chat/completions`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal: local.signal });
      return { response, local, cleanup: () => signal?.removeEventListener('abort', onAbort) };
    } catch (err) {
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) throw new ProviderError(0, '', 'timeout_error', name, { providerId: provider.id, model: body.model, endpoint: `${base()}/chat/completions`, stage: 'connect' });
      if (signal?.aborted || /** @type {any} */ (err)?.name === 'AbortError') throw abortError();
      throw new ProviderError(0, '', '', name, { providerId: provider.id, model: body.model, endpoint: `${base()}/chat/completions`, stage: 'connect' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {string} apiKey @param {any} body @param {AbortSignal|undefined} signal @param {StreamRequest['onRetry']} onRetry */
  async function post(apiKey, body, signal, onRetry) {
    for (let attempt = 0; ; attempt += 1) {
      let result;
      try {
        result = await postOnce(apiKey, body, signal);
      } catch (err) {
        if (/** @type {any} */ (err)?.name === 'AbortError' || !isRetryable(err) || attempt >= RETRY_DELAYS.length) throw err;
        onRetry?.(attempt + 1, /** @type {Error} */ (err));
        await wait(RETRY_DELAYS[attempt], signal);
        continue;
      }
      const { response } = result;
      if (response.ok || !RETRY_STATUS.has(response.status) || attempt >= RETRY_DELAYS.length) return result;
      const err = await toError(response, { model: body.model });
      result.cleanup();
      if (err.category === 'quota') throw err; // Warten hilft bei leerem Guthaben nicht
      onRetry?.(attempt + 1, err);
      await wait(err.retryAfterMs || RETRY_DELAYS[attempt], signal);
    }
  }

  /** @param {StreamRequest} req @returns {Promise<StreamResult>} */
  async function streamMessage(req) {
    const { apiKey, model, system, messages, tools, maxTokens, effort, format, signal, onText, onRetry } = req;
    const info = models.info(model);
    const caps = info.caps;
    const converted = toChatTools(caps.tools ? tools : []);
    /** @type {any} */
    let streaming = req.stream !== false;
    const body = {
      model,
      messages: toChatMessages(messages, system, caps),
      stream: streaming,
    };
    if (streaming) body.stream_options = { include_usage: true };
    // OpenAI möchte max_completion_tokens, die anderen kennen max_tokens
    if (provider.id === 'openai') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (converted.tools.length) body.tools = converted.tools;
    if (effort && info.effortParam === 'reasoning_effort') body.reasoning_effort = effort;
    if (format) body.response_format = { type: 'json_schema', json_schema: { name: 'antwort', schema: format, strict: true } };

    let droppedFormat = false;
    // Optionale Teile, die nicht jedes Modell kennt: bei Fehler ohne sie nochmals
    const optional = [
      { test: /response_format|json_schema|structured/i, drop: () => (body.response_format ? (delete body.response_format, droppedFormat = true, true) : false) },
      { test: /stream_options/i, drop: () => (body.stream_options ? (delete body.stream_options, true) : false) },
      // z. B. «Your organization must be verified to stream this model»: dann ohne Streaming
      { test: /stream/i, drop: () => (streaming ? (streaming = false, body.stream = false, delete body.stream_options, true) : false) },
      { test: /reasoning_effort/i, drop: () => (body.reasoning_effort ? (delete body.reasoning_effort, true) : false) },
      { test: /max_completion_tokens/i, drop: () => (body.max_completion_tokens ? (body.max_tokens = body.max_completion_tokens, delete body.max_completion_tokens, true) : false) },
      { test: /max_tokens/i, drop: () => (body.max_tokens ? (body.max_completion_tokens = body.max_tokens, delete body.max_tokens, true) : false) },
    ];
    /** @type {Set<number>} */
    const used = new Set();
    let attempt = await post(apiKey, body, signal, onRetry);
    while (attempt.response.status === 400) {
      const err = await toError(attempt.response, { model });
      attempt.cleanup();
      const i = optional.findIndex((o, n) => !used.has(n) && o.test.test(err.raw));
      if (i < 0 || !optional[i].drop()) throw err;
      used.add(i);
      attempt = await post(apiKey, body, signal, onRetry);
    }
    if (!attempt.response.ok) {
      attempt.cleanup();
      throw await toError(attempt.response, { model });
    }
    const ctx = { providerId: provider.id, model, endpoint: `${base()}/chat/completions` };

    const { response, local } = attempt;
    let text = '';
    /** @type {Map<number, {id: string, name: string, args: string}>} */
    const calls = new Map();
    /** @type {string|null} */
    let finish = null;
    /** @type {Usage} */
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let idle;
    let idleHit = false;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { idleHit = true; local.abort(); }, idleTimeoutMs);
    };
    /** Antwort am Stück (ohne Streaming) in dieselbe Form bringen wie die Stream-Stücke */
    const fromMessage = (/** @type {any} */ data) => {
      const choice = data?.choices?.[0] || {};
      const msg = choice.message || {};
      return [{ usage: data?.usage, choices: [{ delta: { content: msg.content || '', tool_calls: (msg.tool_calls || []).map((/** @type {any} */ tc, i) => ({ ...tc, index: i })) }, finish_reason: choice.finish_reason }] }];
    };
    async function* chunks() {
      if (streaming) {
        for await (const { data } of parseSSE(/** @type {any} */ (response.body), kick)) yield data;
        return;
      }
      let data;
      try { data = await response.json(); } catch { throw new ProviderError(response.status, 'Antwort ist kein JSON', 'parse_error', name, { ...ctx, stage: 'parse' }); }
      if (data?.error) throw new ProviderError(response.status, data.error.message || '', data.error.type || data.error.code || '', name, { ...ctx, stage: 'request' });
      yield* fromMessage(data);
    }
    kick();
    try {
      for await (const data of chunks()) {
        if (data?.error) throw new ProviderError(0, data.error.message || 'Stream-Fehler', data.error.type || '', name, { ...ctx, stage: 'stream' });
        if (data?.usage) {
          const cached = Number(data.usage.prompt_tokens_details?.cached_tokens) || 0;
          usage.input_tokens = Math.max(0, (Number(data.usage.prompt_tokens) || 0) - cached);
          usage.cache_read_input_tokens = cached;
          usage.output_tokens = Number(data.usage.completion_tokens) || 0;
        }
        const choice = data?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          onText?.(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
          const idx = Number(tc.index) || 0;
          const entry = calls.get(idx) || { id: '', name: '', args: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          calls.set(idx, entry);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      if (idleHit) throw new ProviderError(0, '', 'timeout_error', name, { ...ctx, stage: 'stream' });
      if (signal?.aborted || /** @type {any} */ (err)?.name === 'AbortError') throw abortError();
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(0, '', '', name, { ...ctx, stage: 'stream' });
    } finally {
      clearTimeout(idle);
      attempt.cleanup();
    }

    /** @type {ContentBlock[]} */
    const content = [];
    if (text) content.push({ type: 'text', text });
    let n = 0;
    for (const call of calls.values()) {
      n += 1;
      /** @type {any} */
      let input = {};
      let invalid = false;
      try { input = call.args ? JSON.parse(call.args) : {}; } catch { invalid = true; }
      /** @type {any} */
      const block = { type: 'tool_use', id: call.id || `call_${Date.now().toString(36)}_${n}`, name: call.name, input };
      if (invalid) Object.defineProperty(block, 'invalidJson', { value: true, enumerable: false });
      content.push(block);
    }
    const stopReason = calls.size && (!finish || finish === 'stop') ? 'tool_use' : mapStop(finish);
    return { stopReason, usage, content, droppedComputer: converted.dropped, droppedFormat };
  }

  /** @param {import('./types').JsonRequest} req */
  async function json(req) {
    const result = await streamMessage({
      apiKey: req.apiKey, model: req.model, system: req.system, maxTokens: req.maxTokens || 700, effort: req.effort, signal: req.signal,
      messages: [{ role: 'user', content: req.prompt }],
      format: req.schema,
    });
    const text = result.content.filter((b) => b.type === 'text').map((b) => /** @type {any} */ (b).text).join('');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { data = JSON.parse(m[0]); } catch { data = null; } }
    }
    return { data, usage: result.usage, raw: text, stopReason: result.stopReason };
  }

  return { provider: provider.id, listModels, streamMessage, json };
}

module.exports = { createOpenAiCompatClient, toChatMessages, toChatTools, mapStop };
