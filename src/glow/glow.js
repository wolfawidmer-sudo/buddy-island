// Wird vom Hauptprozess über executeJavaScript angesteuert.
window.setMode = (mode) => {
  document.body.dataset.mode = mode;
};

window.ripple = (x, y, kind) => {
  const dot = document.createElement('div');
  dot.className = 'ripple' + (kind === 'move' ? ' move' : '');
  dot.style.left = x + 'px';
  dot.style.top = y + 'px';
  document.body.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
};

// Akzentfarbe als leichter Hauch im sonst weiss-grauen Rand
window.setAccent = (color) => {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  document.documentElement.style.setProperty('--c3', `color-mix(in srgb, ${color} 35%, #ffffff)`);
};
