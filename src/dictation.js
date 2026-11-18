// Diktat über Buddy Cloud: WAV bauen, entscheiden ob die Cloud genutzt wird, Text holen.
// Jeder Fehler führt zurück auf die Erkennung auf dem PC (Vosk-Text oder Windows-Erkennung),
// nie zu einem Hänger: Zeitlimit, und nach «Endpunkt fehlt» (404) 30 Minuten Pause.

const RATE = 16000;
const RETRY_AFTER_404_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 25000;

/** PCM (16 kHz, 16 Bit, mono) → WAV-Datei */
function buildWav(pcm, rate = RATE) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // Länge des fmt-Blocks
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // Bytes pro Sekunde
  h.writeUInt16LE(2, 32); // Block
  h.writeUInt16LE(16, 34); // Bit
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * Cloud-Diktat verwenden? Nur wenn eingeschaltet, angemeldet, Guthaben da, online
 * und der Endpunkt nicht gerade fehlt.
 * @returns {{ use: boolean, reason: string }}
 */
function decide({ enabled, configured, signedIn, available, online = true, blockedUntil = 0, now = Date.now() }) {
  if (enabled === false) return { use: false, reason: 'off' };
  if (!configured) return { use: false, reason: 'not_configured' };
  if (!signedIn) return { use: false, reason: 'signed_out' };
  if (available !== null && available !== undefined && !(Number(available) > 0)) return { use: false, reason: 'no_credits' };
  if (!online) return { use: false, reason: 'offline' };
  if (blockedUntil > now) return { use: false, reason: 'unavailable' };
  return { use: true, reason: 'ok' };
}

/**
 * @param {{ post: (body: { audio: string, language: string|null }, signal: AbortSignal) => Promise<any>, log?: Function, now?: () => number, timeoutMs?: number }} o
 *   post: ruft POST /v1/cloud/audio/transcriptions auf (wirft CloudError mit code/status)
 */
function createDictation({ post, log = () => {}, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  let blockedUntil = 0;

  /** @returns {Promise<{ ok: true, text: string, credits: string|null } | { ok: false, reason: string }>} nie ein Fehler */
  async function transcribe(wav, language) {
    if (!wav || wav.length <= 44) return { ok: false, reason: 'empty' };
    const ctrl = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { ctrl.abort(); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs); });
    const lang = language ? String(language).split(/[-_]/)[0].toLowerCase() : null;
    const run = (async () => {
      try {
        const data = await post({ audio: wav.toString('base64'), language: lang && /^[a-z]{2,3}$/.test(lang) ? lang : null }, ctrl.signal);
        return { ok: true, text: typeof data?.text === 'string' ? data.text.trim() : '', credits: data?.creditsCharged ?? null };
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (e?.status === 404 || e?.status === 501) {
          blockedUntil = now() + RETRY_AFTER_404_MS; // Backend noch ohne Diktat: eine Weile nicht mehr fragen
          return { ok: false, reason: 'unavailable' };
        }
        if (e?.status === 402 || e?.code === 'insufficient_credits') return { ok: false, reason: 'no_credits' };
        if (e?.code === 'offline') return { ok: false, reason: 'offline' };
        if (e?.code === 'signed_out' || e?.status === 401) return { ok: false, reason: 'signed_out' };
        log(`Diktat: Buddy Cloud ${e?.status || ''} ${e?.code || e?.message || 'Fehler'}`.trim());
        return { ok: false, reason: e?.code || 'error' };
      }
    })();
    const res = await Promise.race([run, timeout]);
    clearTimeout(timer);
    return res;
  }

  return { transcribe, blockedUntil: () => blockedUntil };
}

module.exports = { buildWav, decide, createDictation, RETRY_AFTER_404_MS };
