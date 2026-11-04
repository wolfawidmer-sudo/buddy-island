// @ts-check
// Laufzeiten für lokale Modelle (Abstraktion).
//
// Buddy spricht nur über diese Schnittstelle mit einer Laufzeit. Heute gibt es eine: Ollama.
// Eine weitere (z. B. ein mitgelieferter llama.cpp-Server) braucht ein Modul mit denselben
// Funktionen und einen Eintrag in RUNTIMES. Manager, Chat-Adapter und Oberfläche bleiben gleich.
//
// Pflichtfunktionen einer Laufzeit:
//   detect()            → { installed, running, version, path, managed, host, modelsDir }
//   start() / stop()    → Server starten (falls nötig) / nur selbst gestarteten Server beenden
//   installPlan()       → { automatic, method, url, sizeBytes }   (lädt nichts)
//   install({ onProgress, signal })
//   list() / ps()       → installierte / geladene Modelle
//   show(id)            → Fähigkeiten (caps), Kontextlänge, Aufbau
//   pull(id, { onProgress, signal }) / remove(id)
//   load(id, { keepAlive, options }) / unload(id)
//   chat({ model, messages, tools, options, think, keepAlive, signal, onDelta })
//   getModelsDir() / setModelsDir(dir)
//   logTail() / computeDevices()

const { createOllama } = require('./ollama');

/** @type {Record<string, (opts: any) => ReturnType<typeof createOllama>>} */
const RUNTIMES = {
  ollama: createOllama,
};

const DEFAULT_RUNTIME = 'ollama';

/** @param {string} id @param {any} opts */
function createRuntime(id, opts) {
  const make = RUNTIMES[id] || RUNTIMES[DEFAULT_RUNTIME];
  return make(opts);
}

module.exports = { createRuntime, RUNTIMES, DEFAULT_RUNTIME };
