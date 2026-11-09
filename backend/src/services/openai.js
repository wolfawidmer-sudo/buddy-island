'use strict';
// OpenAI-Gateway für Buddy Cloud (Responses API).
// Ablauf je Anfrage: Modell prüfen → Kosten schätzen → Credits reservieren → an OpenAI →
// echte Nutzung lesen → in Postgres abrechnen (Anbieterkosten + 10 %) → Antwort zurück.
// Text, Streaming, Werkzeuge (function calling) und Bilder laufen unverändert durch,
// weil die App schon das Responses-Format spricht (src/llm/openai-responses.js).

const crypto = require('node:crypto');
const { AppError, badRequest, unavailable } = require('../lib/errors');
const { check } = require('../middleware/validation');

// Felder, die die App schicken darf. Alles andere wird abgelehnt (z. B. «user», «store: true»).
const RESPONSE_SCHEMA = {
  model: { type: 'string', required: true, min: 1, max: 100, pattern: /^[a-z0-9][a-z0-9._:-]*$/i },
  input: { type: 'string|array', required: true },
  instructions: { type: 'string', max: 200000, trim: false },
  tools: { type: 'array', max: 128 },
  tool_choice: { type: 'any' },
  parallel_tool_calls: { type: 'boolean' },
  max_output_tokens: { type: 'integer', min: 1, max: 1000000 },
  reasoning: { type: 'object' },
  include: { type: 'array', max: 4 },
  text: { type: 'object' },
  stream: { type: 'boolean' },
  store: { type: 'boolean' },
  temperature: { type: 'any' },
  top_p: { type: 'any' },
};
const ALLOWED_INCLUDE = new Set(['reasoning.encrypted_content']);

/** Nutzung aus einem Responses-Objekt */
function usageOf(resp) {
  const u = resp?.usage;
  if (!u || typeof u !== 'object') return null;
  const inputTokens = Math.max(0, Math.trunc(Number(u.input_tokens) || 0));
  const cachedTokens = Math.min(inputTokens, Math.max(0, Math.trunc(Number(u.input_tokens_details?.cached_tokens) || 0)));
  const outputTokens = Math.max(0, Math.trunc(Number(u.output_tokens) || 0));
  return { inputTokens, cachedTokens, outputTokens };
}

/** Fehler von OpenAI → Fehler für die App. 401/403 von OpenAI liegen an UNSEREM Key: nie als 401 weitergeben. */
function upstreamError(status, body) {
  const e = body?.error || {};
  const message = typeof e.message === 'string' ? e.message.slice(0, 500) : 'Fehler beim KI-Anbieter';
  if (status === 401 || status === 403) return new AppError(502, 'upstream_auth', 'Buddy Cloud ist gerade nicht verfügbar.');
  if (status === 429 && /quota|billing/.test(String(e.code || e.type || ''))) return new AppError(503, 'upstream_unavailable', 'Buddy Cloud ist gerade nicht verfügbar.', { retryAfter: 60 });
  if (status === 429) return new AppError(503, 'upstream_busy', 'Buddy Cloud ist gerade ausgelastet. Bitte gleich nochmals.', { retryAfter: 5 });
  if (status === 400 || status === 404 || status === 422) return new AppError(400, String(e.code || e.type || 'invalid_request'), message);
  return new AppError(502, 'upstream_error', 'Fehler beim KI-Anbieter.');
}

/** SSE-Ereignisse aus Bytes (für das Mitlesen der Nutzung, die Bytes gehen unverändert weiter) */
function createSseReader(onEvent) {
  let buffer = '';
  const decoder = new TextDecoder();
  return (chunk) => {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n|\r/g, '\n');
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { onEvent(JSON.parse(data)); } catch { /* kein JSON */ }
    }
  };
}

/**
 * @param {{ config: any, billing: any, logger: any, fetchImpl?: typeof fetch }} deps
 */
