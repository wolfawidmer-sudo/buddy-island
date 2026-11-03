// @ts-check
// Nativer Adapter für die Gemini API (generateContent / streamGenerateContent, v1beta).
// Nicht über die OpenAI-kompatible Schicht: Gemini 3 verlangt, dass die thoughtSignature
// jedes Funktionsaufrufs unverändert zurückkommt, sonst lehnt es die Fortsetzung mit 400 ab.
// Die Signatur wird darum am Block gespeichert (meta.thoughtSignature) und wieder mitgeschickt.

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

const NAME = 'Gemini';
const RETRY_DELAYS = [1500, 4000, 10000];
// Für Aufrufe, die nicht von Gemini selbst stammen (z. B. nach einem Anbieterwechsel), laut Google erlaubt
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

/** @param {ProviderInfo} provider */
function baseUrl(provider) {
  const override = process.env.BUDDY_GEMINI_BASE;
  if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(override)) return override.replace(/\/$/, '');
  return provider.baseUrl;
}

/** «models/gemini-x» und «gemini-x» sind dasselbe @param {string} model */
const bareModel = (model) => String(model || '').replace(/^models\//, '');

/**
 * JSON-Schema auf die OpenAPI-Teilmenge von «parameters» kürzen (nur als Ausweichweg,
 * falls parametersJsonSchema vom Modell nicht unterstützt wird).
 * @param {any} schema
 * @returns {any}
 */
function toOpenApiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toOpenApiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const allowed = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'propertyOrdering']);
  /** @type {any} */
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!allowed.has(k)) continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, toOpenApiSchema(pv)]));
    else if (k === 'items' || k === 'anyOf') out[k] = toOpenApiSchema(v);
    else out[k] = v;
  }
  return out;
}

/**
 * Buddys Nachrichten → Gemini «contents». Werkzeug-Ergebnisse brauchen den Funktionsnamen,
 * darum werden die Aufrufe vorher nach ID gesammelt.
 * @param {Message[]} messages @param {{ vision: boolean }} caps
 * @param {{ dummySignature?: boolean }} [opts] Ersatz-Signatur für fremde Aufrufe (nur ab Gemini 3 nötig)
 */
function toContents(messages, caps, { dummySignature = true } = {}) {
  /** @type {Map<string, string>} */
  const nameById = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') nameById.set(b.id, b.name);
    }
  }
  /** @type {{role: 'user'|'model', parts: any[]}[]} */
  const contents = [];
  /** @param {'user'|'model'} role @param {any[]} parts */
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); // Gemini erwartet abwechselnde Rollen
    else contents.push({ role, parts });
  };
  /** @param {any} img */
  const imagePart = (img) => (caps.vision
    ? { inlineData: { mimeType: img.source.media_type, data: img.source.data } }
    : { text: '[Bild weggelassen: dieses Modell kann keine Bilder sehen]' });

  for (const m of messages) {
    if (typeof m.content === 'string') {
      push(m.role === 'assistant' ? 'model' : 'user', m.content ? [{ text: m.content }] : []);
      continue;
    }
    if (m.role === 'assistant') {
      /** @type {any[]} */
      const parts = [];
      let firstCall = true;
      for (const b of m.content) {
        if (b.type === 'text' && b.text) {
          /** @type {any} */
          const part = { text: b.text };
          if (b.meta?.provider === 'gemini' && b.meta.thoughtSignature) part.thoughtSignature = b.meta.thoughtSignature;
          parts.push(part);
        } else if (b.type === 'tool_use') {
          /** @type {any} */
          const part = { functionCall: { name: b.name, args: b.input || {} } };
          if (b.meta?.provider === 'gemini' && b.meta.callId) part.functionCall.id = b.meta.callId;
          const sig = b.meta?.provider === 'gemini' ? b.meta.thoughtSignature : undefined;
          // Nur der erste Aufruf eines Schritts trägt die Signatur (parallele Aufrufe: keine weitere)
          if (sig) part.thoughtSignature = sig;
          else if (firstCall && dummySignature) part.thoughtSignature = SKIP_SIGNATURE;
          firstCall = false;
          parts.push(part);
        }
        // «thinking»-Blöcke anderer Anbieter werden nicht übertragen
      }
      push('model', parts);
      continue;
    }
    // Nutzer: Funktionsantworten zuerst (direkt nach den Aufrufen), dann Text und Bilder
    /** @type {any[]} */
    const responses = [];
    /** @type {any[]} */
    const rest = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const blocks = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content || [];
        const text = blocks.filter((x) => x.type === 'text').map((x) => /** @type {any} */ (x).text).join('\n');
        const name = nameById.get(b.tool_use_id) || 'tool';
        /** @type {any} */
        const fr = { name, response: b.is_error ? { error: text || 'Fehler' } : { result: text || 'OK' } };
        responses.push({ functionResponse: fr });
        for (const img of blocks.filter((x) => x.type === 'image')) rest.push(imagePart(img));
      } else if (b.type === 'text' && b.text) {
        rest.push({ text: b.text });
      } else if (b.type === 'image') {
        rest.push(imagePart(b));
      }
    }
    push('user', [...responses, ...rest]);
  }
  return contents;
}

