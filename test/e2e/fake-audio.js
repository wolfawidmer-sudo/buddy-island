// Ersatz für den Windows-Audio-Helfer in Tests: gibt dasselbe Zeilenformat aus.
// Zustand steht in der Datei BUDDY_FAKE_AUDIO_STATE: "play" = Musik (120 BPM), sonst Stille.
const fs = require('fs');
const stateFile = process.env.BUDDY_FAKE_AUDIO_STATE;
const t0 = Date.now();
let lastSilent = 0;
process.stdout.write('READY\ni,48000,2,32,f\n');
setInterval(() => {
  let mode = 'pause';
  try { mode = fs.readFileSync(stateFile, 'utf8').trim(); } catch { /* fehlt = Stille */ }
  const t = (Date.now() - t0) / 1000;
  if (mode === 'play') {
    const beatPos = (t % 0.5) / 0.5;
    const kick = Math.exp(-beatPos * 7);
    const hat = Math.exp(-((t % 0.25) / 0.25) * 12);
    process.stdout.write(`f,0.1200,${(0.25 + 0.75 * kick).toFixed(3)},${(0.45 + 0.25 * Math.sin(t * 2.1)).toFixed(3)},${(0.2 + 0.6 * hat).toFixed(3)},${beatPos < 0.04 ? 1 : 0}\n`);
  } else if (Date.now() - lastSilent > 250) {
    lastSilent = Date.now();
    process.stdout.write('s\n');
  }
}, 16);
