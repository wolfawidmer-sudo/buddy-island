(function () {
  const api = window.buddy;

  // ---------- Sprache (Wörterbuch kommt beim Start synchron aus dem Hauptprozess) ----------
  const I18N = api.i18n || { lang: 'de', dict: {}, locale: 'de-CH' };
  function t(text, vars) {
    let out = (I18N.lang !== 'de' && I18N.dict[text]) || text;
    if (vars) out = String(out).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return out;
  }
  // Feste Texte im HTML übersetzen (Textknoten und Attribute)
  function translateDom(root) {
    if (I18N.lang === 'de') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const raw = n.nodeValue;
      const key = raw.replace(/\s+/g, ' ').trim();
      if (key && I18N.dict[key]) n.nodeValue = raw.replace(raw.trim(), I18N.dict[key]);
    }
    for (const node of root.querySelectorAll('[placeholder],[title],[aria-label],[data-tip],[data-empty]')) {
      for (const a of ['placeholder', 'title', 'aria-label', 'data-tip', 'data-empty']) {
        const v = node.getAttribute(a);
        if (v && I18N.dict[v]) node.setAttribute(a, I18N.dict[v]);
      }
    }
  }
  document.documentElement.lang = I18N.lang;
  // Verfügbare Höhe (Fenster = höchstens 75 % des Bildschirms): die Listen scrollen darin
  const syncWindowHeight = () => document.documentElement.style.setProperty('--win-h', `${window.innerHeight}px`);
  syncWindowHeight();
  window.addEventListener('resize', syncWindowHeight);
  translateDom(document.body);
  const $ = (id) => document.getElementById(id);

  const el = {
    island: $('island'),
    label: $('label'),
    peek: $('peek'),
    peekApp: $('peekApp'),
    peekText: $('peekText'),
    faceBtn: $('faceBtn'),
    stopBtn: $('stopBtn'),
    newBtn: $('newBtn'),
    settingsBtn: $('settingsBtn'),
    closeBtn: $('closeBtn'),
    chatView: $('chatView'),
    settingsView: $('settingsView'),
    inbox: $('inbox'),
    inboxList: $('inboxList'),
    inboxClear: $('inboxClear'),
    timers: $('timers'),
    messages: $('messages'),
    empty: $('empty'),
    emptyTitle: $('emptyTitle'),
    emptyText: $('emptyText'),
    chips: $('chips'),
    connectBtn: $('connectBtn'),
    composer: $('composer'),
    input: $('input'),
    sendBtn: $('sendBtn'),
    footnote: $('footnote'),
    modelSelect: $('modelSelect'),
    effortSeg: $('effortSeg'),
    themeSeg: $('themeSeg'),
    notifyToggle: $('notifyToggle'),
    notifyStatus: $('notifyStatus'),
    dndBtn: $('dndBtn'),
    nameInput: $('nameInput'),
    promptInput: $('promptInput'),
    prefLength: $('prefLength'),
    prefStyle: $('prefStyle'),
    swatches: $('swatches'),
    customColor: $('customColor'),
    shortcutGroup: $('shortcutGroup'),
    customList: $('customList'),
    addShortcut: $('addShortcut'),
    hotkeyMsg: $('hotkeyMsg'),
    soundToggle: $('soundToggle'),
    autostartToggle: $('autostartToggle'),
    quitBtn: $('quitBtn'),
    pillCover: $('pillCover'),
    nowPlaying: $('nowPlaying'),
    nowCover: $('nowCover'),
    nowCoverEmpty: $('nowCoverEmpty'),
    nowTitle: $('nowTitle'),
    nowSub: $('nowSub'),
    agenda: $('agenda'),
    agendaList: $('agendaList'),
    micBtn: $('micBtn'),
    wakeToggle: $('wakeToggle'),
    wakeLabel: $('wakeLabel'),
    wakeWordInput: $('wakeWordInput'),
    wakeWordSave: $('wakeWordSave'),
    wakeWordMsg: $('wakeWordMsg'),
    eyesToggle: $('eyesToggle'),
    wakeEngine: $('wakeEngine'),
    wakeEngineRow: $('wakeEngineRow'),
    speakToggle: $('speakToggle'),
    cloudDictToggle: $('cloudDictToggle'),
    voiceStatus: $('voiceStatus'),
    mediaToggle: $('mediaToggle'),
    calStatus: $('calStatus'),
    calRemove: $('calRemove'),
    calInput: $('calInput'),
    calSave: $('calSave'),
    calLead: $('calLead'),
    calMsg: $('calMsg'),
    gameToggle: $('gameToggle'),
    displaySelect: $('displaySelect'),
    versionValue: $('versionValue'),
    updateStatus: $('updateStatus'),
    updateBtn: $('updateBtn'),
    diagBtn: $('diagBtn'),
    diagList: $('diagList'),
    logsBtn: $('logsBtn'),
    autoToggle: $('autoToggle'),
    modelLabel: $('modelLabel'),
    modelShort: $('modelShort'),
    routeToggle: $('routeToggle'),
    fallbackToggle: $('fallbackToggle'),
    permMedium: $('permMedium'),
    permHigh: $('permHigh'),
    historyToggle: $('historyToggle'),
    memoryToggle: $('memoryToggle'),
    memoryList: $('memoryList'),
    memoryClear: $('memoryClear'),
    historyList: $('historyList'),
    historyClear: $('historyClear'),
    rollbackBtn: $('rollbackBtn'),
    pillProgress: $('pillProgress'),
    langSelect: $('langSelect'),
    visualizerToggle: $('visualizerToggle'),
    bannerHint: $('bannerHint'),
    bannerOpen: $('bannerOpen'),
    bannerDismiss: $('bannerDismiss'),

    accountBtn: $('accountBtn'),
    accountView: $('accountView'),
    onboardingView: $('onboardingView'),
    cloudHint: $('cloudHint'),
    cloudHintText: $('cloudHintText'),
    cloudHintDismiss: $('cloudHintDismiss'),
    onboardingBtn: $('onboardingBtn'),  };

  const STORE_KEY = 'buddy.chat.v1';
  const MAX_HISTORY = 40;
  const GAP = 6; // Abstand zum oberen Rand (wie in css/tokens.css --island-gap)
  const CLOSED_H = 36 + GAP;
  const PEEK_H = 54 + GAP;
  const NOTCH_H = 12 + GAP;
  const OPEN_MS = 460;
  const CLOSE_MS = 340;
  // Feste Breiten im geschlossenen Zustand: kein Text, darum kein Messen und kein Springen
  const CLOSED_W = { idle: 112, busy: 112, done: 112, error: 112, timer: 112, alarm: 112, listen: 136, control: 152, music: 168, notch: 96 };
  const NOTCH_KEY = 'buddy.notch.v1';
  const PEEK_MS = 6000;

  const state = {
    open: false,
    view: 'chat',
    settings: null,
    models: [],
    stats: null, // { usage, history }
    history: loadHistory(), // [{ role, content, tools? }]
    stream: null, // { id, text, node, raf, tools }
    status: 'idle', // idle | busy | done | error
    control: false,
    actionLabel: '',
    recordingHotkey: false,
    timers: [], // { id, label, endsAt, durationMs }
    alarm: null,
    peek: null, // { app, title, body }
    inbox: [],
    media: null, // { title, artist, app, playing, cover }
    listening: '', // '' | 'starting' | 'listening'
    voiceNote: '', // kurze Meldung im Island, z. B. «Nichts gehört»
    game: { active: false, name: '' },
    missed: 0,
    update: { state: 'idle' },
    phase: 'closed', // closed | opening | open | closing
    openedAt: 0,
    cloud: null, // letzter Stand von Buddy Cloud (configured, signedIn …)
    onboardingStep: 0,
    notch: (() => { try { return localStorage.getItem(NOTCH_KEY) === '1'; } catch { return false; } })(),
  };
  let eyes = null; // Lebendige Augen, wird weiter unten erzeugt

  // ---------- Hilfsfunktionen ----------

  function loadHistory() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(data) ? data.filter((m) => m && (m.content || (m.tools && m.tools.length))) : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.history.slice(-MAX_HISTORY)));
    } catch {
      /* Speicher nicht verfügbar */
    }
  }

  // «Spotify.exe», «Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic», «chrome» -> lesbarer Name
  function appName(id) {
    let n = String(id || '').split('!').pop().split('\\').pop();
    n = n.replace(/\.exe$/i, '').replace(/_[a-z0-9]{10,}$/i, '').split('.').pop();
    if (/^[0-9a-f]{12,}$/i.test(n)) return ''; // z. B. Firefox meldet nur eine Kennung
    const known = { zunemusic: t('Medienwiedergabe'), msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', vlc: 'VLC', spotify: 'Spotify' };
    return known[n.toLowerCase()] || n.charAt(0).toUpperCase() + n.slice(1);
  }

  function modelLabel(id) {
    const found = state.models.find((m) => m.id === id);
    if (found) return found.name.replace(/^Claude\s+/i, '');
    return (id || '')
      .replace(/^claude-/, '')
      .replace(/-(\d+)-(\d+)$/, ' $1.$2')
      .replace(/-/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  const EFFORT_LABEL = { low: t('Schnell'), medium: t('Normal'), high: t('Gründlich'), xhigh: t('Sehr gründlich'), max: t('Maximal') };

  function usd(v) {
    const n = Number(v) || 0;
    if (n === 0) return '$0.00';
    if (n < 0.001) return '< $0.001';
    if (n < 0.1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
  }

  function tokens(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    if (v < 1e6) return `${(v / 1000).toFixed(1)}k`;
    return t('{n} Mio.', { n: (v / 1e6).toFixed(2) });
  }

  function prettyHotkey(acc) {
    return (acc || '')
      .replace(/CommandOrControl|Control/g, t('Strg'))
      .replace(/Shift/g, t('Umschalt'))
      .replace(/Space/g, t('Leertaste'))
      .replace(/Super/g, 'Win')
      .replace(/Delete/g, t('Entf'))
      .replace(/Backspace/g, t('Rücktaste'))
      .replace(/\bUp\b/g, '↑').replace(/\bDown\b/g, '↓').replace(/\bLeft\b/g, '←').replace(/\bRight\b/g, '→')
      .replace(/num(\d)/g, 'Num $1')
      .replace(/\+/g, ' + ');
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clock = (ts) => new Date(ts).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
  const capitalize = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);

  function countdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  // ---------- Island-Zustand ----------

  function setStatus(status) {
    state.status = status;
    render();
  }

  // Was das Island gerade zeigt (wichtigstes zuerst)
  function visibleState() {
    if (state.alarm) return 'alarm';
    if (state.control) return 'control';
    if (state.listening || state.voiceNote) return 'listen';
    if (state.peek && !state.open) return 'peek';
    if (state.status !== 'idle') return state.status;
    // Im Notch-Modus bleiben ruhige Zustände klein; Aktivität zeigt das Island normal
    if (state.notch && !state.open) return 'notch';
    if (state.timers.length && !state.open) return 'timer';
    if (state.media && !state.open && state.settings?.media !== false) return 'music';
    return 'idle';
  }

  function labelFor(shown) {
    const name = state.settings?.name || t('Buddy');
    const next = state.timers[0];
    switch (shown) {
      case 'busy':
        if (state.stream?.text) return t('schreibt …');
        if (state.stream?.tools.length) return t('macht …');
        return t('denkt …');
      case 'done': return t('Fertig');
      case 'error': return t('Fehler');
      case 'timer': return next ? `${next.label}  ${countdown(next.endsAt - Date.now())}` : name;
      case 'alarm': return state.alarm ? t('{label} ist um', { label: state.alarm.label }) : name;
      case 'control': return `${capitalize(state.actionLabel || t('steuert'))} …`;
      case 'listen': return state.voiceNote
        || (state.listening === 'transcribing' ? t('Schreibt auf …')
          : state.listening === 'listening' ? (state.voicePreview ? previewTail(state.voicePreview) : t('Hört zu …'))
            : t('Mikrofon startet …'));
      case 'music': return [state.media?.title, state.media?.artist].filter(Boolean).join(' · ');
      default: return name;
    }
  }

  const VIEW_TITLE = { settings: t('Einstellungen'), usage: t('KI-Nutzung') };

  function render() {
    const shown = visibleState();
    if (el.island.dataset.state !== shown) el.island.dataset.state = shown;
    // Aktivität oder offenes Island weckt Buddy; in Ruhe laufen die Augen selbst weiter
    if (shown !== 'idle' || state.open) eyes?.wake();
    eyes?.sync();
    el.island.classList.toggle('paused', Boolean(state.media && !state.media.playing));
    el.island.classList.toggle('listening', Boolean(state.listening));
    // Sichtbarer Text nur im offenen Island; geschlossen nur für Screenreader
    const title = state.open
      ? (shown === 'alarm' || shown === 'control' ? labelFor(shown) : VIEW_TITLE[state.view] || state.settings?.name || t('Buddy'))
      : null;
    if (title !== null && el.label.textContent !== title) el.label.textContent = title;
    el.faceBtn.setAttribute('aria-label', state.open ? t('Buddy') : labelFor(shown));
    el.peek.hidden = shown !== 'peek';
    syncLayout();
    syncVisualizer();
  }

  // ---------- Musik-Visualizer (echte Frequenzbänder der Windows-Tonausgabe) ----------
  // Die Balken bewegen sich nur, wenn der Hauptprozess echten Ton meldet (audio:active).
  // Ohne Signal stehen sie still – es gibt keine Ersatz-Animation.
  const bars = [...el.island.querySelectorAll('.eq i')];
  const viz = { on: false, live: false, levels: [0, 0, 0, 0], target: null, raf: 0, lastAt: 0, last: 0 };

  function syncVisualizer() {
    const on = Boolean(state.settings?.visualizer !== false && visibleState() === 'music' && !state.game.active);
    if (on === viz.on) return;
    viz.on = on;
    if (on && viz.live && !viz.raf) viz.raf = requestAnimationFrame(paintViz);
    if (!on) stopViz();
  }

  function stopViz() {
    cancelAnimationFrame(viz.raf);
    viz.raf = 0;
    viz.levels = [0, 0, 0, 0];
    el.island.classList.remove('viz-live');
    bars.forEach((b) => { b.style.transform = ''; });
  }

  api.onAudioActive((active) => {
    viz.live = Boolean(active);
    if (state.settings) state.settings.musicActive = viz.live;
    // Pause/Ende: Balken sinken weich ab (paintViz läuft aus), danach Ruhe
    if (viz.live && viz.on && !viz.raf) viz.raf = requestAnimationFrame(paintViz);
  });

  api.onAudioLevel((f) => {
    viz.target = f;
    viz.lastAt = performance.now();
    if (viz.on && !viz.raf) viz.raf = requestAnimationFrame(paintViz);
  });

  // Vier Balken = vier Bereiche: Bass, untere Mitten, Mitten, Höhen.
  // Schneller Anstieg, weiches Abklingen (Zeitkonstanten in Sekunden).
  const VIZ_TAU = [[0.03, 0.2], [0.04, 0.24], [0.04, 0.22], [0.02, 0.14]];
  function paintViz(now) {
    viz.raf = 0;
    const dt = viz.last ? Math.min(0.05, (now - viz.last) / 1000) : 1 / 60;
    viz.last = now;
    const fresh = viz.live && now - viz.lastAt < 200 && viz.target;
    const f = fresh ? viz.target : { bass: 0, mid: 0, treble: 0 };
    const want = [f.bass, 0.55 * f.bass + 0.45 * f.mid, f.mid, f.treble];
    let moving = false;
    for (let i = 0; i < bars.length; i += 1) {
      const cur = viz.levels[i];
      const [up, down] = VIZ_TAU[i];
      const next = cur + (want[i] - cur) * (1 - Math.exp(-dt / (want[i] > cur ? up : down)));
      viz.levels[i] = next;
      if (next > 0.01) moving = true;
      bars[i].style.transform = `scaleY(${(0.18 + 0.82 * Math.min(1, next)).toFixed(3)})`;
    }
    el.island.classList.add('viz-live');
    if (viz.on && (fresh || moving)) viz.raf = requestAnimationFrame(paintViz);
    else { viz.last = 0; el.island.classList.remove('viz-live'); }
  }

  // ---------- Fenstergrösse (spart CPU: geschlossen = nur so gross wie das Island) ----------

  const measure = document.createElement('span');
  measure.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:600 13px/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums';
  document.body.appendChild(measure);

  function textWidth(text) {
    measure.textContent = text;
    return measure.getBoundingClientRect().width;
  }

  function closedSize() {
    const shown = visibleState();
    if (shown === 'peek') {
      const w = Math.max(textWidth(el.peekText.textContent), textWidth(el.peekApp.textContent) * 0.9);
      return { width: Math.ceil(Math.min(360, Math.max(240, 48 + w + 20)) / 8) * 8, height: PEEK_H, notch: false };
    }
    if (shown === 'notch') return { width: CLOSED_W.notch, height: NOTCH_H, notch: true };
    return { width: CLOSED_W[shown] || CLOSED_W.idle, height: CLOSED_H, notch: false };
  }

  let windowSize = { open: false, width: 112, height: CLOSED_H, notch: false };
  let shrinkTimer = 0;

  function sendLayout(next) {
    windowSize = next;
    api.setLayout(next);
  }

  function syncLayout() {
    if (state.open) {
      clearTimeout(shrinkTimer);
      if (!windowSize.open) sendLayout({ open: true });
      return;
    }
    const size = closedSize();
    const w = size.width + 'px';
    if (el.island.style.getPropertyValue('--w') !== w) el.island.style.setProperty('--w', w);
    const grows = !windowSize.open && size.width >= windowSize.width && size.height >= windowSize.height;
    if (grows) {
      clearTimeout(shrinkTimer);
      if (size.width !== windowSize.width || size.height !== windowSize.height || size.notch !== windowSize.notch) sendLayout({ open: false, ...size });
      return;
    }
    // Kleiner werden erst, wenn die Animation fertig ist
    clearTimeout(shrinkTimer);
    shrinkTimer = setTimeout(() => {
      if (state.open) return;
      sendLayout({ open: false, ...closedSize() });
    }, CLOSE_MS + 60);
  }

  // ---------- Öffnen & Schliessen ----------

  let openTimer = 0;
  let phaseTimer = 0;

  // Wartet, bis das Fenster wirklich gross ist (sonst würde die Animation abgeschnitten)
  function whenWindowIsLarge(cb) {
    const started = performance.now();
    const check = () => {
      if (!state.open) return;
      if (window.innerWidth >= 500 || performance.now() - started > 120) cb();
      else openTimer = requestAnimationFrame(check);
    };
    openTimer = requestAnimationFrame(check);
  }

  const isAnimating = () => state.phase === 'opening' || state.phase === 'closing';
  let lastToggle = 0;

  function setPhase(phase, ms) {
    state.phase = phase;
    el.island.dataset.phase = phase;
    clearTimeout(phaseTimer);
    if (ms) phaseTimer = setTimeout(() => setPhase(phase === 'opening' ? 'open' : 'closed'), ms);
  }

  function open(view) {
    if (!view && state.settings && !state.settings.onboarded) view = 'onboarding';
    if (view) showView(view);
    if (state.alarm) stopAlarm();
    if (state.status === 'done' || state.status === 'error') state.status = state.stream ? 'busy' : 'idle';
    state.peek = null;
    if (!state.open) {
      state.open = true;
      state.openedAt = Date.now();
      clearTimeout(shrinkTimer);
      sendLayout({ open: true });
      cancelAnimationFrame(openTimer);
      whenWindowIsLarge(() => {
        if (!state.open) return;
        // Ein Frame Pause, damit der Startzustand sicher gezeichnet ist
        requestAnimationFrame(() => {
          if (!state.open) return;
          setPhase('opening', OPEN_MS);
          el.island.classList.add('open');
          if (state.view === 'chat') el.input.focus({ preventScroll: true });
          scrollToBottom(true);
        });
      });
    }
    renderInbox();
    renderNowPlaying();
    renderAgenda();
    renderEmpty();
    render();
  }

  function close() {
    cancelAnimationFrame(openTimer);
    if (!state.open) return;
    state.open = false;
    stopHotkeyRecording();
    setPhase('closing', CLOSE_MS);
    el.island.classList.remove('open');
    captured = el.island.matches(':hover');
    api.releaseWindow();
    if (captured) api.setMouseCapture(true);
    render();
    // Ansicht erst zurücksetzen, wenn der Inhalt ausgeblendet ist (kein Umschalten während der Animation)
    setTimeout(() => {
      if (!state.open && state.view !== 'chat') showView('chat');
    }, CLOSE_MS);
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  function showView(view) {
    if (state.view === 'onboarding' && view !== 'onboarding') leaveOnboarding();
    state.view = view;
    el.chatView.hidden = view !== 'chat';
    el.settingsView.hidden = view !== 'settings';
    el.accountView.hidden = view !== 'account';
    el.onboardingView.hidden = view !== 'onboarding';
    el.settingsBtn.classList.toggle('active', view === 'settings');
    el.accountBtn.classList.toggle('active', view === 'account');
    el.island.classList.toggle('onboarding', view === 'onboarding');
    if (view === 'settings') { fillSettings(); loadAiStats(); }
    if (view === 'account') { api.cloud.reload?.(); renderCloud(); }
    if (view === 'onboarding') renderOnboarding();
    if (view === 'chat' && state.open) renderAgenda();
    renderCloudHint();
    render();
  }

  // Das Fenster ist immer gleich gross. Klicks fängt es nur ab, solange die Maus über
  // dem Island ist (oder gerade gezogen wird); sonst gehen sie an die Fenster darunter.
  let captured = false;
  function setCapture(on) {
    if (captured === on) return;
    captured = on;
    api.setMouseCapture(on);
  }
  el.island.addEventListener('mouseenter', () => { setCapture(true); eyes?.wake(); });
  el.island.addEventListener('mouseleave', () => { if (!drag.active) setCapture(false); });

  // ---------- Blinzeln (nur ein kurzer Timer, keine Dauer-Animation) ----------

  (function blinkLoop() {
    setTimeout(() => {
      const shown = visibleState();
      const sleepy = shown === 'idle' && el.island.dataset.eyes === 'asleep';
      if (!document.hidden && !sleepy && (shown === 'idle' || shown === 'timer' || shown === 'peek')) {
        for (const eye of el.island.querySelectorAll('.eye')) {
          eye.classList.add('blink');
          eye.addEventListener('animationend', () => eye.classList.remove('blink'), { once: true });
        }
      }
      blinkLoop();
    }, 3500 + Math.random() * 4500);
  })();

  // ---------- Lebendige Augen: Schlafzyklus (src/renderer/eyes.js) ----------
  eyes = window.BuddyEyes?.createEyes({
    island: el.island,
    active: () => state.settings?.eyesAlive !== false && !state.open && !state.game.active && !document.hidden && visibleState() === 'idle',
    calm: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  }) || null;
  eyes?.start();

  function pop() {
    el.island.classList.remove('pop');
    void el.island.offsetWidth;
    el.island.classList.add('pop');
  }

  // ---------- Chat-Darstellung ----------

  function scrollToBottom(force) {
    const box = el.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function userBubble(text) {
    const node = document.createElement('div');
    node.className = 'bubble user';
    node.textContent = text;
    return node;
  }

  function toolChip(tool) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip' + (tool.error ? ' err' : '');
    chip.textContent = tool.label;
    return chip;
  }

  function toolRow(list) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    for (const item of list || []) row.appendChild(toolChip(item));
    return row;
  }

  // Teile einer Antwort immer in derselben Reihenfolge
  const PART_ORDER = ['route', 'plan', 'tool-row', 'md', 'msg-tools'];

  function placePart(node, part) {
    const rank = PART_ORDER.indexOf(part.classList[0]);
    const after = [...node.children].find((c) => PART_ORDER.indexOf(c.classList[0]) > rank);
    node.insertBefore(part, after || null);
    return part;
  }

  function routeLine(route, extra = {}) {
    const box = document.createElement('div');
    box.className = 'route';
    if (!route) return box;
    const dot = document.createElement('i');
    dot.className = `tier ${route.tier || ''}`;
    const model = document.createElement('b');
    const chain = (extra.models && extra.models.length > 1) ? extra.models.join(' → ') : route.modelName || '';
    model.textContent = chain;
    const parts = [dot, model];
    const add = (text, cls) => {
      const sep = document.createElement('span');
      sep.className = 'sep';
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = text;
      parts.push(sep, span);
    };
    add(EFFORT_LABEL[route.effort] || t('Standard'));
    const cost = extra.final ? usd(extra.cost) : extra.cost ? usd(extra.cost) : route.estimate ? `≈ ${usd(route.estimate)}` : '';
    if (cost) add(cost, 'cost');
    if (extra.final && extra.tokens) add(t('{n} Tokens', { n: tokens(extra.tokens) }));
    if (route.reason) {
      const reason = document.createElement('span');
      reason.className = 'reason';
      reason.textContent = extra.switchNote || route.reason;
      reason.title = route.reason;
      parts.push(reason);
    }
    box.append(...parts);
    return box;
  }

  function planCard(steps) {
    const box = document.createElement('div');
    box.className = 'plan';
    for (const step of steps || []) {
      const row = document.createElement('div');
      row.className = `plan-step ${step.status}`;
      const icon = document.createElement('i');
      const title = document.createElement('span');
      title.textContent = step.title + (step.note && step.status === 'failed' ? ` – ${step.note}` : '');
      row.append(icon, title);
      box.appendChild(row);
    }
    return box;
  }

  function showRouting() {
    return state.settings?.showRouting === true;
  }

  function assistantBubble(text, toolList, extra = {}) {
    const node = document.createElement('div');
    node.className = 'bubble assistant';
    if (extra.route && showRouting()) {
      placePart(node, routeLine(extra.route, { final: Boolean(extra.usage), cost: extra.usage?.cost, tokens: (extra.usage?.input_tokens || 0) + (extra.usage?.output_tokens || 0), models: extra.usage?.models }));
    }
    if (extra.plan && extra.plan.length) placePart(node, planCard(extra.plan));
    if (toolList && toolList.length) placePart(node, toolRow(toolList));
    if (!text) return node;
    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = window.renderMarkdown(text);
    placePart(node, body);

    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = t('Kopieren');
    copy.addEventListener('click', () => copyText(text, copy));
    tools.appendChild(copy);
    placePart(node, tools);
    return node;
  }

  function typingBubble() {
    const node = document.createElement('div');
    node.className = 'bubble assistant';
    node.innerHTML = '<div class="md"><span class="typing"><i></i><i></i><i></i></span></div>';
    return node;
  }

  function noticeNode(text, soft, detail) {
    const node = document.createElement('div');
    node.className = 'notice' + (soft ? ' soft' : '');
    const span = document.createElement('span');
    span.textContent = text;
    node.appendChild(span);
    // Technische Angaben (Anbieter, Modell, Fehlercode) nur auf Wunsch: eingeklappt unter «Details»
    if (detail) {
      const more = document.createElement('details');
      more.className = 'notice-more';
      const summary = document.createElement('summary');
      summary.textContent = t('Details');
      const small = document.createElement('small');
      small.className = 'notice-detail';
      small.textContent = detail;
      more.append(summary, small);
      node.appendChild(more);
    }
    return node;
  }

  function renderHistory() {
    el.messages.textContent = '';
    for (const msg of state.history) {
      el.messages.appendChild(msg.role === 'user' ? userBubble(msg.content) : assistantBubble(msg.content, msg.tools, msg));
    }
    markLastAssistant();
    renderEmpty();
    scrollToBottom(true);
  }

  // Leerer Chat: ohne Konto ein Anmelde-Hinweis statt Eingabefeld, sonst Vorschläge
  function renderEmpty() {
    const s = state.settings;
    const ready = Boolean(s?.hasKey);
    const isEmpty = state.history.length === 0 && !state.stream;
    el.empty.hidden = ready ? !isEmpty : false;
    el.chips.hidden = !ready;
    el.connectBtn.hidden = ready;
    if (ready) {
      el.emptyTitle.textContent = t('Was kann ich für dich tun?');
      el.emptyText.textContent = '';
    } else {
      el.emptyTitle.textContent = t('Hoi, ich bin {name}.', { name: s?.name || t('Buddy') });
      el.emptyText.textContent = state.cloud && !state.cloud.configured
        ? t('Buddy Cloud ist gerade nicht erreichbar. Versuch es später nochmals.')
        : t('Melde dich bei Buddy Cloud an, dann kann es losgehen.');
    }
    el.composer.hidden = !ready;
    renderCloudHint();
    updateFootnote();
  }

  // Einmaliger Hinweis für bestehende Nutzer (eigene Keys und lokale KI gibt es nicht mehr)
  function renderCloudHint() {
    const notice = state.settings?.cloudNotice;
    el.cloudHint.hidden = !notice || state.view !== 'chat';
    if (!notice) return;
    el.cloudHintText.textContent = notice === 'keys-removed'
      ? t('Neu: Buddy läuft jetzt über Buddy Cloud. Eigene API-Keys und lokale KI gibt es nicht mehr, gespeicherte Keys wurden gelöscht.')
      : t('Neu: Buddy läuft jetzt über Buddy Cloud. Melde dich an, um weiter zu chatten.');
  }

  function updateFootnote() {
    el.footnote.textContent = '';
    el.footnote.hidden = true;
  }

  async function copyText(text, button) {
    let ok = false;
    try { ok = await api.writeClipboard(text); } catch { ok = false; }
    if (!ok) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
    }
    if (!button) return ok;
    clearTimeout(button._copyTimer);
    if (button._copyLabel == null) button._copyLabel = button.textContent;
    button.textContent = ok ? t('Kopiert') : t('Kopieren fehlgeschlagen');
    button.classList.toggle('ok', ok);
    button.classList.toggle('bad', !ok);
    button._copyTimer = setTimeout(() => {
      button.textContent = button._copyLabel;
      button._copyLabel = null;
      button.classList.remove('ok', 'bad');
    }, 1600);
    return ok;
  }

  el.messages.addEventListener('click', (event) => {
    const copyBtn = event.target.closest('.codeblock .copy');
    if (copyBtn) {
      copyText(copyBtn.parentElement.querySelector('code').textContent, copyBtn);
      return;
    }
    const link = event.target.closest('a[href]');
    if (link) {
      event.preventDefault();
      api.openLink(link.href);
    }
  });

  // ---------- Senden & Streaming ----------

  function apiMessages() {
    const msgs = state.history
      .slice(-MAX_HISTORY)
      .map(({ role, content, tools }) => ({
        role,
        content: tools && tools.length ? `[${t('Erledigt')}: ${tools.map((x) => x.label).join(', ')}]\n\n${content || ''}`.trim() : content,
      }))
      .filter((m) => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const merged = [];
    for (const m of msgs) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === m.role) prev.content += '\n\n' + m.content;
      else merged.push({ ...m });
    }
    return merged;
  }

  function send(text, viaVoice = false) {
    const clean = text.trim();
    if (!clean || state.stream) return;
    if (!state.settings?.hasKey) { open('account'); return; }

    state.history.push({ role: 'user', content: clean });
    saveHistory();
    el.empty.hidden = true;
    el.messages.querySelector('.regen')?.remove();
    el.messages.appendChild(userBubble(clean));
    el.input.value = '';
    autoGrow();
    startStream(viaVoice);
  }

  // Letzte Antwort neu erzeugen: die alte Antwort fällt weg, die Frage bleibt
  function regenerate() {
    if (state.stream || !state.settings?.hasKey) return;
    const last = state.history[state.history.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (state.history[state.history.length - 2]?.role !== 'user') return;
    state.history.pop();
    saveHistory();
    const nodes = el.messages.querySelectorAll('.bubble.assistant');
    nodes[nodes.length - 1]?.remove();
    for (const n of el.messages.querySelectorAll('.notice')) if (n === el.messages.lastElementChild) n.remove();
    startStream(false);
  }

  // «Neu generieren» nur unter der letzten Antwort
  function markLastAssistant() {
    for (const b of el.messages.querySelectorAll('.regen')) b.remove();
    const last = state.history[state.history.length - 1];
    if (!last || last.role !== 'assistant' || state.stream) return;
    const nodes = el.messages.querySelectorAll('.bubble.assistant');
    const tools = nodes[nodes.length - 1]?.querySelector('.msg-tools');
    if (!tools) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'regen';
    btn.textContent = t('Neu generieren');
    btn.addEventListener('click', regenerate);
    tools.appendChild(btn);
  }

  function startStream(viaVoice) {
    const id = uid();
    const node = typingBubble();
    el.messages.appendChild(node);
    scrollToBottom(true);
    state.stream = { id, text: '', node, raf: 0, tools: [], voice: viaVoice, route: null, plan: null, cost: 0, switchNote: '' };
    stopSpeaking();
    el.island.classList.add('streaming');
    setStatus('busy');
    updateSendButton();
    const lastAssistant = [...state.history].reverse().find((m) => m.role === 'assistant' && m.route);
    api.sendChat(id, apiMessages(), { lastTier: lastAssistant?.route?.tier || null });
  }

  function paintStream() {
    const s = state.stream;
    if (!s) return;
    s.raf = 0;
    if (!s.text) return;
    let body = s.node.querySelector('.md');
    if (!body) {
      body = document.createElement('div');
      body.className = 'md';
      placePart(s.node, body);
    }
    body.innerHTML = window.renderMarkdown(s.text);
    const last = body.lastElementChild;
    if (last && !last.classList.contains('codeblock')) last.classList.add('cursor');
    scrollToBottom(false);
  }

  function finishStream({ error, errorDetail, stopReason, usage }) {
    const s = state.stream;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    state.stream = null;
    state.control = false;
    el.island.classList.remove('streaming');
    updateSendButton();
    el.messages.querySelector('.confirm')?.remove();

    const text = s.text;
    const entry = { role: 'assistant', content: text || '', tools: s.tools };
    if (s.route) entry.route = { model: s.route.model, modelName: s.route.modelName, tier: s.route.tier, effort: s.route.effort, reason: s.route.reason, estimate: s.route.estimate };
    if (s.plan) entry.plan = s.plan;
    if (usage) entry.usage = { cost: usage.cost || 0, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, models: usage.models || [] };
    if (text || s.tools.length || (s.plan && s.plan.length)) {
      s.node.replaceWith(assistantBubble(text, s.tools, entry));
      state.history.push(entry);
      saveHistory();
      markLastAssistant();
    } else if (s.route && usage && showRouting()) {
      s.node.replaceWith(assistantBubble('', [], entry));
    } else {
      s.node.remove();
    }
    if (state.view === 'settings') loadAiStats();
    if (stopReason === 'max_tokens') el.messages.appendChild(noticeNode(t('Die Antwort wurde gekürzt (Längenlimit).'), true));
    if (stopReason === 'aborted') el.messages.appendChild(noticeNode('Gestoppt.', true));
    if (stopReason === 'refusal' && !text) el.messages.appendChild(noticeNode(t('Dabei kann ich leider nicht helfen.'), true));

    if (error) {
      el.messages.appendChild(noticeNode(error, false, errorDetail));
      state.status = 'error';
    } else if (stopReason === 'aborted') {
      state.status = 'idle';
    } else {
      state.status = state.open ? 'idle' : 'done';
      if (!state.open) pop();
      if (s.voice && state.settings?.speak && text) speak(text);
      else if (state.settings?.sound && !state.game.active && (!state.open || !document.hasFocus())) chime();
    }
    render();
    scrollToBottom(true);
  }

  api.onDelta(({ id, text }) => {
    const s = state.stream;
    if (!s || s.id !== id) return;
    const first = !s.text;
    s.text += text;
    if (first) render();
    if (!s.raf) s.raf = requestAnimationFrame(paintStream);
  });

  api.onDone(({ id, stopReason, usage }) => {
    if (state.stream?.id === id) finishStream({ stopReason, usage });
  });

  api.onError(({ id, message, code, error }) => {
    if (state.stream?.id !== id) return;
    finishStream({ error: message, errorDetail: error?.detail || '' });
    if (code === 'key' && state.settings) {
      state.settings.keyStatus = 'invalid';
      renderEmpty();
    }
  });

  // Modellwahl des Routers (und spätere Wechsel)
  function paintRoute() {
    const s = state.stream;
    if (!s || !s.route) return;
    s.node.querySelector('.route')?.remove();
    if (!showRouting()) return;
    placePart(s.node, routeLine(s.route, { cost: s.cost, switchNote: s.switchNote }));
  }

  api.onRoute((route) => {
    const s = state.stream;
    if (!s || s.id !== route.id) return;
    if (route.switched && s.route && s.route.modelName !== route.modelName) {
      s.switchNote = route.why ? t('Wechsel auf {model}: {why}', { model: route.modelName, why: route.why }) : t('Wechsel auf {model}', { model: route.modelName });
    }
    s.route = route;
    paintRoute();
    scrollToBottom(false);
  });

  api.onEscalate(({ id, to, reason }) => {
    const s = state.stream;
    if (!s || s.id !== id) return;
    s.switchNote = t('Stärkeres Modell: {model} · {reason}', { model: to, reason });
    addStreamTool({ label: t('Wechsel auf {model}', { model: to }) });
    paintRoute();
  });

  api.onCost(({ id, cost }) => {
    const s = state.stream;
    if (!s || s.id !== id) return;
    s.cost = cost;
    paintRoute();
  });

  api.onPlan(({ id, steps }) => {
    const s = state.stream;
    if (!s || s.id !== id) return;
    s.plan = steps;
    s.node.querySelector('.plan')?.remove();
    s.node.querySelector('.typing')?.parentElement.remove();
    placePart(s.node, planCard(steps));
    render();
    scrollToBottom(false);
  });

  // Verbindung brach mitten in der Antwort ab: angefangenen Text zurücknehmen
  api.onRewind(({ id, chars }) => {
    const s = state.stream;
    if (!s || s.id !== id || !chars) return;
    s.text = s.text.slice(0, Math.max(0, s.text.length - chars));
    if (!s.raf) s.raf = requestAnimationFrame(paintStream);
  });

  api.onNotice(({ id, text }) => {
    if (state.stream?.id !== id) return;
    el.messages.appendChild(noticeNode(text, true));
    scrollToBottom(true);
  });

  api.onKeyStatus((status) => {
    if (!state.settings) return;
    state.settings.keyStatus = status;
    if (state.view === 'settings') fillSettings();
  });

  api.onTool(({ id, label, error }) => {
    if (state.stream?.id === id) addStreamTool({ label, error });
  });

  function addStreamTool(tool) {
    const s = state.stream;
    s.tools.push(tool);
    let row = s.node.querySelector('.tool-row');
    if (!row) row = placePart(s.node, toolRow([]));
    s.node.querySelector('.typing')?.parentElement.remove();
    row.appendChild(toolChip(tool));
    render();
    scrollToBottom(false);
  }

  // ---------- PC-Steuerung ----------

  api.onConfirm(({ id }) => {
    if (state.stream?.id !== id) return;
    if (!state.open) open('chat');
    showView('chat');
    const card = document.createElement('div');
    card.className = 'confirm';
    card.innerHTML =
      '<p class="confirm-title"></p><p class="confirm-text"></p>' +
      '<div class="confirm-actions"><button type="button" class="button" data-allow="0">Nicht erlauben</button>' +
      '<button type="button" class="button primary" data-allow="1">Erlauben</button></div>';
    card.querySelector('.confirm-title').textContent = `Darf ${state.settings?.name || t('Buddy')} deinen PC steuern?`;
    card.querySelector('.confirm-text').textContent =
      t('Ich sehe dann deinen Bildschirm und benutze Maus und Tastatur, bis die Aufgabe fertig ist. Stoppen kannst du jederzeit mit {keys} oder dem Stopp-Knopf.', { keys: prettyHotkey(state.settings?.hotkey) });
    card.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-allow]');
      if (!btn) return;
      event.stopPropagation();
      const allow = btn.dataset.allow === '1';
      card.remove();
      api.confirmControl(id, allow);
      if (allow) close();
    });
    el.messages.appendChild(card);
    scrollToBottom(true);
    card.querySelector('.primary').focus();
  });

  // Freigabe für Aktionen mit mittlerem oder hohem Risiko
  api.onPermission(({ id, reqId, level, label, summary, details }) => {
    if (state.stream?.id !== id) {
      api.replyPermission(id, reqId, false);
      return;
    }
    if (!state.open) open('chat');
    showView('chat');
    const high = level === 'high';
    const card = document.createElement('div');
    card.className = `confirm ${high ? 'high' : 'medium'}`;
    card.innerHTML =
      '<span class="risk"></span><p class="confirm-title"></p><p class="confirm-text"></p>' +
      '<div class="confirm-actions"><button type="button" class="button" data-allow="0">Ablehnen</button>' +
      '<button type="button" class="button primary" data-allow="1"></button></div>';
    card.querySelector('.risk').textContent = `${high ? t('Hohes') : t('Mittleres')} Risiko · ${label}`;
    card.querySelector('.confirm-title').textContent = high ? `${state.settings?.name || t('Buddy')} möchte etwas Riskantes tun` : `Darf ${state.settings?.name || t('Buddy')} das?`;
    card.querySelector('.confirm-text').textContent = summary || label;
    if (details) {
      const pre = document.createElement('div');
      pre.className = 'confirm-detail';
      pre.textContent = details;
      card.insertBefore(pre, card.querySelector('.confirm-actions'));
    }
    card.querySelector('.primary').textContent = high ? t('Ja, ausführen') : t('Für diese Aufgabe erlauben');
    card.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-allow]');
      if (!btn) return;
      event.stopPropagation();
      card.remove();
      api.replyPermission(id, reqId, btn.dataset.allow === '1');
    });
    el.messages.appendChild(card);
    scrollToBottom(true);
    // Bei hohem Risiko nicht vorauswählen: bewusst klicken
    card.querySelector(high ? '[data-allow="0"]' : '.primary').focus();
    if (state.settings?.sound && !state.game.active) chime(true);
  });

  api.onControl(({ id, active, actions }) => {
    if (state.stream?.id !== id) return;
    state.control = active;
    if (!active && actions) addStreamTool({ label: `${t('PC gesteuert')} · ${actions} ${actions === 1 ? t('Schritt') : t('Schritte')}` });
    render();
  });

  api.onAction(({ id, label }) => {
    if (state.stream?.id !== id) return;
    state.actionLabel = label;
    if (state.control) render();
  });

  el.stopBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.listening) { stopVoice(); return; }
    if (state.stream) api.abortChat(state.stream.id);
  });

  // ---------- Eingabe ----------

  function updateSendButton() {
    el.sendBtn.disabled = !state.stream && !el.input.value.trim();
    el.sendBtn.setAttribute('aria-label', state.stream ? t('Stoppen') : t('Senden'));
  }

  function autoGrow() {
    el.input.style.height = '';
    if (el.input.value) el.input.style.height = Math.min(el.input.scrollHeight, 150) + 'px';
    updateSendButton();
  }

  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(el.input.value);
    }
  });

  el.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.stream) api.abortChat(state.stream.id);
    else send(el.input.value);
  });

  el.chips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip?.dataset.send) send(chip.dataset.send);
  });

  function newChat() {
    if (state.stream) api.abortChat(state.stream.id);
    state.history = [];
    saveHistory();
    renderHistory();
    showView('chat');
    setStatus('idle');
    el.input.focus();
  }

  // ---------- Timer ----------

  let timerTick = 0;

  function renderTimers() {
    el.timers.textContent = '';
    el.timers.hidden = state.timers.length === 0;
    for (const timer of state.timers) {
      const row = document.createElement('div');
      row.className = 'timer';
      const label = document.createElement('span');
      label.className = 'timer-label';
      label.textContent = timer.label;
      const time = document.createElement('span');
      time.className = 'timer-time';
      time.dataset.endsAt = timer.endsAt;
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.title = t('Timer stoppen');
      stop.setAttribute('aria-label', t('Timer stoppen'));
      stop.innerHTML = '<svg viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8"/></svg>';
      stop.addEventListener('click', () => api.cancelTimer(timer.id));
      const bar = document.createElement('i');
      bar.className = 'timer-bar';
      bar.dataset.endsAt = timer.endsAt;
      bar.dataset.total = timer.durationMs;
      row.append(label, time, stop, bar);
      el.timers.appendChild(row);
    }
    clearInterval(timerTick);
    timerTick = 0;
    if (state.timers.length) {
      tickTimers();
      timerTick = setInterval(tickTimers, 1000); // läuft nur, solange ein Timer läuft
    }
  }

  function tickTimers() {
    const now = Date.now();
    if (state.open) {
      for (const node of el.timers.querySelectorAll('.timer-time')) node.textContent = countdown(Number(node.dataset.endsAt) - now);
      for (const bar of el.timers.querySelectorAll('.timer-bar')) {
        const left = Math.max(0, Number(bar.dataset.endsAt) - now - 1000);
        bar.style.transform = `scaleX(${left / Number(bar.dataset.total)})`;
      }
    }
    paintPillProgress(now);
    render();
  }

  // Restzeit des nächsten Timers als feine Linie im geschlossenen Island
  function paintPillProgress(now = Date.now()) {
    const next = state.timers[0];
    const value = next ? Math.max(0, Math.min(1, (next.endsAt - now - 1000) / (next.durationMs || 1))) : 0;
    el.pillProgress.style.setProperty('--progress', value.toFixed(4));
  }

  api.onTimers((list) => {
    state.timers = list || [];
    renderTimers();
    render();
  });

  let alarmLoop = 0;
  api.onTimerDone((timer) => {
    if (state.game.active && !state.open) {
      // Im Spiel nur ein kurzer Ton, nichts Sichtbares
      if (state.settings?.sound !== false) chime();
      state.missed += 1;
      state.inbox.unshift({ id: `timer-${Date.now()}`, app: t('Timer'), title: timer.label, body: t('ist abgelaufen'), time: Date.now() });
      return;
    }
    state.alarm = timer;
    state.peek = null;
    render();
    pop();
    if (state.open) {
      el.messages.appendChild(noticeNode(t('Timer «{label}» ist abgelaufen.', { label: timer.label }), true));
      scrollToBottom(true);
    }
    let rings = 0;
    clearInterval(alarmLoop);
    if (state.settings?.sound !== false) chime();
    alarmLoop = setInterval(() => {
      rings += 1;
      if (!state.alarm || rings >= 4) { clearInterval(alarmLoop); return; }
      if (state.settings?.sound !== false) chime();
    }, 1500);
    setTimeout(() => { if (state.alarm === timer) stopAlarm(); }, 60000);
  });

  function stopAlarm() {
    state.alarm = null;
    clearInterval(alarmLoop);
    render();
  }

  // ---------- Windows-Mitteilungen ----------

  let peekTimer = 0;

  function noteText(n) {
    return [n.title, n.body].filter(Boolean).join(': ') || t('Neue Mitteilung');
  }

  api.onNotify((item) => {
    state.inbox.unshift(item);
    state.inbox.splice(30);
    if (state.game.active && !state.open) {
      // Spielmodus: still sammeln, nach dem Spiel zeigen
      state.missed += 1;
      return;
    }
    if (state.open) {
      renderInbox();
      return;
    }
    state.peek = item;
    el.peekApp.textContent = item.app;
    el.peekText.textContent = noteText(item);
    render();
    pop();
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => { state.peek = null; render(); }, PEEK_MS);
  });

  function renderInbox() {
    el.inboxList.textContent = '';
    el.inbox.hidden = state.inbox.length === 0;
    const s = state.settings;
    el.bannerHint.hidden = !(s && s.notifications && s.canControl && !s.bannerHintDismissed && state.inbox.length);
    for (const n of state.inbox.slice(0, 10)) {
      const row = document.createElement('div');
      row.className = 'note';
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      const app = document.createElement('span');
      app.className = 'note-app';
      app.textContent = n.app;
      const time = document.createElement('span');
      time.textContent = clock(n.time);
      meta.append(app, time);
      const text = document.createElement('div');
      text.className = 'note-text';
      if (n.title) {
        const b = document.createElement('b');
        b.textContent = n.title + (n.body ? ' ' : '');
        text.appendChild(b);
      }
      if (n.body) text.appendChild(document.createTextNode(n.body));
      row.append(meta, text);
      el.inboxList.appendChild(row);
    }
  }

  el.inboxClear.addEventListener('click', () => {
    state.inbox = [];
    api.clearNotifications();
    renderInbox();
  });

  api.onNotifyStatus((status) => {
    if (state.settings) state.settings.notifyStatus = status;
    if (state.view === 'settings') fillSettings();
  });

  // ---------- Musik ----------

  function renderNowPlaying() {
    const m = state.settings?.media === false ? null : state.media;
    el.nowPlaying.hidden = !m;
    const coverOk = Boolean(m?.cover && /^data:image\//.test(m.cover));
    el.pillCover.classList.toggle('has', coverOk);
    el.pillCover.hidden = !coverOk;
    if (!m) return;
    el.nowTitle.textContent = m.title;
    // Künstler genügt; den App-Namen nur, wenn kein Künstler bekannt ist (und dann lesbar, nicht «Spotify.exe»)
    el.nowSub.textContent = m.artist || appName(m.app);
    el.nowPlaying.classList.toggle('playing', Boolean(m.playing));
    el.nowCover.hidden = !coverOk;
    el.nowCoverEmpty.hidden = coverOk;
    if (coverOk && el.nowCover.src !== m.cover) {
      el.nowCover.src = m.cover;
      el.pillCover.src = m.cover;
    }
  }

  api.onMedia((np) => {
    state.media = np;
    renderNowPlaying();
    render();
  });

  el.nowPlaying.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-media]');
    if (btn) api.mediaCommand(btn.dataset.media);
  });

  // ---------- Kalender ----------

  async function renderAgenda() {
    if (!state.settings?.hasCalendar) { el.agenda.hidden = true; return; }
    const list = await api.upcomingEvents();
    el.agendaList.textContent = '';
    el.agenda.hidden = !list.length;
    for (const e of list.slice(0, 3)) {
      const row = document.createElement('div');
      row.className = 'note';
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      const when = document.createElement('span');
      when.className = 'note-app';
      const sameDay = new Date(e.start).toDateString() === new Date().toDateString();
      when.textContent = e.allDay ? t('Ganztägig') : `${sameDay ? t('Heute') : t('Morgen')} ${clock(e.start)}`;
      const where = document.createElement('span');
      where.textContent = e.location || '';
      meta.append(when, where);
      const text = document.createElement('div');
      text.className = 'note-text';
      text.textContent = e.title;
      row.append(meta, text);
      el.agendaList.appendChild(row);
    }
  }

  // ---------- Sprache ----------

  let voiceNoteTimer = 0;
  function voiceNote(text) {
    state.voiceNote = text;
    render();
    clearTimeout(voiceNoteTimer);
    voiceNoteTimer = setTimeout(() => { state.voiceNote = ''; render(); }, 2200);
  }

  // Sicherung: Meldet der Sprach-Helfer nichts mehr, nicht ewig «hört zu» anzeigen
  let listenGuard = 0;
  let voiceCancelled = false;
  // Live-Vorschau beim Diktat: nur das Ende zeigen, damit es ins Island passt
  function previewTail(text) {
    const s = String(text).trim();
    return s.length > 42 ? `… ${s.slice(-40).replace(/^\S*\s/, '')}` : s;
  }

  function setListening(value) {
    state.listening = value;
    if (value !== 'listening' && value !== 'transcribing') state.voicePreview = '';
    clearTimeout(listenGuard);
    // Aufnahme bis 30 s + Übertragung: grosszügige Sicherung
    if (value) listenGuard = setTimeout(() => { if (state.listening) stopVoice(); }, 70000);
    api.voiceState?.(Boolean(value));
    el.micBtn.setAttribute('aria-pressed', value ? 'true' : 'false');
    el.micBtn.title = value ? t('Zuhören beenden') : t('Sprechen');
  }

  function startVoice() {
    if (state.listening) { stopVoice(); return; } // zweiter Klick beendet
    if (!state.settings?.hasKey) { open('account'); return; }
    stopSpeaking();
    voiceCancelled = false;
    setListening('starting');
    render();
    api.voiceListen();
  }

  function stopVoice() {
    if (!state.listening) return;
    voiceCancelled = true;
    setListening('');
    api.voiceCancel();
    render();
  }

  el.micBtn.addEventListener('click', startVoice);

  api.onVoice((msg) => {
    switch (msg.kind) {
      case 'engine':
        if (state.settings) { state.settings.wakeEngine = { state: msg.state, percent: msg.percent, error: msg.error, langName: msg.langName }; fillWakeEngine(); }
        return;
      case 'starting':
        voiceCancelled = false;
        setListening(state.listening || 'starting');
        break;
      case 'wake':
        if (state.game.active) return;
        eyes?.wake();
        voiceCancelled = false;
        pop();
        setListening('listening');
        break;
      case 'listening':
        if (voiceCancelled) return;
        state.voicePreview = '';
        setListening('listening');
        if (state.settings?.sound) chime(true);
        break;
      case 'partial':
        if (voiceCancelled || state.listening !== 'listening') return;
        state.voicePreview = String(msg.text || '');
        break;
      case 'transcribing':
        if (voiceCancelled) return;
        setListening('transcribing');
        break;
      case 'cancelled':
        voiceCancelled = true;
        setListening('');
        break;
      case 'text':
        if (voiceCancelled) return; // nach dem Abbrechen Gehörtes nicht mehr senden
        setListening('');
        if (msg.text && msg.text.trim()) {
          if (state.stream) { voiceNote(t('Buddy arbeitet noch …')); break; }
          send(msg.text, true);
        }
        break;
      case 'nothing':
        if (voiceCancelled) return;
        setListening('');
        voiceNote(t('Nichts gehört'));
        return;
      case 'unavailable':
        setListening('');
        voiceNote(t('Sprache geht nur unter Windows'));
        return;
      case 'ready':
        if (state.settings) state.settings.voiceInfo = { ...msg, ready: true };
        if (!msg.offline && !msg.online && !msg.cloud) { setListening(''); voiceNote(t('Keine Spracherkennung gefunden')); }
        if (state.view === 'settings') fillSettings();
        return;
      default:
        return;
    }
    render();
  });

  // Antworten vorlesen (Windows-Stimmen, offline)
  function plainText(md) {
    return md
      .replace(/```[\s\S]*?```/g, ' Code-Block. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, t('Link'))
      .replace(/[*_#>~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function speak(text) {
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(plainText(text).slice(0, 1200));
      const voices = synth.getVoices();
      const voiceFor = voices.find((v) => /de-CH/i.test(v.lang)) || voices.find((v) => /^de/i.test(v.lang));
      if (voiceFor) { u.voice = voiceFor; u.lang = voiceFor.lang; } else { u.lang = 'de-DE'; }
      u.rate = 1.05;
      synth.speak(u);
    } catch {
      /* keine Stimme */
    }
  }

  function stopSpeaking() {
    try { window.speechSynthesis.cancel(); } catch { /* egal */ }
  }

  // ---------- Spielmodus ----------

  api.onGame((g) => {
    const wasActive = state.game.active;
    state.game = g || { active: false, name: '' };
    if (state.game.active) {
      stopSpeaking();
      state.peek = null;
    } else if (wasActive && state.missed > 0) {
      const count = state.missed;
      state.missed = 0;
      setTimeout(() => {
        state.peek = { app: t('Während du gespielt hast'), title: `${count} ${count === 1 ? t('Mitteilung') : t('Mitteilungen')}`, body: t('Klick zum Anschauen') };
        el.peekApp.textContent = state.peek.app;
        el.peekText.textContent = `${state.peek.title} · ${state.peek.body}`;
        render();
        pop();
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => { state.peek = null; render(); }, PEEK_MS);
      }, 800);
    }
    render();
  });

  // ---------- Updates & Diagnose ----------

  function updateText(u) {
    switch (u?.state) {
      case 'checking': return t('Prüfe …');
      case 'latest': return t('Aktuell');
      case 'downloading': return u.percent ? t('Lädt Version {v} ({p} %)', { v: u.version, p: u.percent }) : t('Lädt Version {v} …', { v: u.version });
      case 'verifying': return t('Prüfe Signatur von {v} …', { v: u.version });
      case 'ready': return t('Version {v} bereit (geprüft)', { v: u.version });
      case 'skipped': return u.error || t('Version {v} übersprungen', { v: u.version });
      case 'rollback': return t('Stellt Version {v} wieder her …', { v: u.version });
      case 'error': return u.error || t('Fehler');
      default: return state.settings?.canUpdate ? t('Noch nicht geprüft') : t('Nur mit dem Installer');
    }
  }

  api.onUpdate((u) => {
    const becameReady = u?.state === 'ready' && state.update.state !== 'ready';
    state.update = u || { state: 'idle' };
    if (state.view === 'settings') fillSettings();
    if (becameReady && !state.game.active) {
      state.peek = { app: t('Buddy Island'), title: `Update ${u.version} ist bereit`, body: t('Neustart in den Einstellungen') };
      el.peekApp.textContent = t('Buddy Island');
      el.peekText.textContent = t('Update {v} ist bereit', { v: u.version });
      render();
      clearTimeout(peekTimer);
      peekTimer = setTimeout(() => { state.peek = null; render(); }, PEEK_MS);
    }
  });

  el.updateBtn.addEventListener('click', () => {
    if (state.update.state === 'ready') api.installUpdate();
    else api.checkUpdates();
  });

  el.diagBtn.addEventListener('click', async () => {
    el.diagBtn.disabled = true;
    el.diagBtn.textContent = t('Test läuft …');
    el.diagList.hidden = false;
    el.diagList.textContent = '';
    const results = await api.runDiagnostics();
    el.diagBtn.disabled = false;
    el.diagBtn.textContent = t('Selbsttest erneut starten');
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'diag-row' + (r.ok === true ? ' ok' : r.ok === false ? ' bad' : '');
      const name = document.createElement('b');
      name.textContent = r.name;
      const detail = document.createElement('span');
      detail.textContent = r.detail;
      row.append(name, detail);
      el.diagList.appendChild(row);
    }
  });

  el.logsBtn.addEventListener('click', () => api.openLogs());

  // ---------- Ton ----------

  // Wird nach jedem Ton wieder geschlossen, damit kein Audio-Thread im Leerlauf läuft.
  function chime(soft) {
    try {
      const ctx = new AudioContext();
      const now = ctx.currentTime;
      (soft ? [[660, 0]] : [[880, 0], [1318.5, 0.11]]).forEach(([freq, delay]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(0.1, now + delay + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.45);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + delay);
        osc.stop(now + delay + 0.5);
      });
      setTimeout(() => ctx.close().catch(() => {}), 800);
    } catch {
      /* kein Audio */
    }
  }

  // ---------- Einstellungen ----------

  const NOTIFY_STATUS = {
    Allowed: t('Aktiv'),
    Starting: t('Startet …'),
    Denied: t('Zugriff verweigert'),
    Unspecified: t('Wartet auf Erlaubnis'),
    Off: t('Aus'),
    Unsupported: t('Nur unter Windows'),
    Error: t('Nicht verfügbar'),
  };

  // ---------- Akzentfarbe (Design-Tokens, siehe css/tokens.css) ----------
  // Aus einer frei gewählten Farbe werden Varianten mit genug Kontrast abgeleitet:
  //   --accent-text   als Text/Icon auf der Fläche des Themes (mind. 4.5:1)
  //   --accent-fill   als Fläche (Knopf, Schalter); bei fast unsichtbarer Farbe die Textfarbe
  //   --on-accent     Text auf dieser Fläche (Schwarz oder Weiss, was besser lesbar ist)
  //   --accent-on-ink auf dem schwarzen Island (Augen, mind. 3:1)
  const BRAND_ACCENT = '#F2F2F7';
  const INK_DARK = '#000000';
  const INK_LIGHT = '#F7F8F7';
  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgbHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  // Farbe schrittweise zu Weiss bzw. Schwarz mischen, bis der Kontrast reicht
  function reach(rgb, bg, min) {
    const toward = luminance(bg) < 0.2 ? [255, 255, 255] : [0, 0, 0];
    for (let k = 0; k <= 1.0001; k += 0.04) {
      const mix = rgb.map((v, i) => v + (toward[i] - v) * k);
      if (contrast(mix, bg) >= min) return mix;
    }
    return toward;
  }
  // Erscheinungsbild: «dark», «light» oder «system» (folgt Windows)
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  let accentNow = BRAND_ACCENT;
  function resolvedTheme() {
    const pref = state.settings?.theme || 'dark';
    return pref === 'system' ? (systemLight.matches ? 'light' : 'dark') : pref === 'light' ? 'light' : 'dark';
  }
  function applyTheme() {
    const theme = resolvedTheme();
    if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
    applyAccent(accentNow);
  }
  function applyAccent(color) {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : BRAND_ACCENT;
    accentNow = c;
    const rgb = hexRgb(c);
    const bg = hexRgb(resolvedTheme() === 'light' ? INK_LIGHT : INK_DARK);
    const fill = contrast(rgb, bg) >= 1.6 ? rgb : reach(rgb, bg, 3);
    const onFill = contrast(fill, [0, 0, 0]) >= contrast(fill, [255, 255, 255]) ? '#0b0c0f' : '#ffffff';
    const root = document.documentElement.style;
    root.setProperty('--accent', c);
    root.setProperty('--accent-text', rgbHex(reach(rgb, bg, 4.5)));
    root.setProperty('--accent-fill', rgbHex(fill));
    root.setProperty('--on-accent', onFill);
    root.setProperty('--accent-on-ink', rgbHex(reach(rgb, [0, 0, 0], 3)));
    // Schalter-Knopf auf der Akzentfläche: weiss, wenn er sich davon abhebt, sonst dunkel (ein «Auge» auf heller Lagune)
    root.setProperty('--knob-on', contrast(fill, [255, 255, 255]) >= 1.8 ? '#ffffff' : onFill);
  }
  // Wechselt Windows das Theme (bei «System»), Theme und Kontraste neu setzen
  systemLight.addEventListener('change', applyTheme);

  function fillLanguage() {
    const s = state.settings;
    el.langSelect.textContent = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    const sysName = (s.languages || []).find((l) => l.id === s.lang)?.name || '';
    auto.textContent = `${t('Automatisch')} (${sysName})`;
    el.langSelect.appendChild(auto);
    for (const l of s.languages || []) {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      el.langSelect.appendChild(opt);
    }
    el.langSelect.value = s.language || 'auto';
    el.visualizerToggle.checked = s.visualizer !== false;
  }

  function fillSettings() {
    const s = state.settings;
    if (!s) return;
    fillLanguage();
    const auto = s.autoModel !== false;
    el.autoToggle.checked = auto;
    el.modelSelect.disabled = auto;
    el.modelLabel.textContent = auto ? t('Modell (wird gewählt)') : t('Modell');
    el.routeToggle.checked = s.showRouting === true;
    el.fallbackToggle.checked = s.modelFallback !== false;
    el.modelShort.textContent = auto ? t('Automatisch') : modelLabel(s.model);
    el.permMedium.value = s.permissions?.medium || 'ask';
    el.permHigh.value = s.permissions?.high || 'ask';
    el.historyToggle.checked = s.historyEnabled !== false;
    el.memoryToggle.checked = s.memoryEnabled !== false;
    loadMemory();
    el.rollbackBtn.hidden = !s.rollbackVersion;
    if (s.rollbackVersion) el.rollbackBtn.textContent = t('Vorherige Version {v} wiederherstellen', { v: s.rollbackVersion });
    renderStats();
    el.nameInput.value = s.name || '';
    if (document.activeElement !== el.promptInput) el.promptInput.value = s.promptPrefs?.notes || '';
    el.prefLength.value = s.promptPrefs?.length || 'normal';
    el.prefStyle.value = s.promptPrefs?.style || 'friendly';
    el.soundToggle.checked = Boolean(s.sound);
    el.autostartToggle.checked = Boolean(s.autostart);
    el.notifyToggle.checked = Boolean(s.notifications);
    const status = s.notifications ? s.notifyStatus : 'Off';
    el.notifyStatus.textContent = NOTIFY_STATUS[status] || status || '–';
    el.dndBtn.textContent = status === 'Denied' ? t('Zugriff in Windows erlauben') : t('Windows-Banner unten rechts ausschalten');
    fillShortcuts();
    el.wakeToggle.checked = Boolean(s.voiceWake);
    el.wakeToggle.disabled = !s.canControl;
    const word = s.wakeWord || 'Hey Buddy';
    el.wakeLabel.textContent = t('Auf «{word}» hören', { word });
    if (document.activeElement !== el.wakeWordInput) el.wakeWordInput.value = word;
    el.wakeWordInput.disabled = el.wakeWordSave.disabled = !s.canControl;
    el.eyesToggle.checked = s.eyesAlive !== false;
    fillWakeEngine();
    el.speakToggle.checked = s.speak !== false;
    el.cloudDictToggle.checked = s.cloudDictation !== false;
    const v = s.voiceInfo;
    el.voiceStatus.textContent = !s.canControl ? t('Nur unter Windows')
      : !v || !v.ready ? t('Startet beim ersten Sprechen')
        : [v.online ? 'Online-Diktat' : null, v.offline ? `Offline · ${v.language}` : null].filter(Boolean).join(' + ') || t('Nicht installiert');
    el.mediaToggle.checked = s.media !== false;
    el.gameToggle.checked = s.gameMode !== false;
    const cal = s.calendarStatus;
    el.calStatus.textContent = !s.hasCalendar ? t('Nicht verbunden')
      : cal?.error ? t('Fehler beim Laden')
        : t('Verbunden · {n} Termine', { n: cal?.events ?? 0 });
    el.calStatus.classList.toggle('ok', Boolean(s.hasCalendar && !cal?.error));
    el.calRemove.hidden = !s.hasCalendar;
    el.calSave.textContent = s.hasCalendar ? t('Ersetzen') : t('Verbinden');
    el.calLead.value = String(s.calendarLead ?? 10);
    el.displaySelect.textContent = '';
    for (const d of s.displays || []) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      el.displaySelect.appendChild(opt);
    }
    el.displaySelect.value = (s.displays || []).some((d) => d.id === String(s.displayId)) ? String(s.displayId) : (s.displays || [])[0]?.id || '';
    el.displaySelect.disabled = (s.displays || []).length < 2;
    el.versionValue.textContent = s.version || '–';
    const u = state.update.state !== 'idle' ? state.update : s.updateState || state.update;
    el.updateStatus.textContent = updateText(u);
    el.updateBtn.textContent = u.state === 'ready' ? t('Neu starten') : t('Prüfen');
    el.updateBtn.hidden = !s.canUpdate;
    for (const b of el.effortSeg.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.value === s.effort);
      b.setAttribute('aria-checked', String(b.dataset.value === s.effort));
    }
    for (const b of el.themeSeg.querySelectorAll('button')) {
      const on = b.dataset.value === (s.theme || 'dark');
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    let preset = false;
    for (const b of el.swatches.querySelectorAll('button')) {
      const on = b.dataset.color.toLowerCase() === (s.accent || '').toLowerCase();
      b.classList.toggle('on', on);
      preset = preset || on;
    }
    el.customColor.parentElement.classList.toggle('on', !preset);
    el.customColor.value = (s.accent || BRAND_ACCENT).toLowerCase();
    fillModels();
  }

  function fillModels() {
    const current = state.settings?.model;
    const list = [...state.models];
    if (current && !list.some((m) => m.id === current)) list.unshift({ id: current, name: modelLabel(current) });
    el.modelSelect.textContent = '';
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name.replace(/^Claude\s+/i, '');
      el.modelSelect.appendChild(opt);
    }
    el.modelSelect.value = current;
    const notice = document.getElementById('modelNotice');
    if (notice) {
      notice.hidden = !state.settings?.modelNotice;
      notice.textContent = state.settings?.modelNotice || '';
    }
  }

  // ---------- Kosten und Verlauf ----------

  async function loadAiStats() {
    try {
      state.stats = await api.getAiStats();
    } catch {
      state.stats = null;
    }
    renderStats();
  }

  function renderStats() {
    renderHistoryList(state.stats?.history || []);
  }

  const TASK_STATUS = { done: t('Erledigt'), partial: t('Teilweise'), error: t('Fehler'), aborted: t('Gestoppt'), stopped: t('Angehalten'), limit: t('Limit erreicht'), running: t('Läuft'), interrupted: t('Unterbrochen') };

  function renderHistoryList(list) {
    el.historyList.textContent = '';
    for (const task of list.slice(0, 25)) {
      const item = document.createElement('details');
      item.className = 'hist';
      const sum = document.createElement('summary');
      const dot = document.createElement('i');
      dot.className = `hist-dot ${task.status}`;
      dot.title = TASK_STATUS[task.status] || task.status;
      const title = document.createElement('span');
      title.className = 'hist-title';
      title.textContent = task.title || t('Aufgabe');
      const meta = document.createElement('span');
      meta.className = 'hist-meta';
      meta.textContent = `${clock(task.started)} · ${usd(task.cost)}`;
      sum.append(dot, title, meta);
      const body = document.createElement('div');
      body.className = 'hist-body';
      const head = document.createElement('div');
      head.className = 'hist-models';
      const modelNames = (task.models || []).map((m) => modelLabel(m)).join(' → ') || '–';
      head.textContent = `${TASK_STATUS[task.status] || task.status}${task.verified === false ? t(' (nicht geprüft)') : ''} · ${modelNames} · ${tokens((task.tokens?.input || 0) + (task.tokens?.output || 0))} Tokens${task.escalations?.length ? ` · ${task.escalations.length}× gewechselt` : ''}`;
      body.appendChild(head);
      if (task.error) {
        const err = document.createElement('div');
        err.className = 'hist-step error';
        err.textContent = task.error;
        body.appendChild(err);
      }
      for (const step of (task.steps || []).slice(-40)) {
        const row = document.createElement('div');
        row.className = `hist-step ${step.status}`;
        const time = document.createElement('time');
        time.textContent = new Date(step.time).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const label = document.createElement('span');
        label.textContent = step.label;
        row.append(time, label);
        body.appendChild(row);
      }
      item.append(sum, body);
      el.historyList.appendChild(item);
    }
  }

  // Zweimal klicken für Löschendes
  function confirmTwice(button, text, action) {
    if (button.dataset.armed) {
      delete button.dataset.armed;
      button.textContent = button.dataset.label;
      action();
      return;
    }
    button.dataset.label = button.textContent;
    button.dataset.armed = '1';
    button.textContent = text;
    setTimeout(() => {
      if (!button.dataset.armed) return;
      delete button.dataset.armed;
      button.textContent = button.dataset.label;
    }, 3500);
  }

  async function loadModels() {
    const result = await api.listModels();
    state.models = result.models || [];
    fillModels();
    updateFootnote();
  }

  async function save(patch) {
    const result = await api.setSettings(patch);
    state.settings = result.settings;
    accentNow = state.settings.accent || BRAND_ACCENT;
    applyTheme();
    render();
    updateFootnote();
    return result;
  }

  function footer(node, text, kind) {
    node.className = 'footer' + (kind ? ' ' + kind : '');
    node.textContent = text || '';
  }

  // ---------- Buddy Cloud: Konto, Guthaben, Käufe ----------
  // Die Oberfläche sieht nie Tokens, nur den Status vom Hauptprozess (window.buddy.cloud).
  const cloudEl = {
    off: $('cloudOff'), out: $('cloudSignedOut'), in: $('cloudSignedIn'), msg: $('cloudMsg'), msgIn: $('cloudMsgIn'), googleText: $('cloudGoogleText'),
    google: $('cloudGoogle'), email: $('cloudEmail'), name: $('cloudName'), nameRow: $('cloudNameRow'),
    code: $('cloudCode'), codeRow: $('cloudCodeRow'), password: $('cloudPassword'), passwordRow: $('cloudPasswordRow'),
    submit: $('cloudSubmit'), switchBtn: $('cloudSwitch'), forgot: $('cloudForgot'),
    who: $('cloudWho'), whoSub: $('cloudWhoSub'), logout: $('cloudLogout'), balance: $('cloudBalance'), balanceSub: $('cloudBalanceSub'),
    buyBox: $('cloudBuyBox'), packages: $('cloudPackages'), historyBox: $('cloudHistoryBox'), usage: $('cloudUsage'), purchases: $('cloudPurchases'),
    planBox: $('cloudPlanBox'), plans: $('cloudPlans'), amount: $('cloudAmount'), amountBuy: $('cloudAmountBuy'), buyFoot: $('cloudBuyFoot'),
  };
  const cloud = { state: null, mode: 'login', busy: false, loadedFor: null, config: null, plans: [] };
  const BUY_FOOT = cloudEl.buyFoot.textContent;

  // Anzeige von Buddy Credits (nur Anzeige; gerechnet wird ausschliesslich auf dem Server)
  function fmtBc(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '–';
    const abs = Math.abs(n);
    const digits = abs > 0 && abs < 1 ? 4 : 2;
    return `${n.toLocaleString(I18N.locale, { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits })} BC`;
  }
  const fmtUsd = (v) => `$${Number(v).toLocaleString(I18N.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(I18N.locale, { day: 'numeric', month: 'long' }) : '');
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleString(I18N.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  function cloudMode(mode) {
    cloud.mode = mode;
    const m = mode;
    cloudEl.nameRow.hidden = m !== 'signup';
    cloudEl.codeRow.hidden = !['verify', 'reset-confirm'].includes(m);
    cloudEl.passwordRow.hidden = m === 'verify' || m === 'reset';
    cloudEl.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    cloudEl.password.placeholder = m === 'reset-confirm' ? t('Neues Passwort') : t('Passwort');
    cloudEl.google.hidden = m !== 'login' && m !== 'signup';
    cloudEl.forgot.hidden = m !== 'login';
    cloudEl.submit.textContent = { login: t('Anmelden'), signup: t('Konto erstellen'), verify: t('Bestätigen'), reset: t('Code senden'), 'reset-confirm': t('Passwort setzen') }[m];
    cloudEl.switchBtn.textContent = m === 'login' ? t('Konto erstellen') : t('Zurück zur Anmeldung');
  }

  // Meldungen erscheinen dort, wo man gerade ist (Anmeldeformular oder Kontoübersicht)
  function cloudFooter(text, kind) {
    footer(cloud.state?.signedIn ? cloudEl.msgIn : cloudEl.msg, text, kind);
  }

  function renderCloud() {
    const s = cloud.state;
    if (!s) return;
    const wasIn = Boolean(state.cloud?.signedIn);
    state.cloud = s;
    cloudEl.off.hidden = s.configured;
    cloudEl.out.hidden = !s.configured || s.signedIn;
    cloudEl.in.hidden = !s.signedIn;
    cloudEl.buyBox.hidden = !s.signedIn;
    cloudEl.planBox.hidden = !s.signedIn || !cloud.plans.length;
    cloudEl.historyBox.hidden = !s.signedIn;
    cloudEl.google.disabled = cloud.busy;
    cloudEl.googleText.textContent = s.googleRunning ? t('Anmeldung läuft … (abbrechen)') : t('Mit Google anmelden');
    cloudEl.submit.disabled = cloud.busy;
    if (s.signedIn) {
      cloudEl.who.firstChild.nodeValue = s.displayName || s.email || t('Konto');
      cloudEl.whoSub.textContent = s.displayName ? s.email || '' : s.provider === 'google' ? 'Google' : '';
      cloudEl.balance.textContent = s.wallet ? fmtBc(s.wallet.available) : s.status === 'offline' ? t('Offline') : '–';
      cloudEl.balance.classList.toggle('bad', Boolean(s.wallet) && Number(s.wallet.available) <= 0);
      const subBc = Number(s.wallet?.subscriptionCredits || 0);
      cloudEl.balanceSub.textContent = subBc > 0
        ? t('davon {bc} aus dem Abo, gültig bis {date}', { bc: fmtBc(s.wallet.subscriptionCredits), date: fmtDate(s.wallet.subscriptionExpiresAt) })
        : '';
      renderPlans();
      if (cloud.loadedFor !== s.email) { cloud.loadedFor = s.email; loadCloudExtras(); }
    } else {
      cloud.loadedFor = null;
    }
    if (s.error && !cloud.busy) cloudFooter(s.error, 'err');
    if (wasIn !== Boolean(s.signedIn)) renderEmpty();
    if (state.view === 'onboarding') renderOnboarding();
  }

  // Abo: Plan anbieten oder laufendes Abo zeigen (verwalten im Stripe-Kundenportal)
  function renderPlans() {
    const s = cloud.state;
    cloudEl.plans.textContent = '';
    if (!s?.signedIn || !cloud.plans.length) return;
    const sub = s.subscription;
    if (sub?.active) {
      const r = document.createElement('div');
      r.className = 'row';
      const l = document.createElement('span');
      l.className = 'row-label two';
      l.textContent = sub.plan?.name || t('Abo');
      const small = document.createElement('small');
      small.textContent = sub.cancelAtPeriodEnd
        ? t('gekündigt, läuft bis {date}', { date: fmtDate(sub.currentPeriodEnd) })
        : t('{bc} pro Monat · nächste Verlängerung {date}', { bc: fmtBc(sub.plan?.monthlyCredits || 0), date: fmtDate(sub.currentPeriodEnd) });
      l.appendChild(small);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = t('Verwalten');
      b.addEventListener('click', () => cloudRun(() => api.cloud.portal(), t('Das Kundenportal ist im Browser offen.')));
      r.append(l, b);
      cloudEl.plans.appendChild(r);
      return;
    }
    for (const plan of cloud.plans) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'row row-button';
      const l = document.createElement('span');
      l.className = 'row-label two';
      l.textContent = plan.name;
      const small = document.createElement('small');
      small.textContent = t('{bc} pro Monat', { bc: fmtBc(plan.monthlyCredits) });
      l.appendChild(small);
      const v = document.createElement('span');
      v.className = 'row-value';
      v.textContent = t('{price} / Monat', { price: fmtUsd(plan.price) });
      b.append(l, v);
      b.addEventListener('click', async () => {
        b.disabled = true;
        cloudFooter(t('Öffne das Abo im Browser …'));
        await cloudRun(() => api.cloud.subscribe(plan.id), t('Abo im Browser geöffnet. Das Guthaben erscheint, sobald Stripe die erste Zahlung bestätigt hat.'));
        b.disabled = false;
      });
      cloudEl.plans.appendChild(b);
    }
  }

  // Eigener Betrag: Vorschau der Credits (nur Anzeige; gerechnet wird auf dem Server)
  function amountPreview() {
    const c = cloud.config;
    const raw = cloudEl.amount.value.trim().replace(',', '.');
    if (!raw || !c?.ready) { cloudEl.buyFoot.textContent = BUY_FOOT; return null; }
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(raw) || Number(raw) < Number(c.minPurchase) || Number(raw) > Number(c.maxPurchase)) {
      cloudEl.buyFoot.textContent = t('Möglich sind {min} bis {max}.', { min: fmtUsd(c.minPurchase), max: fmtUsd(c.maxPurchase) });
      return null;
    }
    cloudEl.buyFoot.textContent = t('{usd} ergibt {bc}.', { usd: fmtUsd(raw), bc: fmtBc(Number(raw) * Number(c.creditsPerUsd)) });
    return raw;
  }
  cloudEl.amount.addEventListener('input', amountPreview);
  cloudEl.amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') cloudEl.amountBuy.click(); });
  cloudEl.amountBuy.addEventListener('click', async () => {
    const amount = amountPreview();
    if (!amount) { cloudFooter(t('Bitte gib einen gültigen Betrag ein.'), 'err'); return; }
    cloudEl.amountBuy.disabled = true;
    cloudFooter(t('Öffne die Zahlung im Browser …'));
    const r = await api.cloud.buyAmount(amount);
    cloudEl.amountBuy.disabled = false;
    if (!r.ok) { cloudFooter(r.error, 'err'); return; }
    cloudEl.amount.value = '';
    amountPreview();
    cloudFooter(t('Zahlung für {bc} ({usd}) im Browser geöffnet. Das Guthaben erscheint nach der Bestätigung durch Stripe.', { bc: fmtBc(r.checkout.credits), usd: fmtUsd(r.checkout.amount) }), 'ok');
  });

  async function loadCloudExtras() {
    const [o, h] = await Promise.all([api.cloud.offer(), api.cloud.history()]);
    cloudEl.packages.textContent = '';
    if (o.ok) {
      cloud.config = o.config;
      cloud.plans = o.plans || [];
      cloudEl.amount.placeholder = o.config?.ready
        ? t('Eigener Betrag ({min} bis {max})', { min: fmtUsd(o.config.minPurchase), max: fmtUsd(o.config.maxPurchase) })
        : t('Eigener Betrag in USD');
      for (const pkg of o.packages || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'row row-button';
        const l = document.createElement('span');
        l.className = 'row-label';
        l.textContent = `${pkg.name} · ${fmtBc(pkg.credits)}`;
        const v = document.createElement('span');
        v.className = 'row-value';
        v.textContent = fmtUsd(pkg.price);
        b.append(l, v);
        b.addEventListener('click', () => buyPackage(pkg, b));
        cloudEl.packages.appendChild(b);
      }
      renderCloud();
    } else {
      cloudFooter(o.error, 'err');
    }
    const list = (node, rows, empty, line) => {
      node.textContent = '';
      if (!rows.length) {
        const r = document.createElement('div');
        r.className = 'row';
        r.textContent = empty;
        node.appendChild(r);
        return;
      }
      for (const item of rows.slice(0, 15)) {
        const [left, sub, right] = line(item);
        const r = document.createElement('div');
        r.className = 'row';
        const l = document.createElement('span');
        l.className = 'row-label two';
        l.textContent = left;
        const small = document.createElement('small');
        small.textContent = sub;
        l.appendChild(small);
        const v = document.createElement('span');
        v.className = 'row-value';
        v.textContent = right;
        r.append(l, v);
        node.appendChild(r);
      }
    };
    if (!h.ok) { cloudFooter(h.error, 'err'); return; }
    const usageStatus = { settled: '', partial: t('teilweise'), released: t('abgebrochen'), failed: t('fehlgeschlagen') };
    list(cloudEl.usage, h.history.usage, t('Noch keine Cloud-Anfragen.'), (u) => [
      u.kind === 'dictation' ? t('Diktat') : String(u.model || '').replace(/^gpt-/, 'GPT-').replace(/-/g, ' '),
      [fmtDay(u.createdAt), usageStatus[u.status] || ''].filter(Boolean).join(' · '),
      Number(u.credits) > 0 ? `−${fmtBc(u.credits)}` : '–',
    ]);
    const purchaseStatus = { completed: t('bezahlt'), refunded: t('zurückerstattet'), partially_refunded: t('teilweise zurückerstattet'), failed: t('fehlgeschlagen'), expired: t('abgelaufen') };
    list(cloudEl.purchases, h.history.purchases, t('Noch keine Käufe.'), (p2) => [
      `${fmtBc(p2.credits)} · ${fmtUsd(p2.amount)}`,
      [fmtDay(p2.completedAt || p2.createdAt), purchaseStatus[p2.status] || p2.status].join(' · '),
      '',
    ]);
  }

  async function buyPackage(pkg, button) {
    button.disabled = true;
    cloudFooter(t('Öffne die Zahlung im Browser …'));
    const r = await api.cloud.buy(pkg.id);
    button.disabled = false;
    if (!r.ok) { cloudFooter(r.error, 'err'); return; }
    cloudFooter(t('Zahlung für {bc} ({usd}) im Browser geöffnet. Das Guthaben erscheint nach der Bestätigung durch Stripe.', { bc: fmtBc(r.checkout.credits), usd: fmtUsd(r.checkout.amount) }), 'ok');
  }

  async function cloudRun(fn, okText) {
    cloud.busy = true;
    renderCloud();
    const r = await fn();
    cloud.busy = false;
    if (r?.state) cloud.state = r.state;
    renderCloud();
    if (!r?.ok) { cloudFooter(r?.error || t('Unbekannter Fehler.'), 'err'); return r; }
    cloudFooter(typeof okText === 'function' ? okText(r) : okText || '', okText ? 'ok' : undefined);
    return r;
  }

  cloudEl.switchBtn.addEventListener('click', () => { cloudFooter(''); cloudMode(cloud.mode === 'login' ? 'signup' : 'login'); });
  cloudEl.forgot.addEventListener('click', () => { cloudFooter(t('Gib deine E-Mail ein. Du bekommst einen Code.')); cloudMode('reset'); cloudEl.email.focus(); });
  cloudEl.google.addEventListener('click', async () => {
    if (cloud.state?.googleRunning) { api.cloud.cancelGoogle(); return; }
    cloudFooter(t('Der Browser öffnet sich. Melde dich dort bei Google an.'));
    await cloudRun(() => api.cloud.google(), t('Angemeldet.'));
  });
  cloudEl.submit.addEventListener('click', async () => {
    const email = cloudEl.email.value.trim();
    const password = cloudEl.password.value;
    const code = cloudEl.code.value.replace(/\s/g, '');
    if (!email) { cloudFooter(t('Bitte gib deine E-Mail ein.'), 'err'); return; }
    const m = cloud.mode;
    if (m === 'login') {
      const r = await cloudRun(() => api.cloud.login(email, password), t('Angemeldet.'));
      if (r?.code === 'email_not_confirmed') { cloudMode('verify'); cloudFooter(t('Gib den Code aus der Bestätigungs-Mail ein.')); }
    } else if (m === 'signup') {
      if (password.length < 8) { cloudFooter(t('Das Passwort braucht mindestens 8 Zeichen.'), 'err'); return; }
      const r = await cloudRun(() => api.cloud.signup(email, password, cloudEl.name.value), (x) => (x.confirmationRequired ? t('Wir haben dir einen Code geschickt. Gib ihn hier ein.') : t('Konto erstellt.')));
      if (r?.ok && r.confirmationRequired) cloudMode('verify');
    } else if (m === 'verify') {
      const r = await cloudRun(() => api.cloud.verifyEmail(email, code), t('E-Mail bestätigt. Du bist angemeldet.'));
      if (r?.ok) cloudMode('login');
    } else if (m === 'reset') {
      const r = await cloudRun(() => api.cloud.requestPasswordReset(email), t('Falls es ein Konto gibt, ist ein Code unterwegs. Gib ihn mit dem neuen Passwort ein.'));
      if (r?.ok) cloudMode('reset-confirm');
    } else if (m === 'reset-confirm') {
      if (password.length < 8) { cloudFooter(t('Das Passwort braucht mindestens 8 Zeichen.'), 'err'); return; }
      const r = await cloudRun(() => api.cloud.confirmPasswordReset(email, code, password), t('Neues Passwort gesetzt. Du bist angemeldet.'));
      if (r?.ok) cloudMode('login');
    }
    if (cloud.state?.signedIn) { cloudEl.password.value = ''; cloudEl.code.value = ''; }
  });
  cloudEl.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') cloudEl.submit.click(); });
  cloudEl.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') cloudEl.submit.click(); });
  cloudEl.logout.addEventListener('click', () => cloudRun(() => api.cloud.logout(), t('Abgemeldet.')));
  api.onCloudState((s) => { cloud.state = s; renderCloud(); });
  cloudMode('login');
  api.cloud.state().then((r) => { if (r?.state) { cloud.state = r.state; renderCloud(); } });

  api.onSettingsChanged((s) => {
    state.settings = s;
    accentNow = s.accent || accentNow;
    applyTheme();
    if (state.view === 'settings') fillSettings();
    renderEmpty();
    updateFootnote();
  });
  el.langSelect.addEventListener('change', async () => {
    await save({ language: el.langSelect.value });
    // Neu aufbauen, damit alle Texte in der neuen Sprache erscheinen (Chat bleibt erhalten)
    location.reload();
  });
  el.visualizerToggle.addEventListener('change', async () => { await save({ visualizer: el.visualizerToggle.checked }); syncVisualizer(); });

  // Reiter in den Einstellungen: immer nur ein Bereich sichtbar
  const tabNav = $('tabNav');
  function showTab(id) {
    state.tab = id;
    for (const b of tabNav.querySelectorAll('button')) {
      const on = b.dataset.tab === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const pane of el.settingsView.querySelectorAll('.pane')) pane.hidden = pane.dataset.pane !== id;
    $('settingsScroll').scrollTop = 0;
  }
  tabNav.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  showTab('general');
  el.autoToggle.addEventListener('change', async () => { await save({ autoModel: el.autoToggle.checked }); fillSettings(); });
  el.routeToggle.addEventListener('change', async () => { await save({ showRouting: el.routeToggle.checked }); renderHistory(); });
  el.fallbackToggle.addEventListener('change', () => save({ modelFallback: el.fallbackToggle.checked }));
  el.permMedium.addEventListener('change', () => save({ permissions: { medium: el.permMedium.value } }));
  el.permHigh.addEventListener('change', () => save({ permissions: { high: el.permHigh.value } }));
  el.historyToggle.addEventListener('change', () => save({ historyEnabled: el.historyToggle.checked }));

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------- Gedächtnis ----------
  function renderMemory(list) {
    el.memoryList.textContent = '';
    if (!list.length) {
      el.memoryList.appendChild(node('div', 'memory-empty', t('Noch nichts gemerkt.')));
    }
    for (const m of list) {
      const row = node('div', 'memory-item');
      const del = node('button', 'icon-btn small', '×');
      del.type = 'button';
      del.title = t('Vergessen');
      del.setAttribute('aria-label', t('Vergessen'));
      del.addEventListener('click', async () => renderMemory(await api.deleteMemory(m.id)));
      row.append(node('span', '', m.text), del);
      el.memoryList.appendChild(row);
    }
    el.memoryClear.hidden = !list.length;
  }
  async function loadMemory() {
    try { renderMemory(await api.listMemory()); } catch { /* egal */ }
  }
  el.memoryToggle.addEventListener('change', () => save({ memoryEnabled: el.memoryToggle.checked }));
  el.memoryClear.addEventListener('click', async () => {
    if (el.memoryClear.dataset.confirm !== '1') {
      el.memoryClear.dataset.confirm = '1';
      el.memoryClear.textContent = t('Wirklich alles vergessen?');
      setTimeout(() => { el.memoryClear.dataset.confirm = ''; el.memoryClear.textContent = t('Alles vergessen'); }, 3000);
      return;
    }
    el.memoryClear.dataset.confirm = '';
    el.memoryClear.textContent = t('Alles vergessen');
    renderMemory(await api.clearMemory());
  });
  el.historyClear.addEventListener('click', () => confirmTwice(el.historyClear, t('Wirklich löschen?'), async () => {
    await api.clearHistory();
    loadAiStats();
  }));
  el.rollbackBtn.addEventListener('click', () => confirmTwice(el.rollbackBtn, t('Buddy startet danach neu. Nochmals klicken'), async () => {
    el.rollbackBtn.disabled = true;
    const result = await api.rollbackUpdate();
    el.rollbackBtn.disabled = false;
    if (result && !result.ok) el.updateStatus.textContent = result.error || t('Ging nicht');
  }));
  el.modelSelect.addEventListener('change', () => save({ model: el.modelSelect.value }));
  el.effortSeg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await save({ effort: b.dataset.value });
    fillSettings();
  });
  el.themeSeg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await save({ theme: b.dataset.value });
    fillSettings();
  });
  el.nameInput.addEventListener('change', () => save({ name: el.nameInput.value.trim() || t('Buddy') }));
  el.promptInput.addEventListener('change', () => save({ promptPrefs: { notes: el.promptInput.value } }));
  el.prefLength.addEventListener('change', () => save({ promptPrefs: { length: el.prefLength.value } }));
  el.prefStyle.addEventListener('change', () => save({ promptPrefs: { style: el.prefStyle.value } }));
  el.swatches.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await save({ accent: b.dataset.color });
    fillSettings();
  });
  // Eigene Farbe: live anzeigen, beim Schliessen des Farbwählers speichern
  el.customColor.addEventListener('input', () => applyAccent(el.customColor.value));
  el.customColor.addEventListener('change', async () => {
    await save({ accent: el.customColor.value.toUpperCase() });
    fillSettings();
  });
  el.soundToggle.addEventListener('change', () => {
    save({ sound: el.soundToggle.checked });
    if (el.soundToggle.checked) chime();
  });
  el.autostartToggle.addEventListener('change', () => save({ autostart: el.autostartToggle.checked }));
  el.notifyToggle.addEventListener('change', async () => { await save({ notifications: el.notifyToggle.checked }); fillSettings(); });
  // Direkt zu den Windows-Einstellungen, um die Banner unten rechts auszuschalten
  el.bannerOpen.addEventListener('click', (event) => {
    event.stopPropagation();
    api.openNotificationSettings();
  });
  el.bannerDismiss.addEventListener('click', async (event) => {
    event.stopPropagation();
    await save({ bannerHintDismissed: true });
    renderInbox();
  });
  el.dndBtn.addEventListener('click', () => {
    if (state.settings?.notifyStatus === 'Denied') api.openNotificationPrivacy();
    else api.openNotificationSettings();
  });
  el.wakeToggle.addEventListener('change', () => save({ voiceWake: el.wakeToggle.checked }));
  // Welche Erkennung hört aufs Wakeword (Vosk offline, Download läuft, Windows als Rückfall)
  function fillWakeEngine() {
    const e = state.settings?.wakeEngine;
    if (!el.wakeEngine) return;
    el.wakeEngineRow.hidden = !state.settings?.voiceWake || !e;
    if (!e) return;
    el.wakeEngine.textContent = e.state === 'vosk' ? (e.langName ? t('Vosk · {lang} · offline', { lang: e.langName }) : t('Vosk · offline'))
      : e.state === 'downloading' ? t('Lädt Sprachmodell … {p} %', { p: e.percent ?? 0 })
        : e.state === 'fallback' ? [t('Windows-Erkennung'), e.error].filter(Boolean).join(' · ')
          : t('Windows-Erkennung');
  }

  async function saveWakeWord() {
    const result = await save({ wakeWord: el.wakeWordInput.value });
    if (result.ok) footer(el.wakeWordMsg, t('Gespeichert. Buddy hört jetzt auf «{word}».', { word: result.settings.wakeWord }), 'ok');
    else footer(el.wakeWordMsg, result.error, 'err');
  }
  el.wakeWordSave.addEventListener('click', saveWakeWord);
  el.wakeWordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveWakeWord(); } });
  el.eyesToggle.addEventListener('change', () => save({ eyesAlive: el.eyesToggle.checked }));
  el.speakToggle.addEventListener('change', () => save({ speak: el.speakToggle.checked }));
  el.cloudDictToggle.addEventListener('change', () => save({ cloudDictation: el.cloudDictToggle.checked }));
  el.mediaToggle.addEventListener('change', async () => { await save({ media: el.mediaToggle.checked }); renderNowPlaying(); });
  el.gameToggle.addEventListener('change', () => save({ gameMode: el.gameToggle.checked }));
  el.displaySelect.addEventListener('change', () => save({ displayId: el.displaySelect.value }));
  el.calLead.addEventListener('change', () => save({ calendarLead: Number(el.calLead.value) }));
  el.calSave.addEventListener('click', async () => {
    footer(el.calMsg, t('Lade Kalender …'));
    el.calSave.disabled = true;
    const result = await api.setCalendar(el.calInput.value);
    el.calSave.disabled = false;
    if (!result.ok) { footer(el.calMsg, result.error, 'err'); return; }
    el.calInput.value = '';
    state.settings = result.settings;
    footer(el.calMsg, t('Kalender verbunden.'), 'ok');
    fillSettings();
  });
  el.calInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.calSave.click(); });
  el.calRemove.addEventListener('click', async () => {
    state.settings = await api.clearCalendar();
    footer(el.calMsg, '');
    fillSettings();
  });
  api.onCalendarStatus((status) => {
    if (!state.settings) return;
    state.settings.calendarStatus = status;
    if (state.view === 'settings') fillSettings();
    if (state.open) renderAgenda();
  });
  el.quitBtn.addEventListener('click', () => api.quit());
  el.connectBtn.addEventListener('click', () => open('account'));

  // Tastenkürzel aufnehmen
  const KEY_NAMES = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`',
  };

  function keyFromCode(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
    return KEY_NAMES[code] || null;
  }

  // Ein Aufnahme-Vorgang für alle Kürzel-Knöpfe
  let recording = null; // { button, apply(keys|''), allowClear, label }

  function stopHotkeyRecording() {
    if (!recording) return;
    const { button, label } = recording;
    recording = null;
    state.recordingHotkey = false;
    api.suspendShortcuts(false);
    button.classList.remove('recording');
    button.textContent = label;
  }

  function startRecording(button, apply, allowClear) {
    stopHotkeyRecording();
    recording = { button, apply, allowClear, label: button.textContent };
    state.recordingHotkey = true;
    // Bestehende Kürzel kurz pausieren, sonst lösen sie statt der Aufnahme aus
    api.suspendShortcuts(true);
    button.classList.add('recording');
    button.textContent = t('Tasten drücken …');
    button.focus();
  }

  function shortcutLabel(keys) {
    return keys ? prettyHotkey(keys) : t('Nicht festgelegt');
  }

  document.addEventListener('keydown', async (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    const current = recording;
    const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
    if (event.key === 'Escape' && plain) { stopHotkeyRecording(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && plain) {
      if (!current.allowClear) {
        footer(el.hotkeyMsg, t('Zum Öffnen braucht Buddy immer ein Kürzel.'), 'err');
        return;
      }
      stopHotkeyRecording();
      await current.apply('');
      return;
    }
    const key = keyFromCode(event.code);
    if (!key) return; // nur Strg/Alt/Umschalt gedrückt
    const mods = [];
    if (event.ctrlKey) mods.push('Control');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    if (event.metaKey) mods.push('Super');
    if (!mods.length && !/^F\d{1,2}$/.test(key)) {
      footer(el.hotkeyMsg, t('Bitte mit Strg, Alt oder Umschalt kombinieren (F-Tasten gehen auch allein).'), 'err');
      return;
    }
    stopHotkeyRecording();
    await current.apply([...mods, key].join('+'));
  }, true);

  async function saveShortcuts(patch) {
    const result = await save(patch);
    footer(el.hotkeyMsg, result.ok ? 'Gespeichert.' : result.error, result.ok ? 'ok' : 'err');
    fillShortcuts();
    return result;
  }

  function fillShortcuts() {
    const s = state.settings;
    if (!s) return;
    for (const button of el.shortcutGroup.querySelectorAll('[data-shortcut]')) {
      const id = button.dataset.shortcut;
      const keys = id === 'toggle' ? s.hotkey : (s.shortcuts || {})[id];
      button.textContent = shortcutLabel(keys);
      button.classList.toggle('empty', !keys);
    }
    renderCustomShortcuts();
  }

  el.shortcutGroup.addEventListener('click', (event) => {
    const button = event.target.closest('[data-shortcut]');
    if (!button) return;
    if (recording?.button === button) { stopHotkeyRecording(); return; }
    const id = button.dataset.shortcut;
    startRecording(button, (keys) => {
      if (id === 'toggle') return saveShortcuts({ hotkey: keys });
      return saveShortcuts({ shortcuts: { ...(state.settings.shortcuts || {}), [id]: keys } });
    }, id !== 'toggle');
  });

  // Eigene Kurzbefehle: Kürzel + fester Auftrag an Buddy
  function customList() {
    return (state.settings?.customShortcuts || []).map((c) => ({ ...c }));
  }

  function renderCustomShortcuts() {
    el.customList.textContent = '';
    for (const item of state.settings?.customShortcuts || []) {
      const row = document.createElement('div');
      row.className = 'row stacked custom-sc';
      row.dataset.id = item.id;

      const top = document.createElement('div');
      top.className = 'custom-top';
      const keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = 'hotkey' + (item.keys ? '' : ' empty');
      keyBtn.textContent = item.keys ? prettyHotkey(item.keys) : t('Kürzel wählen');
      keyBtn.addEventListener('click', () => {
        if (recording?.button === keyBtn) { stopHotkeyRecording(); return; }
        startRecording(keyBtn, (keys) => {
          const list = customList();
          const target = list.find((c) => c.id === item.id);
          if (target) target.keys = keys;
          return saveShortcuts({ customShortcuts: list });
        }, true);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link danger';
      remove.textContent = t('Entfernen');
      remove.addEventListener('click', () => saveShortcuts({ customShortcuts: customList().filter((c) => c.id !== item.id) }));
      top.append(keyBtn, remove);

      const prompt = document.createElement('input');
      prompt.type = 'text';
      prompt.maxLength = 500;
      prompt.placeholder = t('Was soll Buddy tun? z. B. Pausier die Musik');
      prompt.value = item.prompt || '';
      prompt.setAttribute('aria-label', t('Auftrag für Buddy'));
      prompt.addEventListener('change', () => {
        const list = customList();
        const target = list.find((c) => c.id === item.id);
        if (target) target.prompt = prompt.value;
        saveShortcuts({ customShortcuts: list });
      });

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'mini-toggle';
      toggleLabel.innerHTML = '<span class="switch small"><input type="checkbox"><span></span></span><span>Island dabei öffnen</span>';
      const checkbox = toggleLabel.querySelector('input');
      checkbox.checked = Boolean(item.open);
      checkbox.addEventListener('change', () => {
        const list = customList();
        const target = list.find((c) => c.id === item.id);
        if (target) target.open = checkbox.checked;
        save({ customShortcuts: list });
      });

      row.append(top, prompt, toggleLabel);
      el.customList.appendChild(row);
    }
    el.addShortcut.hidden = (state.settings?.customShortcuts || []).length >= 20;
  }

  el.addShortcut.addEventListener('click', async () => {
    const list = customList();
    list.push({ id: uid(), keys: '', prompt: '', open: false });
    await save({ customShortcuts: list });
    renderCustomShortcuts();
    const rows = el.customList.querySelectorAll('.custom-sc');
    rows[rows.length - 1]?.querySelector('input[type="text"]').focus();
  });

  // Kurzbefehle von überall: Auftrag direkt an Buddy schicken
  api.onShortcutPrompt(({ prompt, open: shouldOpen }) => {
    if (!prompt) return;
    if (!state.settings?.hasKey) { open('account'); return; }
    if (state.stream) { pop(); return; } // Buddy arbeitet schon
    if (shouldOpen && !state.open) open('chat');
    if (state.view !== 'chat') showView('chat');
    send(prompt);
  });

  api.onShortcutAction((action) => {
    if (action === 'newChat') {
      open('chat');
      newChat();
    }
  });

  // ---------- Kopfzeile & Tastatur ----------

  el.island.addEventListener('click', (event) => {
    // Nach einem Ziehen kein Klick
    if (drag.suppressClick) { drag.suppressClick = false; return; }
    // Doppelklicks während einer Animation nicht als zweiten Befehl werten
    if (Date.now() - lastToggle < 180) return;
    if (event.target.closest('.actions, .stop, .body')) return;
    // Im Notch holt ein Klick das Island zurück
    if (!state.open && state.notch && visibleState() === 'notch') { lastToggle = Date.now(); setNotch(false, { force: true }); return; }
    if (!state.open) { lastToggle = Date.now(); open(); }
  });

  // ---------- Notch-Modus: Island nach oben ziehen ----------
  // Gedrückt halten und die kleinste Bewegung nach oben (1 px) macht sofort den Notch,
  // nach unten (1 px) holt das Island zurück. Ausgelöst wird während der Bewegung, nicht
  // erst beim Loslassen; danach ist die Geste gesperrt (kein Flackern, kein Zurückspringen).
  // Das Island liegt nur wenige Pixel unter dem Bildschirmrand: mehr Weg nach oben gibt es nicht.
  const NOTCH_THRESHOLD = 1;      // CSS-Pixel senkrecht
  const SIDEWAYS_TOLERANCE = 8;   // so viel seitliches Zittern ist erlaubt
  const NOTCH_LOCK_MS = 480;      // etwas länger als die Animation
  const drag = { active: false, id: null, x: 0, y: 0, done: false, suppressClick: false };
  let notchLockUntil = 0;

  function setNotch(on, { force = false } = {}) {
    if (state.notch === on) return false;
    if (!force && Date.now() < notchLockUntil) return false;
    notchLockUntil = Date.now() + NOTCH_LOCK_MS;
    state.notch = on;
    try { localStorage.setItem(NOTCH_KEY, on ? '1' : '0'); } catch { /* egal */ }
    render();
    return true;
  }

  el.island.addEventListener('pointerdown', (event) => {
    if (state.open || (event.pointerType === 'mouse' && event.button !== 0) || event.target.closest('.stop')) return;
    drag.active = true;
    drag.id = event.pointerId;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.done = false;
    setCapture(true);
    // Zeiger festhalten: die Geste geht nicht verloren, wenn die Maus das Island kurz verlässt
    try { el.island.setPointerCapture(event.pointerId); } catch { /* egal */ }
  });

  el.island.addEventListener('pointermove', (event) => {
    if (!drag.active || drag.done || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) > SIDEWAYS_TOLERANCE && Math.abs(dx) > Math.abs(dy) * 2) return; // seitliche Bewegung, keine Notch-Geste
    let changed = false;
    if (!state.notch && dy <= -NOTCH_THRESHOLD) changed = setNotch(true);
    else if (state.notch && dy >= NOTCH_THRESHOLD) changed = setNotch(false);
    if (changed) {
      drag.done = true; // pro Druck nur ein Wechsel
      drag.suppressClick = true;
    }
  });

  function endDrag(event) {
    if (!drag.active || (event && event.pointerId !== drag.id)) return;
    drag.active = false;
    if (drag.done) setTimeout(() => { drag.suppressClick = false; }, 300);
    if (!el.island.matches(':hover') && !state.open) setCapture(false);
  }

  // Mausrad über dem geschlossenen Island: hoch = Notch, runter = zurück
  let wheelAt = 0;
  el.island.addEventListener('wheel', (event) => {
    if (state.open || Math.abs(event.deltaY) < 4 || Date.now() - wheelAt < 400) return;
    wheelAt = Date.now();
    if (event.deltaY < 0 && !state.notch) setNotch(true);
    else if (event.deltaY > 0 && state.notch) setNotch(false);
  }, { passive: true });
  el.island.addEventListener('pointerup', endDrag);
  el.island.addEventListener('pointercancel', () => endDrag(null));
  el.island.addEventListener('lostpointercapture', () => { if (drag.active) endDrag(null); });
  el.newBtn.addEventListener('click', newChat);
  el.settingsBtn.addEventListener('click', () => showView(state.view === 'settings' ? 'chat' : 'settings'));
  el.accountBtn.addEventListener('click', () => showView(state.view === 'account' ? 'chat' : 'account'));
  el.closeBtn.addEventListener('click', close);

  document.addEventListener('keydown', (event) => {
    if (state.recordingHotkey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (state.listening) { stopVoice(); return; } // Esc beendet zuerst das Zuhören
      if (state.view === 'settings') showView('chat');
      else close();
    } else if (event.ctrlKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      newChat();
    } else if (event.ctrlKey && event.key === ',') {
      event.preventDefault();
      showView('settings');
    }
  });

  api.onToggle(() => toggle());
  api.onOpen((view) => open(view || undefined));
  api.onBlur(() => {
    // Klick ausserhalb schliesst, ausser während der Hotkey aufgenommen oder gefragt wird.
    // Direkt nach dem Öffnen nicht: Windows meldet beim Vergrössern manchmal kurz «blur».
    if (Date.now() - state.openedAt < 350 || isAnimating()) return;
    if (!state.recordingHotkey && !el.messages.querySelector('.confirm')) close();
  });

  // ---------- Einführung (erster Start, unter System › Über Buddy erneut startbar) ----------
  // Fünf Schritte: Sprache, Anmelden, Tastenkürzel, Berechtigungen, Beispiel-Frage. Jederzeit
  // überspringbar, nichts ist Pflicht. Das Anmeldeformular ist dasselbe wie in der Kontoansicht:
  // es wird für die Einführung in den Schritt verschoben und danach zurückgelegt.
  const OB_STEPS = 5;
  const OB_KEY = 'buddy.onboarding.step';
  const ob = {
    steps: [...el.onboardingView.querySelectorAll('.ob-step')],
    dots: [...$('obDots').children],
    host: $('obSigninHost'),
    home: { parent: cloudEl.out.parentNode, next: cloudEl.out.nextSibling },
    back: $('obBack'), next: $('obNext'), skip: $('obSkip'),
  };

  function renderOnboarding() {
    const i = Math.max(0, Math.min(OB_STEPS - 1, state.onboardingStep || 0));
    const s = state.settings || {};
    ob.steps.forEach((step, n) => { step.hidden = n !== i; });
    ob.dots.forEach((dot, n) => { dot.className = n === i ? 'on' : n < i ? 'done' : ''; });
    ob.back.hidden = i === 0;
    ob.skip.hidden = i === OB_STEPS - 1;
    const signedIn = Boolean(state.cloud?.signedIn);
    // Beim Anmelden ist «Anmelden» der Hauptknopf; weiter geht es dann auch ohne Konto
    const later = i === 1 && !signedIn;
    ob.next.textContent = i === OB_STEPS - 1 ? t('Los geht’s') : later ? t('Später') : t('Weiter');
    ob.next.classList.toggle('primary', !later);
    // Letzter Schritt: ohne Konto erst anmelden, sonst Beispiel-Fragen
    $('obChips').hidden = !signedIn;
    $('obSigninLater').hidden = signedIn;
    $('obTryLead').textContent = signedIn ? t('Probier es gleich aus:') : t('Melde dich noch an, dann kann es losgehen.');
    $('obHello').textContent = t('Hoi, ich bin {name}.', { name: s.name || t('Buddy') });
    for (const b of $('obLang').querySelectorAll('button')) {
      const on = b.dataset.value === I18N.lang;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    // Schritt 2: Anmelden (das Formular wandert hierher)
    if (i === 1 && !signedIn) {
      if (cloudEl.out.parentNode !== ob.host) ob.host.appendChild(cloudEl.out);
      $('cloudIntro').hidden = true;
    } else if (cloudEl.out.parentNode === ob.host) {
      returnSignin();
    }
    $('obSignedIn').hidden = !signedIn;
    if (signedIn) {
      const who = state.cloud.displayName || state.cloud.email || '';
      $('obSignedInText').textContent = who ? t('Angemeldet als {who}.', { who }) : t('Angemeldet.');
    }
    // Schritt 3: Tastenkürzel als Tastenkappen
    const keys = $('obHotkey');
    keys.textContent = '';
    for (const k of prettyHotkey(s.hotkey || '').split(' + ').filter(Boolean)) keys.appendChild(node('kbd', '', k));
    const wake = $('obWake');
    const obLabel = wake.closest('label')?.querySelector('.row-label');
    if (obLabel?.firstChild) obLabel.firstChild.textContent = t('Auf «{word}» hören', { word: s.wakeWord || 'Hey Buddy' });
    wake.checked = Boolean(s.voiceWake);
    wake.disabled = s.canControl === false;
  }

  function returnSignin() {
    ob.home.parent.insertBefore(cloudEl.out, ob.home.next);
    $('cloudIntro').hidden = false;
  }

  function leaveOnboarding() {
    if (cloudEl.out.parentNode === ob.host) returnSignin();
    el.island.classList.remove('onboarding');
  }

  function goOnboarding(step) {
    state.onboardingStep = Math.max(0, Math.min(OB_STEPS - 1, step));
    try { localStorage.setItem(OB_KEY, String(state.onboardingStep)); } catch { /* egal */ }
    renderOnboarding();
  }

  async function finishOnboarding(prompt) {
    try { localStorage.removeItem(OB_KEY); } catch { /* egal */ }
    state.onboardingStep = 0;
    if (!state.settings?.onboarded || state.settings?.cloudNotice) await save({ onboarded: true, cloudNotice: null });
    showView('chat');
    renderEmpty();
    if (prompt && state.settings?.hasKey) send(prompt);
  }

  function startOnboarding() {
    let step = 0;
    try { step = Number(localStorage.getItem(OB_KEY)) || 0; } catch { step = 0; }
    state.onboardingStep = step;
    open('onboarding');
  }

  ob.next.addEventListener('click', () => {
    if (state.onboardingStep >= OB_STEPS - 1) finishOnboarding();
    else goOnboarding(state.onboardingStep + 1);
  });
  ob.back.addEventListener('click', () => goOnboarding(state.onboardingStep - 1));
  ob.skip.addEventListener('click', () => finishOnboarding());
  $('obLang').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b || b.dataset.value === I18N.lang) return;
    try { localStorage.setItem(OB_KEY, '0'); } catch { /* egal */ }
    await save({ language: b.dataset.value });
    location.reload(); // alle Texte in der neuen Sprache; die Einführung geht beim selben Schritt weiter
  });
  $('obWake').addEventListener('change', () => save({ voiceWake: $('obWake').checked }));
  $('obChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip?.dataset.send) finishOnboarding(chip.dataset.send);
  });
  $('obToAccount').addEventListener('click', async () => { await finishOnboarding(); showView('account'); });
  el.onboardingBtn.addEventListener('click', () => { goOnboarding(0); showView('onboarding'); });

  // Hinweis «Neu: Buddy Cloud» im Chat
  el.cloudHintDismiss.addEventListener('click', async () => {
    await save({ cloudNotice: null });
    renderCloudHint();
  });

  // ---------- Start ----------

  (async function init() {
    state.settings = await api.getSettings();
    accentNow = state.settings.accent || BRAND_ACCENT;
    applyTheme();
    renderHistory();
    updateSendButton();
    state.timers = await api.getTimers();
    renderTimers();
    paintPillProgress();
    state.inbox = await api.listNotifications();
    renderInbox();
    state.media = await api.getMedia();
    state.game = state.settings.game || state.game;
    state.update = state.settings.updateState || state.update;
    renderNowPlaying();
    render();
    if (state.settings.hasKey) loadModels();
    renderEmpty();
    if (!state.settings.onboarded) startOnboarding();
  })();
})();
