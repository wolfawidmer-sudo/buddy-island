'use strict';
// Diktat über Buddy Cloud: WAV aus der App → OpenAI-Transkription → Text zurück.
// Ablauf: WAV prüfen (Format, Grösse, Länge) → Kosten schätzen → Credits reservieren →
// an OpenAI → echte Nutzung abrechnen (Anbieterkosten + Kommission aus billing_settings) → Text.
// Der Ton wird nur im Speicher gehalten und nach der Anfrage verworfen (nie gespeichert, nie geloggt).
//
// OpenAI-Doku (Stand 11.11.2026, nur teilweise lesbar, siehe PR-Bericht):
//   https://developers.openai.com/api/docs/guides/speech-to-text
//   https://developers.openai.com/api/docs/api-reference/audio/createTranscription
//   https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe  (gelesen am 11.11.2026: Alias
//     «gpt-4o-mini-transcribe» als Default gelistet)
//   https://developers.openai.com/api/docs/pricing
// Endpunkt POST /v1/audio/transcriptions (multipart: file, model, language, response_format=json).
// Nutzung in der Antwort: gpt-4o-*-transcribe → { type: 'tokens', input_tokens, input_token_details:
// { audio_tokens, text_tokens }, output_tokens }; whisper-1 → { type: 'duration', seconds }.
// Preise stehen NICHT im Code, sondern in model_pricing (Supabase); das Modell kommt aus TRANSCRIBE_MODEL.

const { AppError, badRequest, unavailable } = require('../lib/errors');
const { upstreamError } = require('./openai');

const RATE = 16000;
const MAX_SECONDS = 31; // App nimmt höchstens 30 s auf
const MIN_SECONDS = 0.3;
const MAX_WAV_BYTES = 44 + MAX_SECONDS * RATE * 2;
const LANG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i; // z. B. «de», «de-CH», «gsw»

/**
 * WAV prüfen: nur das, was die App schickt (PCM, 16 Bit, mono, 16 kHz).
 * @param {Buffer} buf @returns {{ seconds: number }}
 */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw badRequest('Ungültige Tonaufnahme.');
  if (buf.length > MAX_WAV_BYTES) throw new AppError(413, 'audio_too_long', 'Die Aufnahme ist zu lang (höchstens 30 Sekunden).');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE' || buf.toString('ascii', 12, 16) !== 'fmt ') throw badRequest('Ungültige Tonaufnahme.');
  const format = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (format !== 1 || channels !== 1 || rate !== RATE || bits !== 16) throw badRequest('Tonformat nicht unterstützt (erwartet: 16 kHz, 16 Bit, mono).');
  if (buf.toString('ascii', 36, 40) !== 'data') throw badRequest('Ungültige Tonaufnahme.');
  const dataLen = Math.min(buf.readUInt32LE(40), buf.length - 44);
  const seconds = dataLen / (RATE * 2);
  if (seconds < MIN_SECONDS) throw badRequest('Die Aufnahme ist zu kurz.');
  if (seconds > MAX_SECONDS) throw new AppError(413, 'audio_too_long', 'Die Aufnahme ist zu lang (höchstens 30 Sekunden).');
  return { seconds };
}

/**
 * Nutzung der Transkription → Abrechnung. Tokens, falls gemeldet; sonst Sekunden.
 * Nie beides zugleich, sonst würde doppelt gerechnet (billing_quote zählt alle Teile zusammen).
 */
function transcriptionUsage(usage, seconds) {
  const n = (x) => Math.max(0, Math.trunc(Number(x) || 0));
  if (usage && usage.type === 'tokens') {
    const audioIn = n(usage.input_token_details?.audio_tokens ?? usage.input_tokens);
    const textIn = n(usage.input_token_details?.text_tokens);
    return { inputTokens: textIn, cachedTokens: 0, outputTokens: n(usage.output_tokens), audio: { input_tokens: audioIn } };
  }
  const secs = usage && usage.type === 'duration' ? Number(usage.seconds) : seconds;
  return { inputTokens: 0, cachedTokens: 0, outputTokens: 0, audio: { transcription_seconds: Math.max(0, Math.ceil((Number(secs) || seconds) * 10) / 10) } };
}

/**
 * Grosszügige Schätzung für die Reservierung (abgerechnet wird danach die echte Nutzung).
 * Audio-Tokens: grob 50 pro Sekunde (eher zu hoch), Text-Ausgabe: höchstens 1000 Tokens für 30 s.
 */
