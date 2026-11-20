'use strict';
// Buddy Live: Gespräch in Echtzeit. Die App verbindet sich per WebSocket mit diesem Backend,
// das Backend leitet an die OpenAI Realtime API weiter (Relay). Der OpenAI-Key bleibt hier.
//
// Ablauf (Sicherheitsregeln 9 und 10):
//   1. POST /v1/cloud/realtime/sessions (normale Anmeldung) → kurzlebiges Ticket (60 s, einmalig).
//      Dabei wird schon der erste Abschnitt Credits reserviert: ohne Guthaben kein Start (402).
//   2. WebSocket /v1/cloud/realtime, Subprotokolle «buddy-live.v1» + «ticket.<Ticket>» (kein Cookie,
//      kein Token in der URL). Origin, falls vorhanden, nur aus CORS_ORIGINS.
//   3. Relay: Ereignisse der App werden geprüft und neu aufgebaut (Liste erlaubter Typen, Grössen,
//      Stimmen, nur Funktions-Werkzeuge, keine Zusatz-Transkription, max_output_tokens gedeckelt).
//   4. Abrechnung: jedes response.done bringt usage → läuft gegen die offene Reservierung. Ist sie zu
//      ~75 % verbraucht, wird abgerechnet und die nächste reserviert. Gelingt das nicht: Hinweis
//      «buddy.error insufficient_credits» und sauberes Ende. Am Ende wird der Rest abgerechnet.
//   5. Grenzen: 1 Gespräch pro Nutzer, höchstens REALTIME_MAX_SESSIONS gleichzeitig, Dauer
//      REALTIME_MAX_SECONDS, Leerlauf, Grösse und Menge der Ton-Daten.
//
// OpenAI-Doku (geprüft am 20.11.2026):
//   https://developers.openai.com/api/docs/guides/realtime-conversations      (Ereignisse, session.update)
//   https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime (WebSocket, Bearer-Key)
//   https://developers.openai.com/api/reference/resources/realtime            (Event-Schemas, usage)
//   wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1, Header «Authorization: Bearer …».
//   session.update: { type:'realtime', output_modalities, audio:{ input:{ format:{type:'audio/pcm',rate:24000},
//   turn_detection:{type:'semantic_vad'|'server_vad',…} }, output:{ format, voice } }, instructions, tools,
//   tool_choice, max_output_tokens (1–4096|'inf') }. Ton: PCM16, 24 kHz, mono, Base64.
//   response.done.response.usage: input_tokens, output_tokens, input_token_details{text_tokens,
//   audio_tokens, image_tokens, cached_tokens, cached_tokens_details{text_tokens,audio_tokens,image_tokens}},
//   output_token_details{text_tokens, audio_tokens}.
// Preise stehen NICHT im Code, sondern in model_pricing (Supabase), Vorlage:
//   supabase/seed/realtime-pricing.template.sql (Quelle und Datum dort).

const crypto = require('node:crypto');
const { AppError, unavailable } = require('../lib/errors');
const { acceptUpgrade, rejectUpgrade, offeredProtocols } = require('../lib/websocket');
const { add, toUnits } = require('../lib/decimal');

const PROTOCOL = 'buddy-live.v1';
const TICKET_PREFIX = 'ticket.';
const TICKET_MS = 60000;
// Stimmen laut Realtime-Guide (20.11.2026); marin und cedar empfohlen
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const RATE = 24000; // PCM16 mono → 48 000 Bytes pro Sekunde
const MAX_APPEND_B64 = 256 * 1024; // ~4 s Ton pro Nachricht
const MAX_MESSAGE_BYTES = 320 * 1024;
// Schätzung pro Abschnitt (grosszügig, ~2–3 Min. Gespräch). Abgerechnet wird nur die echte Nutzung.
const SEGMENT_ESTIMATE = { inputTokens: 12000, outputTokens: 800, audio: { input_tokens: 3000, output_tokens: 3000 } };
const SETTLE_AT = 0.75;

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const n = (x) => Math.max(0, Math.trunc(Number(x) || 0));

