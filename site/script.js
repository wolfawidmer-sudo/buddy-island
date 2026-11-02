// Kleine Vorschau-Animation: zeigt, was das Island alles kann.
(function () {
  const island = document.getElementById('demoIsland');
  const label = document.getElementById('demoLabel');
  const small = document.getElementById('demoSmall');
  const caption = document.getElementById('demoCaption');
  const screen = document.querySelector('.screen');
  const cursor = document.getElementById('demoCursor');
  if (!island) return;

  const scenes = [
    { state: 'idle', label: 'Buddy', caption: 'Im Ruhezustand ist Buddy nur ein kleines Island.', ms: 2600 },
    { state: 'busy', label: 'denkt …', caption: 'Frag etwas – Buddy denkt mit Claude nach.', ms: 2400 },
    { state: 'music', label: 'Blinding Lights · The Weeknd', caption: 'Musik aus Spotify oder YouTube erscheint im Island.', ms: 3000 },
    { state: 'peek', small: 'WhatsApp', label: 'Lea: Kommst du heute ins Training?', caption: 'Mitteilungen kommen oben statt unten rechts.', ms: 3200 },
    { state: 'timer', label: 'Pizza  9:58', caption: '«Stell einen Timer für die Pizza.»', ms: 2600, tick: true },
    { state: 'control', label: 'Klickt …', caption: 'Auf Wunsch bedient Buddy den PC – der Rand zeigt, dass er hinschaut.', ms: 4200, glow: true },
  ];

  let i = 0;
  let tickTimer = 0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function show(scene) {
    island.dataset.state = scene.state;
    label.textContent = scene.label;
    small.textContent = scene.small || '';
    caption.textContent = scene.caption;
    screen.classList.toggle('glowing', Boolean(scene.glow));
    clearInterval(tickTimer);
    if (scene.tick) {
      let s = 598;
      tickTimer = setInterval(() => {
        s -= 1;
        label.textContent = `Pizza  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 1000);
    }
    if (scene.glow) moveCursor();
  }

  function moveCursor() {
    const spots = [[28, 40], [62, 55], [45, 30]];
    spots.forEach(([x, y], n) => {
      setTimeout(() => {
        cursor.style.left = `${x}%`;
        cursor.style.top = `${y}%`;
        setTimeout(() => {
          cursor.classList.remove('click');
          void cursor.offsetWidth;
          cursor.classList.add('click');
        }, 900);
      }, n * 1300);
    });
  }

  function next() {
    show(scenes[i]);
    const ms = scenes[i].ms;
    i = (i + 1) % scenes.length;
    if (!reduced) setTimeout(next, ms);
  }

  // Animation nur laufen lassen, wenn die Vorschau sichtbar ist
  let started = false;
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !started) {
      started = true;
      next();
    }
  });
  io.observe(screen);
})();

// Download-Knopf direkt auf den neusten Installer zeigen lassen
(function () {
  const btn = document.getElementById('downloadBtn');
  const info = document.getElementById('downloadInfo');
  if (!btn || !window.fetch) return;
  fetch('https://api.github.com/repos/wolfawidmer-sudo/buddy-island/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((release) => {
      if (!release) return;
      const asset = (release.assets || []).find((a) => /Setup.*\.exe$/i.test(a.name));
      if (!asset) return;
      btn.href = asset.browser_download_url;
      if (info) info.textContent = `Gratis · Version ${String(release.tag_name || '').replace(/^v/, '')} · ${Math.round(asset.size / 1e6)} MB`;
    })
    .catch(() => {});
})();
