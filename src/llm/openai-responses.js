// @ts-check
// Adapter für die OpenAI Responses API (POST /v1/responses).
// Warum nicht mehr Chat Completions: Bei GPT-6 gehen Werkzeuge zusammen mit Denken nur noch
// über Responses (developers.openai.com/api/docs/guides/latest-model). Die Denk-Schritte kommen
// verschlüsselt zurück (include: reasoning.encrypted_content) und werden bei der Fortsetzung
// nach einem Werkzeug-Aufruf unverändert mitgeschickt (meta.reasoning), ohne dass OpenAI
// etwas speichern muss (store: false).

const { parseSSE } = require('../claude');
const { ProviderError, isRetryable, abortError, wait, RETRY_STATUS } = require('./errors');
const learned = require('./learned');
const models = require('../models');
const { REASONING_ORDER } = require('./openai-compat');

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

/** @param {ProviderInfo} provider */
function baseUrl(provider) {
  const override = process.env[`BUDDY_${provider.id.toUpperCase()}_BASE`];
  if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(override)) return override.replace(/\/$/, '');
  return provider.baseUrl;
}

/** Nur die Felder, die die API als Eingabe annimmt @param {any} item */
const cleanReasoning = (item) => ({ type: 'reasoning', ...(item.id ? { id: item.id } : {}), summary: Array.isArray(item.summary) ? item.summary : [], encrypted_content: item.encrypted_content });

/**
 * Buddys Nachrichten → Responses-«input».
 * @param {Message[]} messages @param {{ vision: boolean }} caps
 */
function toResponsesInput(messages, caps) {
  /** Aufruf-ID je Werkzeug-Block (OpenAI nennt sie call_id) @type {Map<string, string>} */
  const callIds = new Map();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === 'tool_use') callIds.set(b.id, (b.meta?.provider === 'openai' && b.meta.callId) || b.id);
  }
  /** @param {any} src */
  const image = (src) => (caps.vision
    ? { type: 'input_image', image_url: `data:${src.media_type};base64,${src.data}` }
    : { type: 'input_text', text: '[Bild weggelassen: dieses Modell kann keine Bilder sehen]' });
  /** @type {any[]} */
  const input = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (!m.content) continue;
      input.push(m.role === 'assistant'
        ? { role: 'assistant', content: [{ type: 'output_text', text: m.content }] }
        : { role: 'user', content: [{ type: 'input_text', text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      // Denk-Items zuerst, in der Reihenfolge, wie OpenAI sie geliefert hat
      for (const b of m.content) {
        const r = /** @type {any} */ (b).meta;
        if (r?.provider === 'openai' && Array.isArray(r.reasoning)) for (const item of r.reasoning) if (item?.encrypted_content) input.push(cleanReasoning(item));
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => /** @type {any} */ (b).text).join('');
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const b of m.content) {
        if (b.type !== 'tool_use') continue;
        input.push({ type: 'function_call', call_id: callIds.get(b.id), name: b.name, arguments: JSON.stringify(b.input || {}) });
      }
      continue;
    }
    // Nutzer: Werkzeug-Ergebnisse direkt nach den Aufrufen, dann Text und Bilder
    /** @type {any[]} */
    const parts = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const blocks = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content || [];
        const text = blocks.filter((x) => x.type === 'text').map((x) => /** @type {any} */ (x).text).join('\n');
        const imgs = blocks.filter((x) => x.type === 'image');
        input.push({ type: 'function_call_output', call_id: callIds.get(b.tool_use_id) || b.tool_use_id, output: `${b.is_error ? 'FEHLER: ' : ''}${text || (imgs.length ? '[Bild im nächsten Beitrag]' : 'OK')}` });
        for (const img of imgs) parts.push(image(/** @type {any} */ (img).source));
      } else if (b.type === 'text' && b.text) {
        parts.push({ type: 'input_text', text: b.text });
      } else if (b.type === 'image') {
        parts.push(image(b.source));
      }
    }
    if (parts.length) input.push({ role: 'user', content: parts });
  }
  return input;
}