/** Nur bekannte Felder, alles andere fällt weg (nie fremde Objekte weiterreichen) */
function cleanTurnDetection(td) {
  if (!isObj(td)) return { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true };
  if (td.type === 'server_vad') {
    const out = { type: 'server_vad', create_response: true, interrupt_response: true };
    if (Number.isFinite(td.threshold)) out.threshold = Math.min(0.95, Math.max(0.1, Number(td.threshold)));
    if (Number.isFinite(td.silence_duration_ms)) out.silence_duration_ms = Math.min(3000, Math.max(200, Math.trunc(td.silence_duration_ms)));
    if (Number.isFinite(td.prefix_padding_ms)) out.prefix_padding_ms = Math.min(1000, Math.max(0, Math.trunc(td.prefix_padding_ms)));
    return out;
  }
  const eagerness = ['low', 'medium', 'high', 'auto'].includes(td.eagerness) ? td.eagerness : 'auto';
  return { type: 'semantic_vad', eagerness, create_response: true, interrupt_response: true };
}

function cleanTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools.slice(0, 48)) {
    if (!isObj(t) || t.type !== 'function') continue; // keine eingebauten/MCP-Werkzeuge (Kosten ausserhalb Tokens)
    const name = str(t.name, 64);
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    const params = isObj(t.parameters) ? t.parameters : { type: 'object', properties: {} };
    if (JSON.stringify(params).length > 8000) continue;
    out.push({ type: 'function', name, description: String(t.description || '').slice(0, 1024), parameters: params });
  }
  return out;
}

/**
 * Ereignis der App prüfen und neu aufbauen. Unbekanntes wird abgelehnt.
 * @returns {{ event?: any, error?: string }}
 */
function sanitizeClientEvent(ev, { maxOutputTokens = 1024 } = {}) {
  if (!isObj(ev) || typeof ev.type !== 'string') return { error: 'invalid_event' };
  switch (ev.type) {
    case 'input_audio_buffer.append': {
      const audio = str(ev.audio, MAX_APPEND_B64);
      if (audio === null || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return { error: 'invalid_audio' };
      return { event: { type: ev.type, audio } };
    }
    case 'input_audio_buffer.clear':
    case 'input_audio_buffer.commit':
    case 'response.cancel':
    case 'response.create':
      // response.create ohne Zusatzfelder: es gelten die Werte aus session.update (gedeckelt)
      return { event: { type: ev.type } };
    case 'conversation.item.truncate': {
      const itemId = str(ev.item_id, 64);
      if (!itemId || !Number.isFinite(ev.audio_end_ms)) return { error: 'invalid_event' };
      return { event: { type: ev.type, item_id: itemId, content_index: 0, audio_end_ms: Math.min(3600000, n(ev.audio_end_ms)) } };
    }
    case 'conversation.item.create': {
      const item = ev.item;
      if (!isObj(item)) return { error: 'invalid_event' };
      if (item.type === 'function_call_output') {
        const callId = str(item.call_id, 64);
        if (!callId || typeof item.output !== 'string') return { error: 'invalid_event' };
        return { event: { type: ev.type, item: { type: 'function_call_output', call_id: callId, output: item.output.slice(0, 20000) } } };
      }
      if (item.type === 'message' && item.role === 'user' && Array.isArray(item.content)) {
        const text = item.content.filter((c) => isObj(c) && c.type === 'input_text' && typeof c.text === 'string').map((c) => c.text).join('\n').slice(0, 4000);
        if (!text) return { error: 'invalid_event' };
        return { event: { type: ev.type, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } } };
      }
      return { error: 'invalid_event' };
    }
    case 'session.update': {
      const s = isObj(ev.session) ? ev.session : {};
      const voice = VOICES.includes(s.audio?.output?.voice) ? s.audio.output.voice : 'marin';
      const wanted = Number.isFinite(s.max_output_tokens) ? Math.trunc(s.max_output_tokens) : maxOutputTokens;
      const session = {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: String(s.instructions || '').slice(0, 16000),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: RATE },
            turn_detection: cleanTurnDetection(s.audio?.input?.turn_detection),
            // Keine Zusatz-Transkription (würde extra kosten und hier nicht abgerechnet)
            transcription: null,
            ...(['near_field', 'far_field'].includes(s.audio?.input?.noise_reduction?.type) ? { noise_reduction: { type: s.audio.input.noise_reduction.type } } : {}),
          },
          output: { format: { type: 'audio/pcm', rate: RATE }, voice },
        },
        tools: cleanTools(s.tools),
        tool_choice: s.tool_choice === 'none' ? 'none' : 'auto',
        max_output_tokens: Math.min(maxOutputTokens, Math.max(64, wanted)),
      };
      return { event: { type: 'session.update', session } };
    }
    default:
      return { error: 'event_not_allowed' };
  }
}