function createOpenAiGateway({ config, billing, logger, fetchImpl = globalThis.fetch }) {
  const oc = config.openai;

  async function prepare(user, rawBody) {
    if (!oc.apiKey) throw unavailable('Buddy Cloud ist noch nicht eingerichtet.', 'not_configured');
    const body = check(RESPONSE_SCHEMA, rawBody);
    if (body.store === true) throw badRequest('store ist in Buddy Cloud nicht erlaubt');
    if (body.include && !body.include.every((x) => ALLOWED_INCLUDE.has(x))) throw badRequest('include enthält nicht erlaubte Werte');
    if (!(await billing.isAllowed(body.model))) throw new AppError(400, 'model_not_available', 'Dieses Modell ist in Buddy Cloud nicht verfügbar.');
    const maxOut = Math.min(body.max_output_tokens || oc.defaultOutputTokens, oc.maxOutputTokens);
    const estIn = billing.estimateInputTokens({ input: body.input, instructions: body.instructions, tools: body.tools });
    if (estIn > oc.maxInputTokensEstimate) throw new AppError(413, 'context_too_long', 'Die Unterhaltung ist zu lang für Buddy Cloud. Bitte neu beginnen.');
    const q = await billing.quote(body.model, estIn, 0, maxOut);
    const requestId = billing.newRequestId();
    const reservation = await billing.reserve({ userId: user.id, requestId, model: body.model, credits: q.credits });
    const upstream = {
      ...body,
      store: false,
      max_output_tokens: maxOut,
      // Pseudonym für den Missbrauchsschutz bei OpenAI (keine E-Mail, keine echte ID)
      safety_identifier: crypto.createHash('sha256').update(`buddy:${user.id}`).digest('hex').slice(0, 32),
    };
    return { body: upstream, requestId, estIn, reservation };
  }

  async function post(body, signal) {
    try {
      return await fetchImpl(`${oc.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oc.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      logger.warn('openai_unreachable', { error: err });
      throw unavailable('Der KI-Anbieter ist gerade nicht erreichbar.');
    }
  }

  /**
   * @param {{ id: string }} user @param {any} rawBody
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   */
  async function responses(user, rawBody, req, res) {
    const { body, requestId, estIn } = await prepare(user, rawBody);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), oc.timeoutMs);
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) { clientGone = true; controller.abort(); } });

    let upstream;
    try {
      upstream = await post(body, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      await billing.release(requestId, clientGone ? 'released' : 'failed', clientGone ? 'Abgebrochen' : 'Anbieter nicht erreichbar');
      throw err;
    }

    if (!upstream.ok) {
      clearTimeout(timer);
      const errBody = await upstream.json().catch(() => ({}));
      await billing.release(requestId, 'failed', `OpenAI ${upstream.status}`);
      logger[upstream.status === 429 && /quota|billing/.test(String(errBody?.error?.code || errBody?.error?.type)) ? 'error' : 'warn']('openai_error', { requestId, status: upstream.status, openaiCode: errBody?.error?.code || errBody?.error?.type });
      throw upstreamError(upstream.status, errBody);
    }

    // ---- ohne Streaming ----
    if (!body.stream) {
      let data;
      try {
        data = await upstream.json();
      } catch (err) {
        clearTimeout(timer);
        await billing.release(requestId, clientGone ? 'released' : 'failed', 'Antwort unvollständig');
        if (clientGone) return;
        throw new AppError(502, 'upstream_error', 'Fehler beim KI-Anbieter.');
      }
      clearTimeout(timer);
      const usage = usageOf(data);
      const settled = usage
        ? await billing.settle(requestId, usage)
        : (await billing.release(requestId, 'failed', 'Keine Nutzungsangabe'), null);
      if (!usage) logger.error('openai_missing_usage', { requestId });
      if (clientGone || res.headersSent) return;
      const text = JSON.stringify(data);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'x-buddy-request-id': requestId,
        ...(settled ? { 'x-buddy-credits-charged': String(settled.credits) } : {}),
      });
      res.end(text);
      return;
    }

    // ---- Streaming: Bytes unverändert durchreichen, Nutzung mitlesen ----
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-buddy-request-id': requestId,
    });
    /** @type {any} */
    let finalResponse = null;
    let streamedChars = 0;
    let streamError = '';
    const read = createSseReader((ev) => {
      if ((ev?.type === 'response.completed' || ev?.type === 'response.incomplete' || ev?.type === 'response.failed') && ev.response) finalResponse = ev.response;
      if (typeof ev?.delta === 'string') streamedChars += ev.delta.length;
      const err = ev?.type === 'error' ? (ev.error || ev) : ev?.type === 'response.failed' ? ev.response?.error : null;
      if (err) streamError = String(err.code || err.type || 'unknown');
    });
    try {
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        read(value);
        if (clientGone) { reader.cancel().catch(() => {}); break; }
        res.write(value);
      }
    } catch (err) {
      if (!clientGone) logger.warn('openai_stream_broken', { requestId, error: err });
    } finally {
      clearTimeout(timer);
    }

    // Fehler mitten im Stream (z. B. OpenAI-Guthaben leer) laut loggen: der Nutzer kann nichts dafür
    if (streamError) logger[/quota|billing/.test(streamError) ? 'error' : 'warn']('openai_stream_error', { requestId, openaiCode: streamError });
    let settled = null;
    const usage = usageOf(finalResponse);
    try {
      if (usage) {
        settled = await billing.settle(requestId, usage);
      } else if (streamedChars > 0) {
        // Abgebrochen ohne Nutzungsangabe: OpenAI rechnet trotzdem ab. Schätzung:
        // geschätzte Eingabe + gestreamte Zeichen / 3 (eher zu wenig als zu viel).
        settled = await billing.settle(requestId, { inputTokens: estIn, cachedTokens: 0, outputTokens: Math.ceil(streamedChars / 3) });
        logger.warn('settled_with_estimate', { requestId, clientGone });
      } else {
        await billing.release(requestId, clientGone ? 'released' : 'failed', clientGone ? 'Abgebrochen' : 'Stream ohne Ergebnis');
      }
    } catch (err) {
      logger.error('settle_failed', { requestId, error: err });
    }
    if (!clientGone && !res.writableEnded) {
      if (settled) res.write(`event: buddy.billing\ndata: ${JSON.stringify({ type: 'buddy.billing', request_id: requestId, credits_charged: settled.credits, status: settled.status })}\n\n`);
      res.end();
    }
  }

  return { responses, prepare };
}

module.exports = { createOpenAiGateway, usageOf, upstreamError, createSseReader, RESPONSE_SCHEMA };
