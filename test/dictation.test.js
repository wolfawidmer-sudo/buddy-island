// Tests: Diktat über Buddy Cloud (src/dictation.js), Rückfall-Logik, WAV-Aufbau, Sprach-Helfer-Befehle.
// Keine echten Netz- oder OpenAI-Aufrufe.
const assert = require('assert');
const d = require('../src/dictation');
const { SCRIPT } = require('../src/voice');
const { parseWav } = require('../backend/src/services/transcribe');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('✓', name); };
const err = (status, code) => Object.assign(new Error(code), { status, code });

(async () => {
  await test('WAV-Aufbau: 44-Byte-Kopf, 16 kHz, 16 Bit, mono; Backend liest dieselbe Länge', () => {
    const pcm = Buffer.alloc(32000 * 2); // 2 s
    const wav = d.buildWav(pcm);
    assert.strictEqual(wav.length, 44 + pcm.length);
    assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(wav.readUInt32LE(4), 36 + pcm.length);
    assert.strictEqual(wav.toString('ascii', 8, 16), 'WAVEfmt ');
    assert.strictEqual(wav.readUInt16LE(20), 1);
    assert.strictEqual(wav.readUInt16LE(22), 1);
    assert.strictEqual(wav.readUInt32LE(24), 16000);
    assert.strictEqual(wav.readUInt32LE(28), 32000);
    assert.strictEqual(wav.readUInt16LE(34), 16);
    assert.strictEqual(wav.readUInt32LE(40), pcm.length);
    assert.strictEqual(parseWav(wav).seconds, 2);
  });

  await test('Entscheid: Cloud nur wenn an, angemeldet, Guthaben, online, Endpunkt da', () => {
    const base = { enabled: true, configured: true, signedIn: true, available: '12.5', online: true, blockedUntil: 0, now: 1000 };
    assert.deepStrictEqual(d.decide(base), { use: true, reason: 'ok' });
    assert.strictEqual(d.decide({ ...base, enabled: false }).reason, 'off');
    assert.strictEqual(d.decide({ ...base, configured: false }).reason, 'not_configured');
    assert.strictEqual(d.decide({ ...base, signedIn: false }).reason, 'signed_out');
    assert.strictEqual(d.decide({ ...base, available: '0.000000' }).reason, 'no_credits');
    assert.strictEqual(d.decide({ ...base, online: false }).reason, 'offline');
    assert.strictEqual(d.decide({ ...base, blockedUntil: 5000 }).reason, 'unavailable');
    assert.strictEqual(d.decide({ ...base, available: null }).use, true); // Guthaben noch unbekannt: versuchen
  });

  const wav = d.buildWav(Buffer.alloc(16000));

  await test('Erfolg: Text, Sprache als ISO-Code (de-CH → de), Base64-WAV', async () => {
    let sent;
    const dict = d.createDictation({ post: async (body) => { sent = body; return { text: ' Hallo Buddy ', creditsCharged: '0.31' }; } });
    const r = await dict.transcribe(wav, 'de-CH');
    assert.deepStrictEqual(r, { ok: true, text: 'Hallo Buddy', credits: '0.31' });
    assert.strictEqual(sent.language, 'de');
    assert.ok(Buffer.from(sent.audio, 'base64').equals(wav));
  });

  await test('Rückfall: 404 (Backend noch ohne Diktat) → 30 Min. Pause, dann wieder', async () => {
    let now = 0;
    const dict = d.createDictation({ post: async () => { throw err(404, 'not_found'); }, now: () => now });
    assert.deepStrictEqual(await dict.transcribe(wav, 'de'), { ok: false, reason: 'unavailable' });
    const base = { enabled: true, configured: true, signedIn: true, available: '5', online: true };
    assert.strictEqual(d.decide({ ...base, blockedUntil: dict.blockedUntil(), now: 60000 }).use, false);
    now = d.RETRY_AFTER_404_MS + 1;
    assert.strictEqual(d.decide({ ...base, blockedUntil: dict.blockedUntil(), now }).use, true);
  });

  await test('Rückfall: kein Guthaben, offline, abgemeldet, Serverfehler, nie ein Fehler nach aussen', async () => {
    const cases = [[err(402, 'insufficient_credits'), 'no_credits'], [Object.assign(new Error('x'), { code: 'offline' }), 'offline'],
      [err(401, 'signed_out'), 'signed_out'], [err(502, 'upstream_error'), 'upstream_error'], [new Error('kaputt'), 'error']];
    for (const [e, reason] of cases) {
      const logs = [];
      const dict = d.createDictation({ post: async () => { throw e; }, log: (m) => logs.push(m) });
      const r = await dict.transcribe(wav, 'fr');
      assert.deepStrictEqual(r, { ok: false, reason });
      assert.strictEqual(dict.blockedUntil(), 0);
    }
  });

  await test('Rückfall: Zeitlimit, Anfrage wird abgebrochen (bleibt nie hängen)', async () => {
    let aborted = false;
    const dict = d.createDictation({ timeoutMs: 50, post: (_b, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('abort')); })) });
    const t0 = Date.now();
    assert.deepStrictEqual(await dict.transcribe(wav, 'de'), { ok: false, reason: 'timeout' });
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(aborted);
  });

  await test('Leere Aufnahme geht gar nicht erst an die Cloud', async () => {
    let called = false;
    const dict = d.createDictation({ post: async () => { called = true; return {}; } });
    assert.deepStrictEqual(await dict.transcribe(d.buildWav(Buffer.alloc(0)), 'de'), { ok: false, reason: 'empty' });
    assert.strictEqual(called, false);
  });

  await test('Sprach-Helfer: Cloud-Modus, Aufnahme, Rückfall auf Windows-Erkennung, Liste ohne JSON', () => {
    for (const x of ["'mode cloud'", "'mode local'", "'fallback'", 'function ListenCloud', 'function FallbackPcm', 'RecStart(30000, 1000, 6000)',
      "kind = 'partial'", "kind = 'audio'", "kind = 'recorded'", 'SetInputToAudioStream', 'SetInputToDefaultAudioDevice', 'static int Take(byte[] buf)',
      'next = (next + 1) % N', 'public static string Step', 'vosk_recognizer_final_result', '[int]$cloud = 0']) assert.ok(SCRIPT.includes(x), x);
    // Wakeword und Mikrofon-Knopf gehen beide über Dictate (Cloud oder Windows)
    assert.strictEqual((SCRIPT.match(/\n\s+Dictate\n/g) || []).length, 3);
    // Ohne Windows-Erkenner, aber mit Cloud: Helfer bleibt an
    assert.ok(SCRIPT.includes("-not $vosk -and $cloud -ne 1) { exit 0 }"));
    // Kein $ im C#-Teil (PowerShell würde es in der Here-String ersetzen)
    const cs = SCRIPT.match(/\$voskCode = @"\n([\s\S]*?)\n"@/)[1];
    assert.ok(!cs.includes('$'));
  });

  console.log(`\n${n} Tests grün`);
})().catch((e) => { console.error(e); process.exit(1); });
