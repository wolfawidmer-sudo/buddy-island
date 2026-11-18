// Buddys Augen im geschlossenen Island: ein kleines Wesen mit Schlafzyklus.
//   wach   offene Augen, blinzelt, schaut ab und zu zur Seite
//   müde   halb geschlossen, nach einer Weile ohne Kontakt
//   schläft geschlossene Striche, die langsam «atmen»
// Darüberfahren, eine Antwort, ein Timer oder das Wakeword wecken Buddy.
// Nachts (22–7 Uhr) wird er schneller müde.
//
// Sparsam: keine Dauer-Animation. Ein Takt alle paar Sekunden setzt nur
// data-eyes und kurze Klassen; die Bewegung macht CSS mit transform/width.
(function (root) {
  const DAY = { drowsy: 2 * 60 * 1000, asleep: 5 * 60 * 1000 };
  const NIGHT = { drowsy: 30 * 1000, asleep: 60 * 1000 };
  const TICK_MS = 4000;

  const isNight = (hour) => hour >= 22 || hour < 7;

  // Reine Funktion (getestet): Phase aus Ruhezeit und Stunde
  function phaseAt(idleMs, hour) {
    const lim = isNight(hour) ? NIGHT : DAY;
    if (idleMs >= lim.asleep) return 'asleep';
    if (idleMs >= lim.drowsy) return 'drowsy';
    return 'awake';
  }

  /**
   * @param {object} o
   * @param {HTMLElement} o.island
   * @param {() => boolean} o.active   Augen dürfen leben (Einstellung an, idle, geschlossen, kein Spiel)
   * @param {() => number} [o.now]
   * @param {() => boolean} [o.calm]   Bewegung reduzieren
   */
  function createEyes({ island, active, now = () => Date.now(), calm = () => false, timers = root }) {
    let lastContact = now();
    let phase = 'awake';
    let tickTimer = null;
    let wakeTimer = null;
    let glanceTimer = null;

    function apply(next) {
      if (!active()) {
        if (island.dataset.eyes) delete island.dataset.eyes;
        island.classList.remove('breath', 'glance-l', 'glance-r');
        return;
      }
      if (island.dataset.eyes !== next) island.dataset.eyes = next;
      if (next !== 'asleep') island.classList.remove('breath');
    }

    function tick() {
      const prev = phase;
      phase = phaseAt(now() - lastContact, new Date(now()).getHours());
      if (phase !== prev || island.dataset.eyes !== phase) apply(phase);
      if (!active()) return;
      if (phase === 'asleep' && !calm()) island.classList.toggle('breath');
      if (phase === 'awake' && !calm() && Math.random() < 0.18) glance();
    }

    function glance() {
      const side = Math.random() < 0.5 ? 'glance-l' : 'glance-r';
      island.classList.add(side);
      timers.clearTimeout(glanceTimer);
      glanceTimer = timers.setTimeout(() => island.classList.remove(side), 1100);
    }

    // Kontakt: Buddy wacht auf. Aus dem Schlaf kurz über «müde», damit es wie Aufwachen aussieht.
    function wake() {
      lastContact = now();
      if (phase === 'awake') return;
      const wasAsleep = phase === 'asleep';
      phase = 'awake';
      timers.clearTimeout(wakeTimer);
      if (wasAsleep && active() && !calm()) {
        apply('drowsy');
        wakeTimer = timers.setTimeout(() => apply(phase), 220);
      } else apply('awake');
    }

    function start() {
      if (tickTimer) return;
      apply(phase);
      tickTimer = timers.setInterval(tick, TICK_MS);
    }

    function stop() {
      timers.clearInterval(tickTimer);
      timers.clearTimeout(wakeTimer);
      timers.clearTimeout(glanceTimer);
      tickTimer = null;
    }

    return { start, stop, wake, tick, sync: () => apply(phase), phase: () => phase };
  }

  const api = { phaseAt, createEyes, DAY, NIGHT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddyEyes = api;
})(typeof window !== 'undefined' ? window : globalThis);
