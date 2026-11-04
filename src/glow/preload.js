// Einzige Verbindung des Rands zum Hauptprozess: die Audio-Werte pro Bild.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glowBridge', {
  onFrame: (cb) => {
    ipcRenderer.on('glow:frame', (_e, f) => cb(f));
  },
});
