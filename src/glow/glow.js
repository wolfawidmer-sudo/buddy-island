// Bildschirmrand «Buddy schaut hin». Der Hauptprozess setzt den Modus (perceive/off) und die
// Akzentfarbe per executeJavaScript und zeichnet Klickpunkte während der Steuerung.
// Kein Audio, keine Zeitschleife: alles läuft über CSS-Übergänge.

window.setMode = (mode) => {
  document.body.dataset.mode = mode === 'perceive' ? 'perceive' : 'off';
};

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