/** @param {Tool[]|undefined} tools @param {boolean} jsonSchema */
function toFunctionDeclarations(tools, jsonSchema) {
  const decls = [];
  let dropped = false;
  for (const tool of tools || []) {
    if ('name' in tool && tool.name) {
      const schema = tool.input_schema || { type: 'object', properties: {} };
      decls.push(jsonSchema
        ? { name: tool.name, description: tool.description || '', parametersJsonSchema: schema }
        : { name: tool.name, description: tool.description || '', parameters: toOpenApiSchema(schema) });
    } else {
      dropped = true; // Anbieter-eigene Werkzeuge (Claude Computer Use) gibt es hier nicht
    }
  }
  return { decls, dropped };
}

/** Gemini 3 und neuer (thinkingLevel statt thinkingBudget) @param {string} model */
const isGemini3 = (model) => /gemini-([3-9]|\d{2})/i.test(model);

/**
 * Buddys Aufwand → Gemini-3-Denkstufe. Flash und Flash-Lite können «minimal» (am schnellsten),
 * Pro beginnt bei «low». Ohne Aufwand (Auto bei manueller Modellwahl): «low».
 * @param {string} model @param {string|null|undefined} effort
 */
function thinkingLevelFor(model, effort) {
  const pro = /pro/i.test(model) && !/flash/i.test(model);
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return 'high';
  if (effort === 'medium') return 'medium';
  if (effort === 'low') return pro ? 'low' : 'minimal';
  return 'low';
}

/** @param {string|undefined} reason @param {boolean} hasCalls */
function mapFinish(reason, hasCalls) {
  if (hasCalls) return 'tool_use';
  switch (reason) {
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY': case 'RECITATION': case 'BLOCKLIST': case 'PROHIBITED_CONTENT': case 'SPII': case 'IMAGE_SAFETY': return 'refusal';
    default: return 'end_turn';
  }
}

/**
 * @param {{ provider: ProviderInfo, fetchImpl?: typeof fetch, connectTimeoutMs?: number, idleTimeoutMs?: number }} opts
 * @returns {LlmClient}
 */