/** @param {Tool[]|undefined} tools */
function toResponsesTools(tools) {
  const out = [];
  let dropped = false;
  for (const tool of tools || []) {
    if ('name' in tool && tool.name) out.push({ type: 'function', name: tool.name, description: tool.description || '', parameters: tool.input_schema || { type: 'object', properties: {} }, strict: false });
    else dropped = true; // Anbieter-eigene Werkzeuge (Claude Computer Use) gibt es hier nicht
  }
  return { tools: out, dropped };
}

/**
 * Welche Denkstufen für Buddys Aufwand in Frage kommen, die bevorzugte zuerst.
 * «none» nur bei Modellen, die es kennen (GPT-6.1 Sol und Astra lehnen es ab).
 * @param {string} effort @param {import('./types').ModelInfo} info
 */
function effortCandidates(effort, info) {
  const known = info.efforts || [];
  const has = (/** @type {string} */ v) => !known.length || known.includes(v);
  if (effort === 'low') return [...(info.reasoningNone ? ['none'] : []), 'minimal', 'low'];
  if (effort === 'medium') return ['medium'];
  if (effort === 'max') return ['max', 'xhigh', 'high'].filter(has);
  if (effort === 'xhigh') return ['xhigh', 'high'].filter(has);
  if (effort === 'high') return ['high'];
  return ['low'];
}

/**
 * @param {{ provider: ProviderInfo, fetchImpl?: typeof fetch, connectTimeoutMs?: number, idleTimeoutMs?: number }} opts
 * @returns {LlmClient}
 */