/**
 * usage aus response.done → Abrechnung über billing_quote.
 * Zwischengespeicherte Tokens (Text UND Ton) laufen über den Text-Platz «cached» und damit über
 * cached_input_price. Bei gpt-realtime-2.1 kosten beide gleich viel (0.40 USD/1M). Bilder zählen als Text.
 * Ton (nicht zwischengespeichert) läuft über audio_pricing.input_per_1m / output_per_1m.
 */
function realtimeUsage(u) {
  const d = isObj(u?.input_token_details) ? u.input_token_details : {};
  const cd = isObj(d.cached_tokens_details) ? d.cached_tokens_details : {};
  const od = isObj(u?.output_token_details) ? u.output_token_details : {};
  const audioIn = n(d.audio_tokens);
  const cachedAudio = Math.min(audioIn, n(cd.audio_tokens));
  const textIn = n(d.text_tokens) + n(d.image_tokens);
  const cached = Math.min(n(d.cached_tokens), textIn + cachedAudio);
  const hasDetails = 'audio_tokens' in d || 'text_tokens' in d;
  const outAudio = n(od.audio_tokens);
  const outText = 'text_tokens' in od || 'audio_tokens' in od ? n(od.text_tokens) : n(u?.output_tokens);
  return {
    // Ohne Aufschlüsselung (sollte nicht vorkommen): alles als Ton rechnen (teurer = sicher)
    inputTokens: hasDetails ? textIn + cachedAudio : 0,
    cachedTokens: hasDetails ? cached : 0,
    outputTokens: outText,
    audio: { input_tokens: hasDetails ? audioIn - cachedAudio : n(u?.input_tokens), output_tokens: hasDetails || 'audio_tokens' in od ? outAudio : 0 },
  };
}

const addUsage = (a, b) => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  audio: { input_tokens: a.audio.input_tokens + b.audio.input_tokens, output_tokens: a.audio.output_tokens + b.audio.output_tokens },
});
const ZERO = () => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, audio: { input_tokens: 0, output_tokens: 0 } });

/**
 * @param {{ config: any, billing: any, verifier?: any, logger: any, WebSocketImpl?: any, now?: () => number }} deps
 */
