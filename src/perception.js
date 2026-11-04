// @ts-check
// «Buddy schaut auf den Bildschirm»: ein einziger, ehrlicher Zustand für den Bildschirmrand.
//
// Aktiv ab der ersten echten Bildschirmaufnahme einer Aufgabe (Bildschirmfoto oder Zoom).
// Solange die Aufgabe läuft, wertet das Modell diese Aufnahmen aus und macht neue: der Rand
// bleibt. Er verschwindet sofort, wenn die Aufgabe endet (fertig, Fehler, Stopp), die
// PC-Steuerung endet oder pausiert wird (Spielmodus). Kein Timer, keine Musik, keine Vermutung.

/**
 * @param {{ onChange?: (active: boolean) => void }} [opts]
 */
function createPerception({ onChange = () => {} } = {}) {
  /** Aufgaben, in denen Buddy gerade den Bildschirm sieht */
  const tasks = new Set();
  let capturing = 0; // laufende Aufnahmen (zwischen begin und end)
  let paused = false;
  let active = false;

  function update() {
    const next = !paused && (capturing > 0 || tasks.size > 0);
    if (next === active) return;
    active = next;
    onChange(active);
  }

  return {
    /** Eine Aufnahme beginnt (vor dem Bildschirmfoto) @param {string} [task] */
    captureStart(task = 'default') {
      if (paused) return false; // pausiert: keine Aufnahme zulassen
      capturing += 1;
      tasks.add(task);
      update();
      return true;
    },
    /** Aufnahme fertig. Die Aufgabe schaut weiter hin, bis sie endet. */
    captureEnd() {
      capturing = Math.max(0, capturing - 1);
      update();
    },
    /** Aufgabe zu Ende (fertig, Fehler, abgebrochen) @param {string} [task] */
    taskEnd(task = 'default') {
      tasks.delete(task);
      update();
    },
    /** PC-Steuerung endet: nichts schaut mehr hin */
    stopAll() {
      tasks.clear();
      capturing = 0;
      update();
    },
    /** Pausieren (z. B. Spiel im Vordergrund): Rand weg, keine neuen Aufnahmen @param {boolean} on */
    setPaused(on) {
      paused = Boolean(on);
      update();
    },
    isActive: () => active,
    isPaused: () => paused,
  };
}

module.exports = { createPerception };