function createOpenAiResponsesClient({ provider, fetchImpl = globalThis.fetch, connectTimeoutMs = CONNECT_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
  const name = provider.name;
  const base = () => baseUrl(provider);
  const endpoint = () => `${base()}/responses`;
  /** @param {string} apiKey */
  const headers = (apiKey) => ({ authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' });

  /** @param {Response} response @param {any} [ctx] */
  async function toError(response, ctx = {}) {
    let raw = '';
    let type = '';
    try {
      const json = await response.json();
      const e = json?.error || json;
      raw = e?.message || '';
      type = e?.code || e?.type || '';
    } catch { /* kein JSON */ }
    const err = new ProviderError(response.status, raw, String(type), name, { providerId: provider.id, endpoint: endpoint(), ...ctx });
    const after = Number(response.headers?.get?.('retry-after'));
    if (Number.isFinite(after) && after > 0) err.retryAfterMs = Math.min(20000, after * 1000);
    return err;
  }

  /** @param {string} apiKey */
  async function listModels(apiKey) {
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), 20000);
    const url = `${base()}/models`;
    let response;
    try {
      response = await fetchImpl(url, { headers: headers(apiKey), signal: local.signal });
    } catch {
      throw new ProviderError(0, '', local.signal.aborted ? 'timeout_error' : '', name, { providerId: provider.id, endpoint: url, stage: 'models' });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await toError(response, { endpoint: url, stage: 'models' });
    const json = await response.json();
    return (json.data || []).map((/** @type {any} */ m) => ({ id: String(m.id || ''), name: models.info(String(m.id || '')).name })).filter((/** @type {{id:string}} */ m) => m.id);
  }

  /** @param {string} apiKey @param {any} body @param {AbortSignal|undefined} signal */
  async function postOnce(apiKey, body, signal) {
    const local = new AbortController();
    const onAbort = () => local.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; local.abort(); }, connectTimeoutMs);
    try {
      const response = await fetchImpl(endpoint(), { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal: local.signal });
      return { response, local, cleanup: () => signal?.removeEventListener('abort', onAbort) };
    } catch (err) {
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) throw new ProviderError(0, '', 'timeout_error', name, { providerId: provider.id, model: body.model, endpoint: endpoint(), stage: 'connect' });
      if (signal?.aborted || /** @type {any} */ (err)?.name === 'AbortError') throw abortError();
      throw new ProviderError(0, '', '', name, { providerId: provider.id, model: body.model, endpoint: endpoint(), stage: 'connect' });
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
      if (err.category === 'quota') throw err;
      onRetry?.(attempt + 1, err);
      await wait(err.retryAfterMs || RETRY_DELAYS[attempt], signal);
    }
  }

  /** @param {StreamRequest} req @returns {Promise<StreamResult>} */
  async function streamMessage(req) {
    const { apiKey, model, system, messages, tools, maxTokens, effort, format, signal, onText, onRetry } = req;
    const info = models.info(model);
    const caps = info.caps;
    const converted = toResponsesTools(caps.tools ? tools : []);
    let streaming = req.stream !== false;
    /** @type {any} */
    const body = { model, input: toResponsesInput(messages, caps), stream: streaming, store: false, max_output_tokens: maxTokens };
    if (system && system.trim()) body.instructions = system.trim();
    if (converted.tools.length) body.tools = converted.tools;
    const thinks = info.effortParam === 'reasoning_effort' && !learned.get(provider.id, model, 'noReasoningEffort');
    const chain = thinks ? effortCandidates(effort || 'default', info).filter((v) => !(learned.get(provider.id, model, 'badEffort') || []).includes(v)) : [];
    if (chain.length) body.reasoning = { effort: chain.shift() };
    // Denk-Schritte verschlüsselt mitliefern lassen, damit sie nach einem Werkzeug weitergehen
    if (thinks && !learned.get(provider.id, model, 'noInclude')) body.include = ['reasoning.encrypted_content'];
    if (format) body.text = { format: { type: 'json_schema', name: 'antwort', schema: format, strict: true } };

    let droppedFormat = false;
    const optional = [
      { test: /\binclude\b|encrypted_content/i, drop: () => (body.include ? (delete body.include, learned.set(provider.id, model, 'noInclude', true), true) : false) },
      { test: /text\.format|json_schema|response_format|structured/i, drop: () => (body.text ? (delete body.text, droppedFormat = true, true) : false) },
      // «Your organization must be verified to stream this model»: dann ohne Streaming
      { test: /stream/i, drop: () => (streaming ? (streaming = false, body.stream = false, true) : false) },
      {
        test: /reasoning/i,
        repeat: true,
        drop: (/** @type {string} */ raw) => {
          if (!body.reasoning) return false;
          const bad = learned.get(provider.id, model, 'badEffort') || [];
          learned.set(provider.id, model, 'badEffort', [...bad, body.reasoning.effort]);
          const allowed = (String(raw).match(/\bsupported values?\b[^:.]*:([^.]*)/i)?.[1] || '').match(/[a-z]+/gi)?.map((v) => v.toLowerCase()) || [];
          const next = allowed.length ? REASONING_ORDER.concat(['max']).find((v) => allowed.includes(v) && chain.includes(v)) || (allowed.includes('low') ? 'low' : allowed[0]) : chain.shift();
          if (next && next !== body.reasoning.effort) {
            chain.splice(0, chain.indexOf(next) + 1);
            body.reasoning = { effort: next };
            return true;
          }
          // Modell ohne Denken (z. B. ältere GPT-4.1): ganz ohne
          delete body.reasoning;
          delete body.include;
          learned.set(provider.id, model, 'noReasoningEffort', true);
          return true;
        },
      },
    ];
    /** @type {Set<number>} */
    const used = new Set();
    let attempt = await post(apiKey, body, signal, onRetry);
    while (attempt.response.status === 400) {
      const err = await toError(attempt.response, { model });
      attempt.cleanup();
      const i = optional.findIndex((o, n) => !used.has(n) && o.test.test(err.raw));
      if (i < 0 || !optional[i].drop(err.raw)) throw err;
      if (!(/** @type {any} */ (optional[i]).repeat)) used.add(i);
      attempt = await post(apiKey, body, signal, onRetry);
    }
    if (!attempt.response.ok) {
      attempt.cleanup();
      throw await toError(attempt.response, { model });
    }
    const ctx = { providerId: provider.id, model, endpoint: endpoint() };
    const { response, local } = attempt;

    let text = '';
    let refusal = '';
    /** @type {any[]} */
    let items = [];
    /** @type {any} */
    let final = null;
    /** @type {Usage} */
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    /** @param {any} resp */
    const finish = (resp) => {
      final = resp || {};
      if (Array.isArray(final.output) && final.output.length) items = final.output;
      const u = final.usage || {};
      const cached = Number(u.input_tokens_details?.cached_tokens) || 0;
      usage.input_tokens = Math.max(0, (Number(u.input_tokens) || 0) - cached);
      usage.cache_read_input_tokens = cached;
      usage.output_tokens = Number(u.output_tokens) || 0;
    };
    /** @param {any} e @param {string} stage */
    const failed = (e, stage) => new ProviderError(Number(e?.status) || 0, e?.message || 'Stream-Fehler', e?.code || e?.type || '', name, { ...ctx, stage: /** @type {any} */ (stage) });

    if (streaming) {
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let idle;
      let idleHit = false;
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { idleHit = true; local.abort(); }, idleTimeoutMs);
      };
      kick();
      try {
        for await (const { data } of parseSSE(/** @type {any} */ (response.body), kick)) {
          const type = data?.type;
          if (type === 'response.output_text.delta' && typeof data.delta === 'string') {
            text += data.delta;
            onText?.(data.delta);
          } else if (type === 'response.refusal.delta' && typeof data.delta === 'string') {
            refusal += data.delta;
          } else if (type === 'response.output_item.done' && data.item) {
            items.push(data.item);
          } else if (type === 'response.completed' || type === 'response.incomplete') {
            finish(data.response);
          } else if (type === 'response.failed') {
            throw failed(data.response?.error, 'stream');
          } else if (type === 'error') {
            throw failed(data.error || data, 'stream');
          }
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
      // Ohne «response.completed» ist die Verbindung abgerissen: keine halbe Antwort als fertig ausgeben
      if (!final && !signal?.aborted) throw new ProviderError(0, 'Stream ohne Abschluss beendet', 'stream_incomplete', name, { ...ctx, stage: 'stream' });
    } else {
      try {
        let data;
        try { data = await response.json(); } catch { throw new ProviderError(response.status, 'Antwort ist kein JSON', 'parse_error', name, { ...ctx, stage: 'parse' }); }
        if (data?.error) throw failed(data.error, 'request');
        finish(data);
      } finally {
        attempt.cleanup();
      }
    }
    if (final?.status === 'failed') throw failed(final.error, 'request');

    // Text aus den fertigen Items, falls keine Deltas kamen (ohne Streaming)
    if (!text) {
      for (const item of items) {
        if (item?.type !== 'message') continue;
        for (const c of item.content || []) {
          if (c.type === 'output_text' && c.text) text += c.text;
          else if (c.type === 'refusal' && c.refusal) refusal += c.refusal;
        }
      }
      if (text) onText?.(text);
    }
    const reasoning = items.filter((i) => i?.type === 'reasoning' && i.encrypted_content).map(cleanReasoning);
    const calls = items.filter((i) => i?.type === 'function_call');

    /** @type {ContentBlock[]} */
    const content = [];
    const meta = reasoning.length ? { provider: 'openai', reasoning } : null;
    if (text || refusal) content.push(/** @type {any} */ ({ type: 'text', text: text || refusal, ...(meta && !calls.length ? { meta } : {}) }));
    calls.forEach((call, n) => {
      /** @type {any} */
      let input = {};
      let invalid = false;
      try { input = call.arguments ? JSON.parse(call.arguments) : {}; } catch { invalid = true; }
      /** @type {any} */
      const block = { type: 'tool_use', id: call.call_id || `call_${Date.now().toString(36)}_${n + 1}`, name: call.name, input, meta: { provider: 'openai', callId: call.call_id, ...(n === 0 && meta ? { reasoning } : {}) } };
      if (invalid) Object.defineProperty(block, 'invalidJson', { value: true, enumerable: false });
      content.push(block);
    });
    const reason = final?.incomplete_details?.reason;
    const stopReason = calls.length ? 'tool_use'
      : reason === 'max_output_tokens' ? 'max_tokens'
        : reason === 'content_filter' || (refusal && !text) ? 'refusal' : 'end_turn';
    return { stopReason, usage, content, droppedComputer: converted.dropped, droppedFormat, model };
  }

  /** @param {import('./types').JsonRequest} req */
  async function json(req) {
    const result = await streamMessage({
      apiKey: req.apiKey, model: req.model, system: req.system, maxTokens: req.maxTokens || 700, effort: req.effort, signal: req.signal,
      messages: [{ role: 'user', content: req.prompt }],
      format: req.schema,
      stream: false,
      maxRetries: req.maxRetries,
      onRetry: req.onRetry,
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

module.exports = { createOpenAiResponsesClient, toResponsesInput, toResponsesTools, effortCandidates };