function createRealtimeRelay({ config, billing, logger, WebSocketImpl = globalThis.WebSocket, now = Date.now }) {
  const rc = config.realtime || {};
  const model = rc.model || 'gpt-realtime-2.1';
  const upstreamBase = rc.url || 'wss://api.openai.com/v1/realtime';
  const maxSeconds = rc.maxSeconds || 900;
  const idleSeconds = rc.idleSeconds || 90;
  const maxSessions = rc.maxSessions || 40;
  const maxOutputTokens = Math.min(4096, rc.maxOutputTokens || 1024);
  const origins = new Set(config.corsOrigins || []);

  /** @type {Map<string, { userId: string, exp: number, requestId: string, credits: string, sessionId: string }>} Hash → Ticket */
  const tickets = new Map();
  /** @type {Map<string, any>} userId → laufendes Gespräch */
  const active = new Map();
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

  async function sweepTickets() {
    const t = now();
    for (const [h, tk] of tickets) {
      if (tk.exp < t) {
        tickets.delete(h);
        await billing.release(tk.requestId, 'released', 'Buddy Live nicht gestartet');
      }
    }
  }

  async function segmentCredits() {
    const q = await billing.quote(model, SEGMENT_ESTIMATE.inputTokens, 0, SEGMENT_ESTIMATE.outputTokens, SEGMENT_ESTIMATE.audio);
    return q.credits;
  }

  /** Schritt 1: Ticket + erste Reservierung */
  async function createSession(user) {
    if (!config.openai.apiKey) throw unavailable('Buddy Cloud ist noch nicht eingerichtet.', 'not_configured');
    if (typeof WebSocketImpl !== 'function') throw unavailable('Buddy Live ist hier nicht verfügbar.', 'not_configured');
    if (!(await billing.isAllowed(model))) throw unavailable('Buddy Live ist in Buddy Cloud noch nicht eingerichtet.', 'not_configured');
    await sweepTickets();
    if (active.has(user.id)) throw new AppError(409, 'live_busy', 'Es läuft schon ein Gespräch.');
    if (active.size >= maxSessions) throw new AppError(503, 'live_full', 'Buddy Live ist gerade ausgelastet. Bitte später nochmals.');
    const open = [...tickets.values()].filter((tk) => tk.userId === user.id);
    for (const tk of open) { // alte, ungenutzte Tickets dieses Nutzers verfallen
      tickets.delete(hash(tk.raw));
      await billing.release(tk.requestId, 'released', 'Buddy Live nicht gestartet');
    }
    const sessionId = crypto.randomUUID();
    const requestId = `bl_${sessionId}_1`;
    const credits = await segmentCredits();
    await billing.reserve({ userId: user.id, requestId, model, credits }); // 402 insufficient_credits, wenn zu wenig
    const raw = crypto.randomBytes(32).toString('base64url');
    tickets.set(hash(raw), { raw, userId: user.id, exp: now() + TICKET_MS, requestId, credits: String(credits), sessionId });
    return { ticket: raw, path: '/v1/cloud/realtime', protocol: PROTOCOL, expiresIn: TICKET_MS / 1000, model, maxSeconds, voices: VOICES };
  }

  /** Schritt 2: WebSocket-Upgrade */
  function handleUpgrade(req, socket, head) {
    const offered = offeredProtocols(req);
    if (!offered.includes(PROTOCOL)) return rejectUpgrade(socket, 400, 'protocol_required');
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return rejectUpgrade(socket, 403, 'origin_not_allowed');
    const raw = offered.find((p) => p.startsWith(TICKET_PREFIX))?.slice(TICKET_PREFIX.length) || '';
    const h = raw ? hash(raw) : '';
    const tk = h ? tickets.get(h) : null;
    if (!tk || tk.exp < now() || !crypto.timingSafeEqual(Buffer.from(hash(tk.raw)), Buffer.from(h))) return rejectUpgrade(socket, 401, 'invalid_ticket');
    tickets.delete(h); // einmalig
    if (active.has(tk.userId)) {
      billing.release(tk.requestId, 'released', 'Buddy Live doppelt');
      return rejectUpgrade(socket, 409, 'live_busy');
    }
    const conn = acceptUpgrade(req, socket, head, { protocol: PROTOCOL, maxPayload: MAX_MESSAGE_BYTES });
    if (!conn) {
      billing.release(tk.requestId, 'released', 'Buddy Live Handshake');
      return undefined;
    }
    startRelay(conn, tk);
    return undefined;
  }

  function startRelay(conn, tk) {
    const startedAt = now();
    const s = {
      userId: tk.userId, sessionId: tk.sessionId, segment: 1, requestId: tk.requestId, reserved: tk.credits,
      usage: ZERO(), total: '0', ended: false, upstream: null, queue: [], lastClient: now(), audioBytes: 0, settling: Promise.resolve(),
    };
    active.set(tk.userId, s);
    logger.info('live_start', { user: tk.userId, session: s.sessionId, model });

    const toClient = (obj) => conn.send(obj);
    const timers = [];
    const tick = setInterval(() => {
      const t = now();
      if (t - startedAt > maxSeconds * 1000) end('max_duration');
      else if (t - s.lastClient > idleSeconds * 1000) end('idle');
      // Ton-Menge: höchstens 1.5× Echtzeit (gemittelt), sonst Ende
      else if (s.audioBytes > ((t - startedAt) / 1000 + 10) * RATE * 2 * 1.5) end('too_much_audio');
      else conn.ping();
    }, 5000);
    timers.push(tick);

    // Upstream öffnen (Key nur hier)
    let up;
    try {
      up = new WebSocketImpl(`${upstreamBase}?model=${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${config.openai.apiKey}` } });
    } catch (err) {
      logger.warn('live_upstream_failed', { session: s.sessionId, error: err });
      end('upstream_unavailable');
      return;
    }
    s.upstream = up;
    up.onopen = () => {
      // Grundeinstellungen, falls die App noch nichts geschickt hat (Ton-Format, Deckel, keine Transkription)
      up.send(JSON.stringify(sanitizeClientEvent({ type: 'session.update', session: {} }, { maxOutputTokens }).event));
      for (const m of s.queue.splice(0)) up.send(m);
      toClient({ type: 'buddy.session', session_id: s.sessionId, model, max_seconds: maxSeconds, credits_reserved: s.reserved });
    };
    up.onmessage = (e) => {
      if (s.ended) return;
      const text = typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8');
      let ev = null;
      try { ev = JSON.parse(text); } catch { return; }
      if (ev?.type === 'response.done') onResponseDone(ev);
      if (ev?.type === 'error') logger.warn('live_openai_error', { session: s.sessionId, code: ev.error?.code || ev.error?.type });
      conn.send(text);
    };
    up.onerror = () => { if (!s.ended) logger.warn('live_upstream_error', { session: s.sessionId }); };
    up.onclose = (e) => { if (!s.ended) end(e?.code === 1000 ? 'upstream_closed' : 'upstream_error'); };

    conn.on('message', (data, binary) => {
      if (s.ended) return;
      s.lastClient = now();
      if (binary) return conn.send({ type: 'buddy.error', code: 'invalid_event' });
      let ev;
      try { ev = JSON.parse(data); } catch { return conn.send({ type: 'buddy.error', code: 'invalid_event' }); }
      if (ev?.type === 'buddy.end') return end('client');
      const r = sanitizeClientEvent(ev, { maxOutputTokens });
      if (r.error) return conn.send({ type: 'buddy.error', code: r.error, event_type: String(ev?.type || '').slice(0, 64) });
      if (r.event.type === 'input_audio_buffer.append') s.audioBytes += Math.floor(r.event.audio.length * 0.75);
      const out = JSON.stringify(r.event);
      if (up.readyState === 1) up.send(out);
      else if (s.queue.length < 50) s.queue.push(out);
      return undefined;
    });
    conn.on('close', () => end('client_closed'));

    function onResponseDone(ev) {
      const u = ev.response?.usage;
      if (!u) {
        if (ev.response?.status !== 'cancelled') logger.warn('openai_missing_usage', { session: s.sessionId, kind: 'realtime' });
        return;
      }
      s.usage = addUsage(s.usage, realtimeUsage(u));
      // Nacheinander abrechnen (keine Überschneidungen)
      s.settling = s.settling.then(checkSegment).catch((err) => logger.error('live_billing_failed', { session: s.sessionId, error: err }));
    }

    async function checkSegment() {
      if (s.ended) return;
      const q = await billing.quote(model, s.usage.inputTokens, s.usage.cachedTokens, s.usage.outputTokens, s.usage.audio);
      if (toUnits(String(q.credits)) * 4n < toUnits(String(s.reserved)) * BigInt(Math.round(SETTLE_AT * 4))) return;
      await settleSegment();
      if (s.ended) return;
      // Nächster Abschnitt
      s.segment += 1;
      s.requestId = `bl_${s.sessionId}_${s.segment}`;
      try {
        const credits = await segmentCredits();
        await billing.reserve({ userId: s.userId, requestId: s.requestId, model, credits });
        s.reserved = String(credits);
      } catch (err) {
        s.requestId = null;
        if (err?.code === 'insufficient_credits') {
          toClient({ type: 'buddy.error', code: 'insufficient_credits' });
          end('insufficient_credits');
        } else {
          logger.error('live_reserve_failed', { session: s.sessionId, error: err });
          end('billing_error');
        }
      }
    }

    async function settleSegment() {
      const requestId = s.requestId;
      if (!requestId) return;
      const usage = s.usage;
      s.usage = ZERO();
      s.requestId = null;
      const empty = !usage.inputTokens && !usage.outputTokens && !usage.audio.input_tokens && !usage.audio.output_tokens;
      if (empty) {
        await billing.release(requestId, 'released', 'Buddy Live ohne Nutzung');
        return;
      }
      try {
        const r = await billing.settle(requestId, usage);
        await billing.label?.(requestId, 'Buddy Live');
        s.total = add(s.total, String(r.credits ?? '0'));
        toClient({ type: 'buddy.usage', credits: s.total });
      } catch (err) {
        logger.error('settle_failed', { requestId, error: err });
      }
    }

    let endedReason = null;
    function end(reason) {
      if (s.ended) return;
      s.ended = true;
      endedReason = reason;
      timers.forEach(clearInterval);
      try { if (up && up.readyState <= 1) up.close(1000); } catch { /* egal */ }
      // Letzte Abrechnung abwarten, dann Abschluss an die App und schliessen
      s.settling.then(() => settleSegment()).catch((err) => logger.error('live_billing_failed', { session: s.sessionId, error: err })).finally(() => {
        active.delete(s.userId);
        const seconds = Math.round((now() - startedAt) / 1000);
        logger.info('live_end', { user: s.userId, session: s.sessionId, reason: endedReason, seconds, credits: s.total });
        conn.send({ type: 'buddy.ended', reason: endedReason, seconds, credits: s.total });
        conn.close(1000, endedReason);
      });
    }
  }

  return { createSession, handleUpgrade, model, active: () => active.size, VOICES };
}

module.exports = { createRealtimeRelay, sanitizeClientEvent, realtimeUsage, PROTOCOL, VOICES, SEGMENT_ESTIMATE };
