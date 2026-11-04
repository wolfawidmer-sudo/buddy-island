// Bildschirmrand. Modus und Akzent kommen per executeJavaScript, Audio-Werte über die Preload-Brücke.
//
// Musik-Modus: jede Schicht hängt an einem eigenen Frequenzband.
//   Bass    -> Streulicht dehnt sich nach innen aus, Ecken pulsieren (bei Schlägen deutlich)
//   Mitten  -> Lichtreflexe laufen schneller um den Bildschirm und werden heller, Kante leuchtet
//   Höhen   -> feines Punktraster glitzert, Kante wird ein wenig heller
// Geglättet mit getrennten Anstiegs- und Abklingzeiten pro Band: Schläge kommen sofort,
// das Licht fällt danach weich ab, nichts flackert.

const $$ = (sel) => [...document.querySelectorAll(sel)];
const layers = {
  haze: $$('.haze'),
  core: $$('.core'),
  sheenA: $$('.sheen:not(.two)'),
  sheenB: $$('.sheen.two'),
  grain: $$('.grain'),
  rim: $$('.rim'),
  corner: $$('.corner'),
  shade: $$('.shade'),
};
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const target = { bass: 0, mid: 0, treble: 0 };
const cur = { bass: 0, mid: 0, treble: 0, beat: 0, phase: 0, shimmer: 0 };
let frameAt = 0;
let raf = 0;
let last = 0;

// Zeitkonstanten in Sekunden: [Anstieg, Abklingen]
const TAU = { bass: [0.03, 0.22], mid: [0.05, 0.3], treble: [0.02, 0.12] };

function follow(value, want, [up, down], dt) {
  const tau = want > value ? up : down;
  return value + (want - value) * (1 - Math.exp(-dt / tau));
}

function set(list, transform, opacity) {
  for (const node of list) {
    if (transform !== null) node.style.transform = transform;
    node.style.opacity = opacity.toFixed(3);
  }
}

function paint(now) {
  raf = 0;
  if (document.body.dataset.mode !== 'music') return;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  // Keine neuen Werte (Pause, Ende): sanft auf null
  const stale = now - frameAt > 150;
  for (const k of ['bass', 'mid', 'treble']) cur[k] = follow(cur[k], stale ? 0 : target[k], TAU[k], dt);
  cur.beat *= Math.exp(-dt / 0.2);

  const { bass: b, mid: m, treble: h, beat } = cur;
  const energy = 0.5 * b + 0.3 * m + 0.2 * h;
  if (!reduceMotion.matches) {
    cur.phase = (cur.phase + dt * (0.03 + 0.2 * m + 0.06 * b)) % 1;
    cur.shimmer = (cur.shimmer + dt * h * 18) % 6;
  }
  const pos = (p) => `translateX(${(-100 + 394 * p).toFixed(2)}%) scaleY(${(0.8 + 0.45 * m).toFixed(3)})`;

  set(layers.haze, `scaleY(${(0.42 + 0.7 * b + 0.22 * beat).toFixed(3)})`, 0.22 + 0.58 * b + 0.12 * beat);
  set(layers.core, `scaleY(${(0.55 + 0.55 * b).toFixed(3)})`, 0.15 + 0.45 * m + 0.25 * b);
  set(layers.sheenA, pos(cur.phase), 0.08 + 0.72 * m);
  set(layers.sheenB, pos((cur.phase + 0.5) % 1), 0.08 + 0.72 * m);
  set(layers.grain, `translateX(${cur.shimmer.toFixed(2)}px)`, 0.4 * h);
  set(layers.rim, null, 0.22 + 0.5 * m + 0.2 * h);
  set(layers.corner, `scale(${(0.72 + 0.42 * Math.max(b, beat)).toFixed(3)})`, 0.12 + 0.3 * b + 0.45 * beat);
  set(layers.shade, null, 0.2 + 0.5 * energy);

  raf = requestAnimationFrame(paint);
}

function clearInline() {
  for (const list of Object.values(layers)) for (const node of list) node.removeAttribute('style');
}

window.setMode = (mode) => {
  const before = document.body.dataset.mode;
  document.body.dataset.mode = mode;
  if (mode === 'music') {
    if (!raf) { last = 0; raf = requestAnimationFrame(paint); }
  } else {
    cancelAnimationFrame(raf);
    raf = 0;
    // Beim Ausblenden die letzte Lage stehen lassen (weiches Ausblenden), sonst Animationen übernehmen lassen
    if (mode !== 'off' || before !== 'music') clearInline();
    for (const k of ['bass', 'mid', 'treble', 'beat']) cur[k] = 0;
  }
};

window.glowBridge?.onFrame((f) => {
  target.bass = f.bass;
  target.mid = f.mid;
  target.treble = f.treble;
  if (f.beat) cur.beat = 1;
  frameAt = performance.now();
});

window.ripple = (x, y, kind) => {
  const dot = document.createElement('div');
  dot.className = 'ripple' + (kind === 'move' ? ' move' : '');
  dot.style.left = x + 'px';
  dot.style.top = y + 'px';
  document.body.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
};

window.setAccent = (color) => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  document.documentElement.style.setProperty('--accent', color);
};