function estimateUsage(seconds) {
  return { inputTokens: 64, cachedTokens: 0, outputTokens: 1000, audio: { input_tokens: Math.ceil(seconds * 50) + 100, transcription_seconds: Math.ceil(seconds) } };
}

/** @param {{ config: any, billing: any, logger: any, fetchImpl?: typeof fetch }} deps */
function createTranscriber({ config, billing, logger, fetchImpl = globalThis.fetch }) {
  const oc = config.openai;
  const model = config.transcribe?.model || 'gpt-4o-mini-transcribe';
  const timeoutMs = config.transcribe?.timeoutMs || 30000;

  /** @param {{ id: string }} user @param {any} body */
  async function transcribe(user, body) {
    if (!oc.apiKey) throw unavailable('Buddy Cloud ist noch nicht eingerichtet.', 'not_configured');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Ungültige Anfrage.');
    const extra = Object.keys(body).filter((k) => !['audio', 'language'].includes(k));
    if (extra.length) throw badRequest(`Unbekannte Felder: ${extra.join(', ')}`);
    if (typeof body.audio !== 'string' || body.audio.length > Math.ceil(MAX_WAV_BYTES / 3) * 4 + 8) {
      throw typeof body.audio === 'string' ? new AppError(413, 'audio_too_long', 'Die Aufnahme ist zu lang (höchstens 30 Sekunden).') : badRequest('Tonaufnahme fehlt.');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.audio)) throw badRequest('Ungültige Tonaufnahme.');
    let language = null;
    if (body.language !== undefined && body.language !== null) {
      const raw = String(body.language);
      if (!LANG.test(raw) || raw.length > 20) throw badRequest('Ungültige Sprache.');
      // OpenAI will ISO-639-1 (zwei Buchstaben); Schweizerdeutsch → de
      const primary = raw.split('-')[0].toLowerCase();
      language = primary === 'gsw' ? 'de' : primary.length === 2 ? primary : null;
    }
    const wav = Buffer.from(body.audio, 'base64');
    const { seconds } = parseWav(wav);
    if (!(await billing.isAllowed(model))) throw unavailable('Diktat ist in Buddy Cloud noch nicht eingerichtet.', 'not_configured');

    const est = estimateUsage(seconds);
    const q = await billing.quote(model, est.inputTokens, 0, est.outputTokens, est.audio);
    const requestId = billing.newRequestId();
    await billing.reserve({ userId: user.id, requestId, model, credits: q.credits });

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'diktat.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    if (language) form.append('language', language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream;
    try {
      upstream = await fetchImpl(`${oc.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oc.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      await billing.release(requestId, 'failed', 'Anbieter nicht erreichbar');
      logger.warn('openai_unreachable', { requestId, error: err });
      throw unavailable('Der KI-Anbieter ist gerade nicht erreichbar.');
    }
    if (!upstream.ok) {
      clearTimeout(timer);
      const errBody = await upstream.json().catch(() => ({}));
      await billing.release(requestId, 'failed', `OpenAI ${upstream.status}`);
      logger.warn('openai_error', { requestId, status: upstream.status, openaiCode: errBody?.error?.code || errBody?.error?.type, kind: 'transcription' });
      throw upstreamError(upstream.status, errBody);
    }
    let data;
    try {
      data = await upstream.json();
    } catch {
      clearTimeout(timer);
      await billing.release(requestId, 'failed', 'Antwort unvollständig');
      throw new AppError(502, 'upstream_error', 'Fehler beim KI-Anbieter.');
    }
    clearTimeout(timer);
    // OpenAI hat transkribiert und rechnet ab: auch ohne Nutzungsangabe abrechnen (dann nach Sekunden)
    if (!data?.usage) logger.warn('openai_missing_usage', { requestId, kind: 'transcription' });
    const usage = transcriptionUsage(data?.usage, seconds);
    let settled = null;
    try {
      settled = await billing.settle(requestId, usage);
      await billing.label?.(requestId, 'Diktat');
    } catch (err) {
      logger.error('settle_failed', { requestId, error: err });
    }
    const text = typeof data?.text === 'string' ? data.text.trim().slice(0, 5000) : '';
    return { text, seconds: Math.round(seconds * 10) / 10, requestId, creditsCharged: settled ? String(settled.credits) : null };
  }

  return { transcribe, model };
}

module.exports = { createTranscriber, parseWav, transcriptionUsage, estimateUsage, MAX_WAV_BYTES };
