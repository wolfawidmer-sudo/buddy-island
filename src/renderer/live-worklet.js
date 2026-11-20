// Buddy Live: Mikrofon-Ton in Blöcken von ~100 ms (2400 Werte bei 24 kHz) an die Seite geben.
// Läuft im AudioWorklet (eigener Thread), darum kein Zugriff auf window.
class BuddyCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2400);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      this.buf[this.n] = ch[i];
      this.n += 1;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('buddy-capture', BuddyCapture);
