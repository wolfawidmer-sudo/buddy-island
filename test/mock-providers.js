// Simulierte KI-Anbieter für Tests. Jeder spricht sein eigenes Protokoll und prüft so streng
// wie die echte API: Rollenfolge, passende Werkzeug-IDs, fremde Felder, Gemini-3-Signaturen,
// Claude-Denk-Blöcke, OpenAI-Streaming-Sperre. Antworten kommen aus einem kleinen «Gehirn».

const enc = new TextEncoder();
const GOOD_KEY = { anthropic: 'sk-ant-good', openai: 'sk-good', xai: 'xai-good', gemini: 'AIza-good' }; // pragma: allowlist secret
const MODELS = {
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-5', 'text-embedding-3-small'],
  xai: ['grok-4.3', 'grok-4.6'],
  gemini: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash'],
};

function streamOf(text) {
  const parts = text.match(/[\s\S]{1,17}/g) || [];
  return new ReadableStream({ start(ctl) { parts.forEach((p) => ctl.enqueue(enc.encode(p))); ctl.close(); } });
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const sseData = (chunks) => new Response(streamOf(chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')));
const sseEvents = (events) => new Response(streamOf(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')));

/**
 * Was würde ein Modell antworten? Arbeitet auf einer einheitlichen Sicht der Unterhaltung.
 * @param {{ role: string, text: string, calls: any[], results: any[] }[]} conv
 */
function brain(conv, { tools, format }) {
  const last = conv[conv.length - 1];
  if (format) {
    if (format.properties?.komplexitaet) {
      return { text: JSON.stringify({ komplexitaet: 'einfach', reasoning: 'niedrig', schritte: 1, faehigkeiten: ['gespraech'], risiko: 'niedrig', risiken: [], tokens: 50, modell: 'haiku', aufwand: 'low', begruendung: 'Kurze Frage' }) };
    }
    return { text: '{"ok": true}' };
  }
  if (last.results.length) return { text: `Results: ${last.results.map((r) => r.text).join(', ')}` };
  if (tools && /get_number/.test(last.text)) {
    if (/identical twice/.test(last.text)) return { calls: [{ name: 'get_number', args: { key: 'a' } }, { name: 'get_number', args: { key: 'a' } }] };
    if (/twice in parallel/.test(last.text)) return { calls: [{ name: 'get_number', args: { key: 'a' } }, { name: 'get_number', args: { key: 'b' } }] };
    return { calls: [{ name: 'get_number', args: { key: 'a' } }] };
  }
  if (/codeword\?/.test(last.text)) return { text: conv.some((m) => /APFEL/.test(m.text)) ? 'APFEL' : 'unknown' };
  if (/Reply with OK/.test(last.text)) return { text: 'OK' };
  return { text: 'Hallo! Wie kann ich helfen?' };
}

function createMock(provider, opts = {}) {
  const state = { requests: [], failOnce: { ...(opts.failOnce || {}) }, issued: new Map(), thinkingSigs: new Set() };
  // opts.models: andere Modellliste; opts.retired: steht in der Liste, liefert aber 404 (abgeschaltet)
  const list = opts.models || MODELS[provider];
  const isModel = (m) => list.includes(String(m).replace(/^models\//, '')) && !(opts.retired || []).includes(String(m).replace(/^models\//, ''));
  let seq = 0;

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const headers = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ url, path: u.pathname, body, headers });
    if (opts.hang) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (state.failOnce.network) { state.failOnce.network -= 1; throw new TypeError('fetch failed'); }
    if (state.failOnce.rate) {
      state.failOnce.rate -= 1;
      if (provider === 'anthropic') return json({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }, 429);
      if (provider === 'gemini') return json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 429);
      return json({ error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, 429);
    }
    // opts.busy: diese Modelle sind gerade überlastet (wie Gemini «high demand», 503)
    const asked = provider === 'gemini' ? (u.pathname.split('/models/')[1] || '').split(':')[0] : body?.model;
    if ((opts.busy || []).includes(asked) && /generateContent|messages|chat\/completions|responses/.test(u.pathname)) {
      state.busyHits = (state.busyHits || 0) + 1;
      if (provider === 'gemini') return json({ error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } }, 503);
      if (provider === 'anthropic') return json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529);
      return json({ error: { message: 'The server is overloaded', type: 'server_error' } }, 503);
    }
    if (provider === 'anthropic') return anthropic(u, headers, body);
    if (provider === 'gemini') return gemini(u, headers, body);
    return openaiLike(u, headers, body);
  }

  // ---------- Anthropic Messages API ----------
  function anthropic(u, headers, body) {
    // Aktuell: Authorization: Bearer <key>; x-api-key ist die ältere, weiter gültige Form
    if (headers['x-api-key'] !== GOOD_KEY.anthropic && headers.authorization !== `Bearer ${GOOD_KEY.anthropic}`) return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    if (u.pathname.endsWith('/models')) return json({ data: list.map((id) => ({ id, display_name: id })) });
    if (!isModel(body.model)) return json({ type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` } }, 404);
    const msgs = body.messages;
    if (!msgs.length || msgs[0].role !== 'user') return json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: first message must use the "user" role' } }, 400);
    const conv = [];
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      if (i && msgs[i - 1].role === m.role) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: roles must alternate between "user" and "assistant"' } }, 400);
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      for (const [j, b] of blocks.entries()) {
        const allowed = { text: ['type', 'text', 'citations', 'cache_control'], tool_use: ['type', 'id', 'name', 'input', 'cache_control'], tool_result: ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], thinking: ['type', 'thinking', 'signature'], image: ['type', 'source', 'cache_control'] }[b.type];
        const extra = allowed && Object.keys(b).find((k) => !allowed.includes(k));
        if (!allowed || extra) return json({ type: 'error', error: { type: 'invalid_request_error', message: `messages.${i}.content.${j}.${extra || 'type'}: Extra inputs are not permitted` } }, 400);
      }
      const calls = blocks.filter((b) => b.type === 'tool_use');
      if (calls.length) {
        // Mit Denken: der Denk-Block mit Signatur muss unverändert zurückkommen
        const th = blocks.find((b) => b.type === 'thinking');
        if (!th || !state.thinkingSigs.has(th.signature)) return json({ type: 'error', error: { type: 'invalid_request_error', message: `messages.${i}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${blocks[0].type}\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.` } }, 400);
        const next = msgs[i + 1];
        const ids = new Set((Array.isArray(next?.content) ? next.content : []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
        if (calls.some((c) => !ids.has(c.id))) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: `tool_use` ids were found without `tool_result` blocks immediately after' } }, 400);
      }
      conv.push({ role: m.role, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' '), calls, results: blocks.filter((b) => b.type === 'tool_result').map((b) => ({ text: typeof b.content === 'string' ? b.content : b.content.map((x) => x.text).join('') })) });
    }
    const format = body.output_config?.format?.schema;
    const out = brain(conv, { tools: Boolean(body.tools?.length), format });
    const content = [];
    if (out.calls) {
      const sig = `sig_${++seq}`;
      state.thinkingSigs.add(sig);
      content.push({ type: 'thinking', thinking: 'Ich rufe das Werkzeug.', signature: sig });
      for (const c of out.calls) content.push({ type: 'tool_use', id: `toolu_${++seq}`, name: c.name, input: c.args });
    } else {
      content.push({ type: 'text', text: out.text });
    }
    const stop = out.calls ? 'tool_use' : 'end_turn';
    const usage = { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    if (body.stream === false) return json({ id: 'msg', type: 'message', role: 'assistant', content, stop_reason: stop, usage });
    const ev = [['message_start', { message: { usage } }]];
    content.forEach((b, i) => {
      if (b.type === 'text') {
        ev.push(['content_block_start', { index: i, content_block: { type: 'text', text: '' } }]);
        for (const piece of b.text.match(/.{1,4}/g)) ev.push(['content_block_delta', { index: i, delta: { type: 'text_delta', text: piece } }]);
      } else if (b.type === 'thinking') {
        ev.push(['content_block_start', { index: i, content_block: { type: 'thinking', thinking: '' } }]);
        ev.push(['content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: b.thinking } }]);
        ev.push(['content_block_delta', { index: i, delta: { type: 'signature_delta', signature: b.signature } }]);
      } else {
        ev.push(['content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
        ev.push(['content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }]);
      }
      ev.push(['content_block_stop', { index: i }]);
    });
    ev.push(['message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 5 } }], ['message_stop', {}]);
    return sseEvents(ev);
  }

  // ---------- OpenAI / xAI Chat Completions ----------
  function openaiLike(u, headers, body) {
    if (headers.authorization !== `Bearer ${GOOD_KEY[provider]}`) return json({ error: { message: 'Incorrect API key provided: sk-…', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);
    if (u.pathname.endsWith('/models')) return json({ object: 'list', data: list.map((id) => ({ id, object: 'model' })) });
    if (!isModel(body.model)) return json({ error: { message: `The model \`${body.model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } }, 404);
    if (opts.verifyStream && body.stream) return json({ error: { message: 'Your organization must be verified to stream this model. Please go to: https://platform.openai.com/settings/organization/general', type: 'invalid_request_error', param: 'stream', code: 'unsupported_value' } }, 400);
    if (provider === 'openai' && 'max_tokens' in body && /gpt-5/.test(body.model)) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens' } }, 400);
    const msgs = body.messages;
    const conv = [];
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const following = [];
        for (let k = i + 1; k < msgs.length && msgs[k].role === 'tool'; k += 1) following.push(msgs[k].tool_call_id);
        const missing = m.tool_calls.find((c) => !following.includes(c.id));
        if (missing) return json({ error: { message: `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${missing.id}`, type: 'invalid_request_error', param: 'messages' } }, 400);
      }
      if (m.role === 'tool') {
        const prev = conv[conv.length - 1];
        if (prev?.role === 'tool') { prev.results.push({ text: m.content }); continue; }
        conv.push({ role: 'tool', text: '', calls: [], results: [{ text: m.content }] });
        continue;
      }
      if (m.role === 'system') continue;
      const text = typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
      conv.push({ role: m.role, text: text || '', calls: m.tool_calls || [], results: [] });
    }
    const format = body.response_format?.json_schema?.schema;
    const out = brain(conv, { tools: Boolean(body.tools?.length), format });
    const toolCalls = (out.calls || []).map((c) => ({ id: `call_${++seq}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    const finish = toolCalls.length ? 'tool_calls' : 'stop';
    const usage = { prompt_tokens: 30, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 0 } };
    if (!body.stream) return json({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: out.text || null, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: finish }], usage });
    const chunks = [];
    if (out.text) for (const piece of out.text.match(/.{1,4}/g)) chunks.push({ choices: [{ index: 0, delta: { content: piece } }] });
    toolCalls.forEach((tc, index) => {
      chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] } }] });
      chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: tc.function.arguments } }] } }] });
    });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    if (body.stream_options?.include_usage) chunks.push({ choices: [], usage });
    chunks.push('[DONE]');
    return sseData(chunks);
  }

  // ---------- Gemini generateContent ----------
  function gemini(u, headers, body) {
    const err = (code, status, message, reason) => json({ error: { code, message, status, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } }, code);
    if (headers['x-goog-api-key'] !== GOOD_KEY.gemini) return err(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID');
    if (u.pathname.endsWith('/models')) return json({ models: [...list.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent', 'countTokens'] })), { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] });
    const m = /\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(u.pathname);
    if (!m) return err(404, 'Not Found', 'NOT_FOUND');
    const model = decodeURIComponent(m[1]);
    const streaming = m[2] === 'streamGenerateContent';
    if (streaming && u.searchParams.get('alt') !== 'sse') return err(400, 'alt=sse expected in this mock', 'INVALID_ARGUMENT');
    if (!isModel(model)) return err(404, `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, 'NOT_FOUND');
    const gemini3 = /gemini-3/.test(model);
    const contents = body.contents || [];
    const known = new Set(['text', 'inlineData', 'functionCall', 'functionResponse', 'thoughtSignature', 'thought']);
    // Aktueller Zug: ab der letzten Nutzer-Nachricht mit Text (nicht nur Funktionsantworten)
    let turnStart = 0;
    contents.forEach((c, i) => { if (c.role === 'user' && c.parts.some((p) => typeof p.text === 'string')) turnStart = i; });
    const conv = [];
    for (let i = 0; i < contents.length; i += 1) {
      const c = contents[i];
      if (!['user', 'model'].includes(c.role)) return err(400, `Please use a valid role: user, model.`, 'INVALID_ARGUMENT');
      for (const p of c.parts) {
        const extra = Object.keys(p).find((k) => !known.has(k));
        if (extra) return err(400, `Invalid JSON payload received. Unknown name "${extra}" at 'contents[${i}].parts[0]': Cannot find field.`, 'INVALID_ARGUMENT');
      }
      const calls = c.parts.filter((p) => p.functionCall);
      if (calls.length) {
        if (gemini3 && i >= turnStart) {
          const sig = calls[0].thoughtSignature;
          const ok = sig === 'skip_thought_signature_validator' || state.issued.has(sig);
          if (!ok) return err(400, `Function call \`${calls[0].functionCall.name}\` in the \`${i + 1}.\` content block is missing a \`thought_signature\`.`, 'INVALID_ARGUMENT');
          if (calls.slice(1).some((p) => p.thoughtSignature && p.thoughtSignature !== 'skip_thought_signature_validator')) return err(400, 'Only the first function call of a step may carry a thought_signature.', 'INVALID_ARGUMENT');
        }
        const next = contents[i + 1];
        const responses = (next?.parts || []).filter((p) => p.functionResponse);
        if (responses.length !== calls.length) return err(400, 'Please ensure that the number of function response parts is equal to the number of function call parts of the function call turn.', 'INVALID_ARGUMENT');
      }
      conv.push({ role: c.role, text: c.parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join(' '), calls, results: c.parts.filter((p) => p.functionResponse).map((p) => ({ text: p.functionResponse.response.result ?? p.functionResponse.response.error })) });
    }
    const gc = body.generationConfig || {};
    if (gc.responseJsonSchema && gc.responseSchema) return err(400, 'responseJsonSchema and responseSchema are mutually exclusive', 'INVALID_ARGUMENT');
    const out = brain(conv, { tools: Boolean(body.tools?.[0]?.functionDeclarations?.length), format: gc.responseJsonSchema || gc.responseSchema });
    const parts = [];
    if (out.calls) {
      const sig = `gsig_${++seq}`;
      state.issued.set(sig, true);
      out.calls.forEach((c, i) => parts.push(i === 0 ? { functionCall: { name: c.name, args: c.args }, thoughtSignature: sig } : { functionCall: { name: c.name, args: c.args } }));
    }
    const usageMetadata = { promptTokenCount: 40, candidatesTokenCount: 6, thoughtsTokenCount: 3, totalTokenCount: 49 };
    if (!streaming) {
      if (out.text) parts.push({ text: out.text, ...(gemini3 ? { thoughtSignature: `tsig_${++seq}` } : {}) });
      return json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata });
    }
    const chunks = [];
    if (out.text) for (const piece of out.text.match(/.{1,4}/g)) chunks.push({ candidates: [{ content: { role: 'model', parts: [{ text: piece }] } }] });
    if (parts.length) chunks.push({ candidates: [{ content: { role: 'model', parts } }] });
    // Signatur kann an einem leeren Textstück am Schluss hängen
    chunks.push({ candidates: [{ content: { role: 'model', parts: [{ text: '', ...(gemini3 && out.text ? { thoughtSignature: `tsig_${++seq}` } : {}) }] }, finishReason: 'STOP' }], usageMetadata });
    return sseData(chunks);
  }

  return { fetchImpl, state };
}

module.exports = { createMock, GOOD_KEY, MODELS };
