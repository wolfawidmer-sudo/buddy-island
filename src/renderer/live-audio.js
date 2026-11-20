// Buddy Live im Renderer: Mikrofon (getUserMedia mit Echo-Unterdrückung) → PCM16 24 kHz → Hauptprozess,
// Antwort-Ton (PCM16 24 kHz) → Wiedergabe über das Standard-Ausgabegerät von Windows.
// Beim Unterbrechen wird die Wiedergabe sofort gestoppt und gemeldet, wie viele ms schon zu hören waren.
// Auch in Node testbar (Umrechnungen); die Ton-Teile brauchen einen Browser.
(function (root) {
  const RATE = 24000;

  /** Float32 [-1, 1] → PCM16 little endian */
  function floatTo16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i += 1) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
    }
    return out;
  }

  /** PCM16 → Float32 */
  function int16ToFloat(i16) {
    const out = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i += 1) out[i] = i16[i] / 0x8000;
    return out;
  }

  function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return root.btoa(s);
  }

  function b64ToBytes(b64) {
    const s = root.atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) u8[i] = s.charCodeAt(i);
    return u8;
  }

  /** Lautstärke 0..1 (RMS, leicht gestaucht für die Anzeige) */
  function levelOf(f32) {
    if (!f32.length) return 0;
    let sum = 0;
    for (let i = 0; i < f32.length; i += 1) sum += f32[i] * f32[i];
    return Math.min(1, Math.sqrt(sum / f32.length) * 4);
  }

  /**
   * @param {{ onChunk: (b64: string) => void, onIdle: () => void, onError: (name: string) => void }} cb
   */
  function createLiveAudio(cb) {
    let ctx = null;
    let stream = null;
    let node = null;
    let src = null;
    let sink = null;
    let playHead = 0;
    let sources = [];
    let item = null; // { id, startAt } aktuelle Antwort
    let micLevel = 0;
    let outLevels = []; // [{ at, level }]

    function context() {
      if (!ctx) ctx = new root.AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    async function startMic() {
      try {
        const c = context();
        stream = await root.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        await c.audioWorklet.addModule('live-worklet.js');
        src = c.createMediaStreamSource(stream);
        node = new root.AudioWorkletNode(c, 'buddy-capture');
        // Stumm an den Ausgang hängen, damit der Knoten sicher verarbeitet wird
        sink = c.createGain();
        sink.gain.value = 0;
        node.port.onmessage = (e) => {
          const f32 = e.data;
          micLevel = levelOf(f32);
          cb.onChunk(bytesToB64(new Uint8Array(floatTo16(f32).buffer)));
        };
        src.connect(node);
        node.connect(sink);
        sink.connect(c.destination);
      } catch (err) {
        stopMic();
        cb.onError(err && err.name ? err.name : 'error');
      }
    }

    function stopMic() {
      try { src && src.disconnect(); } catch (e) { /* egal */ }
      try { node && node.disconnect(); node && (node.port.onmessage = null); } catch (e) { /* egal */ }
      if (stream) stream.getTracks().forEach((tr) => tr.stop());
      stream = null; src = null; node = null; sink = null;
      micLevel = 0;
    }

    /** Antwort-Ton anhängen (nahtlos hintereinander) */
    function play(b64, itemId) {
      const c = context();
      const f32 = int16ToFloat(new Int16Array(b64ToBytes(b64).buffer));
      if (!f32.length) return;
      const buf = c.createBuffer(1, f32.length, RATE);
      buf.copyToChannel(f32, 0);
      const s = c.createBufferSource();
      s.buffer = buf;
      s.connect(c.destination);
      const at = Math.max(c.currentTime + 0.04, playHead);
      if (!item || item.id !== itemId) item = { id: itemId, startAt: at };
      s.start(at);
      playHead = at + buf.duration;
      outLevels.push({ at, level: levelOf(f32) });
      if (outLevels.length > 200) outLevels = outLevels.slice(-100);
      sources.push(s);
      s.onended = () => {
        sources = sources.filter((x) => x !== s);
        if (!sources.length) {
          outLevels = [];
          cb.onIdle();
        }
      };
    }

    /** Sofort still; gibt zurück, wie viel von der aktuellen Antwort zu hören war */
    function interrupt() {
      if (!sources.length || !ctx) return null;
      const played = item ? { itemId: item.id, ms: Math.max(0, Math.round((ctx.currentTime - item.startAt) * 1000)) } : null;
      const list = sources;
      sources = [];
      list.forEach((s) => { s.onended = null; try { s.stop(); } catch (e) { /* schon fertig */ } });
      playHead = 0;
      outLevels = [];
      item = null;
      return played;
    }

    /** Pegel für Augen/Balken: was gerade zu hören ist, sonst das Mikrofon */
    function level() {
      if (ctx && sources.length) {
        const now = ctx.currentTime;
        let cur = 0;
        for (const l of outLevels) if (l.at <= now) cur = l.level;
        return { speaking: true, level: cur };
      }
      return { speaking: false, level: micLevel };
    }

    function close() {
      stopMic();
      interrupt();
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    }

    return { startMic, stopMic, play, interrupt, level, close, playing: () => sources.length > 0 };
  }

  const api = { createLiveAudio, floatTo16, int16ToFloat, levelOf, RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuddyLiveAudio = api;
})(typeof window !== 'undefined' ? window : globalThis);