function createGeminiClient({ provider, fetchImpl = globalThis.fetch, connectTimeoutMs = 45000, idleTimeoutMs = 90000 }) {
  const base = () => baseUrl(provider);
  /** @param {string} apiKey */
  const headers = (apiKey) => ({ 'x-goog-api-key': apiKey, 'content-type': 'application/json' });

  /** @param {Response} response @param {any} ctx */
  async function toError(response, ctx) {
    let raw = '';
    let type = '';
    try {
      const json = await response.json();
      const e = Array.isArray(json) ? json[0]?.error : json?.error;
      raw = e?.message || '';
      const reason = (e?.details || []).map((/** @type {any} */ d) => d?.reason).find(Boolean);
      type = reason || e?.status || '';
    } catch { /* kein JSON */ }
    const err = new ProviderError(response.status, raw, String(type), NAME, { providerId: 'gemini', apiVersion: 'v1beta', ...ctx });
    const after = Number(response.headers?.get?.('retry-after'));
    if (Number.isFinite(after) && after > 0) err.retryAfterMs = Math.min(20000, after * 1000);
    return err;
  }

  /** @param {string} apiKey */
  async function listModels(apiKey) {
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), 20000);
    const url = `${base()}/models?pageSize=1000`;
    let response;
    try {
      response = await fetchImpl(url, { headers: headers(apiKey), signal: local.signal });
    } catch {
      throw new ProviderError(0, '', local.signal.aborted ? 'timeout_error' : '', NAME, { providerId: 'gemini', endpoint: url, stage: 'models' });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await toError(response, { endpoint: url, stage: 'models' });
    const json = await response.json();
    return (json.models || [])
      // Nur Modelle, die Text erzeugen können (keine Embeddings, TTS, Live-Modelle)
      .filter((/** @type {any} */ m) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((/** @type {any} */ m) => {
        const id = bareModel(m.name);
        return { id, name: m.displayName || models.info(id).name };
      })
      .filter((/** @type {{id: string}} */ m) => m.id);
  }

  /**
   * Ein Versuch mit Zeitlimit bis zur ersten Antwort.
   * @param {string} url @param {string} apiKey @param {any} body @param {AbortSignal|undefined} signal @param {string} model
   */
  async function postOnce(url, apiKey, body, signal, model) {
    const local = new AbortController();
    const onAbort = () => local.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; local.abort(); }, connectTimeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal: local.signal });
      return { response, local, cleanup: () => signal?.removeEventListener('abort', onAbort) };
    } catch (err) {
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) throw new ProviderError(0, '', 'timeout_error', NAME, { providerId: 'gemini', model, endpoint: url, stage: 'connect' });
      if (signal?.aborted || /** @type {any} */ (err)?.name === 'AbortError') throw abortError();
      throw new ProviderError(0, '', '', NAME, { providerId: 'gemini', model, endpoint: url, stage: 'connect' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {string} url @param {string} apiKey @param {any} body @param {AbortSignal|undefined} signal @param {StreamRequest['onRetry']} onRetry @param {string} model */
  async function post(url, apiKey, body, signal, onRetry, model) {
    for (let attempt = 0; ; attempt += 1) {
      let result;
      try {
        result = await postOnce(url, apiKey, body, signal, model);
      } catch (err) {
        if (/** @type {any} */ (err)?.name === 'AbortError' || !isRetryable(err) || attempt >= RETRY_DELAYS.length) throw err;
        onRetry?.(attempt + 1, /** @type {Error} */ (err));
        await wait(RETRY_DELAYS[attempt], signal);
        continue;
      }
      const { response } = result;
      if (response.ok || !RETRY_STATUS.has(response.status) || attempt >= RETRY_DELAYS.length) return result;
      const err = await toError(response, { model, endpoint: url });
      result.cleanup();
      // Aufgebrauchtes Kontingent wird durch Warten nicht besser
      if (err.category === 'quota') throw err;
      onRetry?.(attempt + 1, err);
      await wait(err.retryAfterMs || RETRY_DELAYS[attempt], signal);
    }
  }

  /** @param {StreamRequest} req @returns {Promise<StreamResult>} */
  async function streamMessage(req) {
    const { apiKey, system, messages, tools, maxTokens, effort, format, signal, onText, onRetry } = req;
    const model = bareModel(req.model);
    const info = models.info(model);
    const caps = info.caps;
    const streaming = req.stream !== false;
    let jsonSchemaTools = true;
    const toolSet = () => toFunctionDeclarations(caps.tools ? tools : [], jsonSchemaTools);

    // Denken zählt bei Gemini zu maxOutputTokens: bei «low» auf Flash-Modellen aus, bei Pro mehr Platz
    const isPro = /pro/i.test(model);
    /** @type {any} */
    const generationConfig = { maxOutputTokens: isPro ? maxTokens + 4096 : maxTokens };
    const gen3 = isGemini3(model);
    if (gen3) {
      // Ohne Angabe denkt Gemini 3 auf «high» und braucht dann für ein «Hallo» schnell 30 Sekunden.
      generationConfig.thinkingConfig = { thinkingLevel: thinkingLevelFor(model, effort) };
    } else if (effort === 'low' && /flash/i.test(model)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    if (format) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = format;
    }
    /** @type {any} */
    const body = { contents: toContents(messages, caps, { dummySignature: !/gemini-(1|2)(\.|-)/i.test(model) }), generationConfig };
    if (system && system.trim()) body.systemInstruction = { parts: [{ text: system.trim() }] };
    let converted = toolSet();
    if (converted.decls.length) body.tools = [{ functionDeclarations: converted.decls }];

    let droppedFormat = false;
    // Optionale Teile, die nicht jedes Modell kennt: bei 400 gezielt anpassen und nochmals
    const optional = [
      { test: /parametersJsonSchema|parameters_json_schema/i, apply: () => { if (!jsonSchemaTools) return false; jsonSchemaTools = false; converted = toolSet(); body.tools = [{ functionDeclarations: converted.decls }]; return true; } },
      { test: /responseJsonSchema|response_json_schema/i, apply: () => { if (!generationConfig.responseJsonSchema) return false; generationConfig.responseSchema = toOpenApiSchema(generationConfig.responseJsonSchema); delete generationConfig.responseJsonSchema; return true; } },
      { test: /responseSchema|response_schema|response_mime_type|responseMimeType/i, apply: () => { if (!generationConfig.responseMimeType) return false; delete generationConfig.responseSchema; delete generationConfig.responseJsonSchema; delete generationConfig.responseMimeType; droppedFormat = true; return true; } },
      {
        test: /thinking/i,
        apply: () => {
          const tc = generationConfig.thinkingConfig;
          if (!tc) return false;
          // «minimal» kennt nicht jedes Modell (z. B. Pro): eine Stufe höher versuchen, erst dann weglassen
          if (tc.thinkingLevel === 'minimal') { tc.thinkingLevel = 'low'; return true; }
          delete generationConfig.thinkingConfig;
          return true;
        },
      },
    ];
    const url = streaming ? `${base()}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse` : `${base()}/models/${encodeURIComponent(model)}:generateContent`;
    const ctx = { model, endpoint: url };

    let attempt = await post(url, apiKey, body, signal, onRetry, model);
    for (let n = 0; attempt.response.status === 400 && n < optional.length; n += 1) {
      const err = await toError(attempt.response, ctx);
      attempt.cleanup();
      const fix = optional.find((o) => o.test.test(err.raw) && o.apply());
      if (!fix) throw err;
      attempt = await post(url, apiKey, body, signal, onRetry, model);
    }
    if (!attempt.response.ok) {
      attempt.cleanup();
      throw await toError(attempt.response, ctx);
    }

    const { response, local } = attempt;
    let text = '';
    /** @type {string|undefined} */
    let textSignature;
    /** @type {{name: string, args: any, id?: string, signature?: string}[]} */
    const calls = [];
    /** @type {string|undefined} */
    let finish;
    /** @type {string|undefined} */
    let blocked;
    /** @type {Usage} */
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    /** Ein Antwortstück (beim Streaming viele, sonst eines) @param {any} data */
    const consume = (data) => {
      if (data?.error) throw new ProviderError(Number(data.error.code) || 0, data.error.message || 'Stream-Fehler', data.error.status || '', NAME, { providerId: 'gemini', ...ctx, stage: 'stream' });
      if (data?.promptFeedback?.blockReason) blocked = data.promptFeedback.blockReason;
      if (data?.usageMetadata) {
        const u = data.usageMetadata;
        const cached = Number(u.cachedContentTokenCount) || 0;
        usage.input_tokens = Math.max(0, (Number(u.promptTokenCount) || 0) - cached);
        usage.cache_read_input_tokens = cached;
        usage.output_tokens = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
      }
      const cand = data?.candidates?.[0];
      if (!cand) return;
      for (const part of cand.content?.parts || []) {
        if (part.functionCall) {
          calls.push({ name: part.functionCall.name, args: part.functionCall.args || {}, id: part.functionCall.id, signature: part.thoughtSignature });
        } else if (typeof part.text === 'string') {
          // Gedanken (thought: true) nicht anzeigen; die Signatur kann auch an leerem Text hängen
          if (part.thoughtSignature) textSignature = part.thoughtSignature;
          if (!part.thought && part.text) {
            text += part.text;
            onText?.(part.text);
          }
        } else if (part.thoughtSignature) {
          textSignature = part.thoughtSignature;
        }
      }
      if (cand.finishReason) finish = cand.finishReason;
    };

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
        for await (const { data } of parseSSE(/** @type {any} */ (response.body), kick)) consume(data);
      } catch (err) {
        if (idleHit) throw new ProviderError(0, '', 'timeout_error', NAME, { providerId: 'gemini', ...ctx, stage: 'stream' });
        if (signal?.aborted || /** @type {any} */ (err)?.name === 'AbortError') throw abortError();
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(0, '', '', NAME, { providerId: 'gemini', ...ctx, stage: 'stream' });
      } finally {
        clearTimeout(idle);
        attempt.cleanup();
      }
    } else {
      try {
        let data;
        try { data = await response.json(); } catch { throw new ProviderError(response.status, 'Antwort ist kein JSON', 'parse_error', NAME, { providerId: 'gemini', ...ctx, stage: 'parse' }); }
        consume(data);
      } finally {
        attempt.cleanup();
      }
    }

    if (blocked && !text && !calls.length) {
      throw new ProviderError(400, `Anfrage blockiert: ${blocked}`, 'SAFETY', NAME, { providerId: 'gemini', ...ctx, stage: 'request' });
    }
    if (finish === 'MALFORMED_FUNCTION_CALL' && !calls.length) {
      throw new ProviderError(400, 'Gemini hat einen ungültigen Funktionsaufruf erzeugt (MALFORMED_FUNCTION_CALL).', 'MALFORMED_FUNCTION_CALL', NAME, { providerId: 'gemini', ...ctx, stage: 'parse' });
    }

    /** @type {ContentBlock[]} */
    const content = [];
    if (text) content.push(textSignature ? { type: 'text', text, meta: { provider: 'gemini', thoughtSignature: textSignature } } : { type: 'text', text });
    calls.forEach((call, n) => {
      /** @type {any} */
      const block = { type: 'tool_use', id: call.id || `gem_${Date.now().toString(36)}_${n + 1}`, name: call.name, input: call.args };
      /** @type {any} */
      const meta = { provider: 'gemini' };
      if (call.signature) meta.thoughtSignature = call.signature;
      if (call.id) meta.callId = call.id;
      block.meta = meta;
      content.push(block);
    });
    return { stopReason: mapFinish(finish, calls.length > 0), usage, content, droppedComputer: converted.dropped, droppedFormat };
  }

  /** @param {import('./types').JsonRequest} req */
  async function json(req) {
    const result = await streamMessage({
      apiKey: req.apiKey, model: req.model, system: req.system, maxTokens: req.maxTokens || 700, effort: req.effort, signal: req.signal,
      messages: [{ role: 'user', content: req.prompt }],
      format: req.schema,
      stream: false,
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

  return { provider: 'gemini', listModels, streamMessage, json };
}

module.exports = { createGeminiClient, toContents, toFunctionDeclarations, toOpenApiSchema, mapFinish, thinkingLevelFor, isGemini3, SKIP_SIGNATURE };
