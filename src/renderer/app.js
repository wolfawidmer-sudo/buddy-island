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
    for (const node of root.querySelectorAll('[placeholder],[title],[aria-label]')) {
      for (const a of ['placeholder', 'title', 'aria-label']) {
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
    keyStatus: $('keyStatus'),
    keyRemove: $('keyRemove'),
    keyInput: $('keyInput'),
    keySave: $('keySave'),
    keyMsg: $('keyMsg'),
    workspaceInput: $('workspaceInput'),
    modelSelect: $('modelSelect'),
    effortSeg: $('effortSeg'),
    computerToggle: $('computerToggle'),
    confirmToggle: $('confirmToggle'),
    glowToggle: $('glowToggle'),
    notifyToggle: $('notifyToggle'),
    notifyStatus: $('notifyStatus'),
    dndBtn: $('dndBtn'),
    nameInput: $('nameInput'),
    promptInput: $('promptInput'),
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
    speakToggle: $('speakToggle'),
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
    providerSelect: $('providerSelect'),
    keyRevoke: $('keyRevoke'),
    autoToggle: $('autoToggle'),
    modelLabel: $('modelLabel'),
    routeToggle: $('routeToggle'),
    routeHint: $('routeHint'),
    costMonth: $('costMonth'),
    costBar: $('costBar'),
    costNote: $('costNote'),
    limitSelect: $('limitSelect'),
    costEstimate: $('costEstimate'),
    costSession: $('costSession'),
    costTokens: $('costTokens'),
    modelUsage: $('modelUsage'),
    recentCount: $('recentCount'),
    recentList: $('recentList'),
    usageReset: $('usageReset'),
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
    localBtn: $('localBtn'),
    emptyProgress: $('emptyProgress'),
    emptyBar: $('emptyBar'),
    keyBlock: $('keyBlock'),
    localBlock: $('localBlock'),
    workspaceRow: $('workspaceRow'),
    keyFoot: $('keyFoot'),
    hfStatus: $('hfStatus'),
    hfModelInput: $('hfModelInput'),
    hfTokenInput: $('hfTokenInput'),
    hfSave: $('hfSave'),
    hfTest: $('hfTest'),
    setupBox: $('setupBox'),
    setupText: $('setupText'),
    setupProgress: $('setupProgress'),
    setupBar: $('setupBar'),
    setupLog: $('setupLog'),
    setupBtn: $('setupBtn'),
    specsBox: $('specsBox'),
    specsLine: $('specsLine'),
    specsSummary: $('specsSummary'),
    recoList: $('recoList'),
    toolsList: $('toolsList'),
    usageLocalRow: $('usageLocalRow'),
    usageLocalSettingsToggle: $('usageLocalSettingsToggle'),
    toolsRescan: $('toolsRescan'),
    langSelect: $('langSelect'),
    visualizerToggle: $('visualizerToggle'),
    glowMusicToggle: $('glowMusicToggle'),
    bannerHint: $('bannerHint'),
    bannerOpen: $('bannerOpen'),
    bannerDismiss: $('bannerDismiss'),
    usageBtn: $('usageBtn'),
    usageView: $('usageView'),
    usageUpdated: $('usageUpdated'),
    usageRefresh: $('usageRefresh'),
    usageCards: $('usageCards'),
    adminAnthStatus: $('adminAnthStatus'),
    adminAnthInput: $('adminAnthInput'),
    adminAnthSave: $('adminAnthSave'),
    adminOaiStatus: $('adminOaiStatus'),
    adminOaiInput: $('adminOaiInput'),
    adminOaiSave: $('adminOaiSave'),
    usageLocalToggle: $('usageLocalToggle'),
    adminMsg: $('adminMsg'),
  };

  const STORE_KEY = 'buddy.chat.v1';
  const MAX_HISTORY = 40;
  const GAP = 6; // Abstand zum oberen Rand (wie in style.css --gap)
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
    local: null, // Status des lokalen Modells { state, model, device, error, percent }
    setup: null, // Einrichtung der lokalen KI { state, text, percent, log, error }
    specs: null, // Hardware und Empfehlungen
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
    notch: (() => { try { return localStorage.getItem(NOTCH_KEY) === '1'; } catch { return false; } })(),
  };

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
      case 'listen': return state.voiceNote || (state.listening === 'listening' ? t('Hört zu …') : t('Mikrofon startet …'));
      case 'music': return [state.media?.title, state.media?.artist].filter(Boolean).join(' · ');
      default: return name;
    }
  }

  const VIEW_TITLE = { settings: t('Einstellungen'), usage: t('KI-Nutzung') };

  function render() {
    const shown = visibleState();
    if (el.island.dataset.state !== shown) el.island.dataset.state = shown;
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
    state.view = view;
    el.chatView.hidden = view !== 'chat';
    el.settingsView.hidden = view !== 'settings';
    el.usageView.hidden = view !== 'usage';
    el.settingsBtn.classList.toggle('active', view === 'settings');
    el.usageBtn.classList.toggle('active', view === 'usage');
    if (view === 'settings') { fillSettings(); loadAiStats(); }
    if (view === 'usage') loadUsage(false);
    if (view === 'chat' && state.open) renderAgenda();
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
  el.island.addEventListener('mouseenter', () => setCapture(true));
  el.island.addEventListener('mouseleave', () => { if (!drag.active) setCapture(false); });

  // ---------- Blinzeln (nur ein kurzer Timer, keine Dauer-Animation) ----------

  (function blinkLoop() {
    setTimeout(() => {
      const shown = visibleState();
      if (!document.hidden && (shown === 'idle' || shown === 'timer' || shown === 'peek')) {
        for (const eye of el.island.querySelectorAll('.eye')) {
          eye.classList.add('blink');
          eye.addEventListener('animationend', () => eye.classList.remove('blink'), { once: true });
        }
      }
      blinkLoop();
    }, 3500 + Math.random() * 4500);
  })();

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
    return state.settings?.showRouting !== false;
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
    // Welcher Anbieter, welches Modell, welche Stufe: damit klar ist, wo es hakt
    if (detail) {
      const small = document.createElement('small');
      small.className = 'notice-detail';
      small.textContent = detail;
      node.appendChild(small);
    }
    return node;
  }

  function renderHistory() {
    el.messages.textContent = '';
    for (const msg of state.history) {
      el.messages.appendChild(msg.role === 'user' ? userBubble(msg.content) : assistantBubble(msg.content, msg.tools, msg));
    }
    renderEmpty();
    scrollToBottom(true);
  }

  function renderEmpty() {
    const s = state.settings;
    const hasKey = s?.hasKey;
    const isEmpty = state.history.length === 0 && !state.stream;
    const setup = state.setup;
    el.emptyProgress.hidden = true;
    el.localBtn.hidden = true;
    if (!hasKey) {
      el.empty.hidden = false;
      el.emptyTitle.textContent = t('Hoi, ich bin {name}.', { name: s?.name || t('Buddy') });
      el.chips.hidden = true;
      el.connectBtn.hidden = false;
      if (setup && setup.state === 'running') {
        el.emptyText.textContent = setup.text || t('Richte die lokale KI ein …');
        el.emptyProgress.hidden = false;
        el.emptyProgress.classList.toggle('indeterminate', !setup.percent);
        el.emptyBar.style.width = setup.percent ? `${setup.percent}%` : '';
        el.connectBtn.hidden = true;
      } else if (!s?.discovery) {
        el.emptyText.textContent = t('Ich schaue kurz, ob auf deinem PC eine lokale KI laufen kann …');
      } else {
        const issue = s?.discovery?.pythonIssue;
        el.emptyText.textContent = setup?.state === 'error'
          ? setup.error
          : issue?.dllError
            ? t('PyTorch ist installiert, startet aber nicht, weil eine Windows-Bibliothek fehlt. Tippe auf «Lokale KI einrichten», Buddy zeigt dir, was fehlt.')
            : s?.localIncomplete || issue?.torch || issue?.transformers
              ? t('Die lokale KI ist noch nicht fertig eingerichtet. Tippe auf «Lokale KI einrichten», Buddy macht dort weiter, wo er aufgehört hat.')
              : t('Ich kann direkt auf deinem PC laufen, ohne Kosten und ohne Internet. Dafür richte ich einmalig eine lokale KI ein. Oder du fügst einen API-Key hinzu.');
        el.localBtn.hidden = false;
      }
    } else {
      el.empty.hidden = !isEmpty;
      el.emptyTitle.textContent = t('Was kann ich für dich tun?');
      el.emptyText.textContent = localLine() || '';
      el.chips.hidden = false;
      el.connectBtn.hidden = true;
    }
    el.composer.hidden = !hasKey;
    el.footnote.hidden = !hasKey;
    updateFootnote();
  }

  // Kurzer Status des lokalen Modells, z. B. «Lokal: Qwen2.5 1.5B · lädt 40 %»
  function localLine(short) {
    const s = state.settings;
    if (!s || s.provider !== 'huggingface' || !s.hfModel) return '';
    const name = s.hfModel.split(/[\\/]/).filter(Boolean).pop();
    const st = state.local || s.hfStatus || {};
    let what = '';
    if (st.state === 'loading') what = st.percent ? t('lädt {p} %', { p: st.percent }) : t('lädt …');
    else if (st.state === 'ready') what = st.device === 'cuda' ? t('bereit (Grafikkarte)') : t('bereit');
    else if (st.state === 'error') what = t('Fehler');
    return short ? `${t('Lokal')}: ${name}${what ? ` · ${what}` : ''}` : (st.state === 'loading' ? t('Ich lade gerade {name} auf deinem PC ({what}). Du kannst schon schreiben.', { name, what }) : '');
  }

  function updateFootnote() {
    const s = state.settings;
    if (!s) return;
    el.footnote.textContent = '';
    const left = document.createElement('span');
    left.textContent = s.provider === 'huggingface' ? localLine(true) : s.autoModel !== false ? t('Modell: automatisch') : modelLabel(s.model);
    const right = document.createElement('span');
    right.textContent = t('{keys} öffnet', { keys: prettyHotkey(s.hotkey) });
    el.footnote.append(left, right);
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
    if (!state.settings?.hasKey) { open('settings'); return; }

    state.history.push({ role: 'user', content: clean });
    saveHistory();
    el.empty.hidden = true;
    el.messages.appendChild(userBubble(clean));
    el.input.value = '';
    autoGrow();

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
    el.nowSub.textContent = [m.artist, m.app].filter(Boolean).join(' · ');
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
  function setListening(value) {
    state.listening = value;
    clearTimeout(listenGuard);
    if (value) listenGuard = setTimeout(() => { if (state.listening) stopVoice(); }, 45000);
    api.voiceState?.(Boolean(value));
    el.micBtn.setAttribute('aria-pressed', value ? 'true' : 'false');
    el.micBtn.title = value ? t('Zuhören beenden') : t('Sprechen');
  }

  function startVoice() {
    if (state.listening) { stopVoice(); return; } // zweiter Klick beendet
    if (!state.settings?.hasKey) { open('settings'); return; }
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

  // ---------- Verbindungstest ----------
  const health = { running: false, groups: new Map(), report: '' };
  function renderHealth() {
    const list = $('healthList');
    list.hidden = !health.groups.size;
    list.textContent = '';
    for (const g of health.groups.values()) {
      const head = document.createElement('div');
      head.className = 'health-head';
      const name = document.createElement('b');
      name.textContent = g.name;
      const state = document.createElement('span');
      state.className = 'health-state ' + (g.state === 'done' ? (g.ok ? 'ok' : 'bad') : '');
      state.textContent = g.state === 'done' ? (g.ok ? t('alles in Ordnung') : t('Fehler gefunden')) : t('prüft …');
      head.append(name, state);
      list.appendChild(head);
      for (const st of g.steps) {
        const row = document.createElement('div');
        row.className = 'health-step ' + (st.ok === true ? 'ok' : st.ok === false ? 'bad' : 'skip');
        const mark = document.createElement('i');
        mark.textContent = st.ok === true ? '✓' : st.ok === false ? '✕' : '–';
        const body = document.createElement('span');
        const label = document.createElement('span');
        label.textContent = st.label + (st.id.startsWith('basic:') && st.model ? ` (${st.model})` : '') + (st.ms ? ` · ${st.ms < 1000 ? `${st.ms} ms` : `${(st.ms / 1000).toFixed(1)} s`}` : '');
        body.appendChild(label);
        const note = st.error ? st.error.message : st.note;
        if (note) {
          const small = document.createElement('small');
          small.textContent = note;
          body.appendChild(small);
        }
        if (st.error?.detail) {
          const small = document.createElement('small');
          small.className = 'health-detail';
          small.textContent = st.error.detail + (st.error.providerMessage ? ` · ${st.error.providerMessage}` : '');
          body.appendChild(small);
        }
        row.append(mark, body);
        list.appendChild(row);
      }
    }
    $('healthBtn').disabled = health.running;
    $('healthBtn').textContent = health.running ? t('Prüft …') : t('Testen');
    const copyLabel = health.running ? t('Bisherige kopieren') : t('Ergebnisse kopieren');
    // Zeigt der Knopf gerade «Kopiert», erst danach umbeschriften
    if ($('healthCopy')._copyLabel != null) $('healthCopy')._copyLabel = copyLabel;
    else $('healthCopy').textContent = copyLabel;
    $('healthCopy').hidden = !health.groups.size && !health.report;
  }
  // Bericht aus dem, was schon angezeigt wird (auch mitten im Test). Ohne Keys und Inhalte.
  function healthText() {
    if (health.report && !health.running) return health.report;
    const lines = [`Buddy Island · ${new Date().toISOString()}${health.running ? ' · Test läuft noch' : ''}`];
    for (const g of health.groups.values()) {
      lines.push('', `## ${g.name}: ${g.state === 'done' ? (g.ok ? 'OK' : 'FEHLER') : 'läuft …'}`);
      for (const st of g.steps) {
        const mark = st.ok === true ? '✓' : st.ok === false ? '✗' : '–';
        lines.push(`${mark} ${st.label}${st.model ? ` [${st.model}]` : ''}${st.ms ? ` ${st.ms} ms` : ''}${st.note ? ` · ${st.note}` : ''}`);
        const e = st.error;
        if (e) {
          lines.push(`    ${e.message}`);
          const meta = [e.provider, e.model, e.status ? `HTTP ${e.status}` : '', e.code, e.category, e.stage, e.origin, e.endpoint].filter(Boolean).join(' | ');
          if (meta) lines.push(`    ${meta}`);
          if (e.detail) lines.push(`    ${e.detail}`);
          if (e.providerMessage) lines.push(`    Anbieter: ${e.providerMessage}`);
        }
      }
    }
    return lines.join('\n');
  }
  api.onHealth((ev) => {
    const g = health.groups.get(ev.providerId) || { name: ev.providerName, steps: [], state: 'running', ok: false };
    if (ev.state === 'step') g.steps.push(ev.step);
    if (ev.state === 'done') { g.state = 'done'; g.ok = ev.result.ok; g.steps = ev.result.steps; }
    health.groups.set(ev.providerId, g);
    if (state.view === 'settings') renderHealth();
  });
  $('healthBtn').addEventListener('click', async () => {
    if (health.running) return;
    health.running = true;
    health.groups.clear();
    health.report = '';
    renderHealth();
    try {
      const r = await api.runHealth('all');
      health.report = r?.report || '';
    } catch (err) {
      health.report = String(err?.message || err);
    } finally {
      health.running = false;
      renderHealth();
    }
  });
  $('healthCopy').addEventListener('click', () => copyText(healthText(), $('healthCopy')));

  api.onVoice((msg) => {
    switch (msg.kind) {
      case 'starting':
        voiceCancelled = false;
        setListening(state.listening || 'starting');
        break;
      case 'wake':
        if (state.game.active) return;
        voiceCancelled = false;
        pop();
        setListening('listening');
        break;
      case 'listening':
        if (voiceCancelled) return;
        setListening('listening');
        if (state.settings?.sound) chime(true);
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
        if (!msg.offline && !msg.online) { setListening(''); voiceNote(t('Keine Spracherkennung gefunden')); }
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

  // Text auf der Akzentfarbe: Schwarz bei hellen Farben, sonst Weiss
  function applyAccent(color) {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#0A84FF';
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--on-accent', lum > 0.6 ? '#000' : '#fff');
  }

  const PROVIDER_FOOT = {
    anthropic: 'Den Key erstellst du in der <a href="https://platform.claude.com/settings/keys">Claude Console</a>.',
    openai: 'Den Key erstellst du auf <a href="https://platform.openai.com/api-keys">platform.openai.com</a>.',
    xai: 'Den Key erstellst du in der <a href="https://console.x.ai">xAI Console</a>.',
    gemini: 'Den Key erstellst du im <a href="https://aistudio.google.com/apikey">Google AI Studio</a>.',
  };

  function fillProvider() {
    const s = state.settings;
    const pid = s.provider || 'anthropic';
    const p = (s.providers || []).find((x) => x.id === pid) || {};
    el.providerSelect.textContent = '';
    for (const prov of s.providers || []) {
      const opt = document.createElement('option');
      opt.value = prov.id;
      opt.textContent = prov.name + (prov.hasKey && !prov.local ? ' ✓' : '');
      el.providerSelect.appendChild(opt);
    }
    el.providerSelect.value = pid;
    const local = pid === 'huggingface';
    el.keyBlock.hidden = local;
    el.localBlock.hidden = !local;
    el.workspaceRow.hidden = pid !== 'anthropic';
    if (!local) {
      const invalid = p.hasKey && p.status === 'invalid';
      el.keyStatus.textContent = !p.hasKey ? t('Nicht verbunden') : invalid ? t('Abgelehnt, bitte ersetzen') : `${t('Verbunden')} · …${p.hint || ''}${s.keyProtected ? ` · ${t('verschlüsselt')}` : ''}`;
      el.keyStatus.classList.toggle('ok', Boolean(p.hasKey) && !invalid);
      el.keyStatus.classList.toggle('bad', Boolean(invalid));
      el.keyRemove.hidden = !p.hasKey;
      el.keyRevoke.hidden = !p.hasKey;
      el.keySave.textContent = p.hasKey ? t('Ersetzen') : t('Verbinden');
      el.keyInput.placeholder = `${p.keyPrefix || ''}…`;
      el.keyFoot.innerHTML = `${t(PROVIDER_FOOT[pid] || '')} ${t('Buddy speichert ihn mit der Windows-Verschlüsselung (DPAPI), schreibt ihn nie ins Protokoll und schickt ihn nur an diesen Anbieter. «Widerrufen» löscht ihn hier und öffnet die Console, wo du ihn endgültig sperrst.')}`;
      el.setupBox.hidden = true;
      el.specsBox.hidden = true;
    } else {
      el.keyFoot.textContent = t('Lokale Modelle laufen über Hugging Face Transformers direkt auf deinem PC: ohne API-Key, ohne Kosten, ohne Internet (ausser beim ersten Herunterladen). Bildschirmfotos und Werkzeuge gibt es damit nicht, nur Chat.');
      if (document.activeElement !== el.hfModelInput) el.hfModelInput.value = s.hfModel || '';
      el.hfTokenInput.placeholder = s.hasHfToken ? t('Token gespeichert (zum Ersetzen neu eingeben)') : t('hf_…');
      const hasRuntime = Boolean(s.discovery?.python);
      const st = state.local || s.hfStatus || {};
      el.hfStatus.textContent = !hasRuntime ? t('Nicht eingerichtet')
        : !s.hfModel ? t('Kein Modell gewählt')
          : st.state === 'ready' ? `${t('Geladen')} · ${st.device === 'cuda' ? t('Grafikkarte') : st.device === 'mps' ? t('Apple GPU') : t('Prozessor')}`
            : st.state === 'loading' ? (st.percent ? t('Lädt {p} %', { p: st.percent }) : t('Lädt …'))
              : st.state === 'error' ? t('Fehler') : t('Bereit zum Laden');
      el.hfStatus.classList.toggle('ok', st.state === 'ready');
      el.hfStatus.classList.toggle('bad', st.state === 'error');
      el.setupBox.hidden = hasRuntime && state.setup?.state !== 'running';
      el.specsBox.hidden = false;
      fillSetup();
      if (!state.specs) loadSpecs();
      else renderSpecs();
    }
  }

  function fillSetup() {
    const st = state.setup;
    el.setupProgress.hidden = !st || st.state !== 'running';
    el.setupProgress.classList.toggle('indeterminate', Boolean(st && st.state === 'running' && !st.percent));
    el.setupBar.style.width = st?.percent ? `${st.percent}%` : '';
    el.setupLog.textContent = st?.state === 'running' ? (st.log || '') : st?.state === 'error' ? st.error : '';
    el.setupText.textContent = st?.state === 'running' ? st.text
      : st?.state === 'done' ? st.text
        : t('Für lokale Modelle braucht Buddy Python mit den Hugging-Face-Paketen «transformers» und «torch». Buddy installiert sie nur für deinen Benutzer, ohne Administratorrechte.');
    el.setupBtn.disabled = st?.state === 'running';
    el.setupBtn.textContent = st?.state === 'error' ? t('Nochmals versuchen') : t('Lokale KI einrichten');
  }

  async function loadSpecs() {
    el.specsLine.textContent = t('Prüfe die Hardware …');
    try {
      state.specs = await api.getSpecs();
    } catch {
      state.specs = null;
      el.specsLine.textContent = t('Hardware konnte nicht geprüft werden.');
      return;
    }
    renderSpecs();
  }

  const SPEED = { 'sehr schnell': t('sehr schnell'), schnell: 'schnell', 'flüssig': t('flüssig'), langsam: 'langsam', 'sehr langsam': t('sehr langsam'), 'passt nicht': t('passt nicht') };

  function renderSpecs() {
    const r = state.specs;
    if (!r) return;
    const sp = r.specs;
    const gpu = sp.gpus.length ? sp.gpus.map((g) => `${g.name}${g.vramGB ? ` (${g.vramGB} GB)` : ''}`).join(', ') : t('keine eigene Grafikkarte');
    el.specsLine.textContent = `${sp.ramGB} GB RAM · ${sp.threads} ${t('Threads')} · ${gpu}`;
    el.specsSummary.textContent = t(r.summary);
    el.recoList.textContent = '';
    const current = state.settings?.hfModel;
    const rows = [
      { label: t('Am schnellsten'), m: r.fastest },
      ...(r.best.id !== r.fastest.id ? [{ label: t('Beste Antworten'), m: r.best }] : []),
    ];
    for (const { label, m } of rows) {
      const row = document.createElement('div');
      row.className = `reco${current === m.id ? ' active' : ''}`;
      const text = document.createElement('div');
      text.className = 'reco-text';
      const b = document.createElement('b');
      b.textContent = `${label}: ${m.name}`;
      const small = document.createElement('small');
      small.textContent = [t(SPEED[m.speed] || m.speed), t('auf dem {device}', { device: t(m.device) }), t('ca. {gb} GB', { gb: m.needGB }), m.cached ? t('schon heruntergeladen') : null, t(m.note)].filter(Boolean).join(' · ');
      text.append(b, small);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button small';
      btn.textContent = current === m.id ? t('Aktiv') : t('Übernehmen');
      btn.addEventListener('click', () => chooseLocalModel(m.id));
      row.append(text, btn);
      el.recoList.appendChild(row);
    }
  }

  async function chooseLocalModel(id) {
    footer(el.keyMsg, t('Speichere …'));
    const result = await api.setLocalModel(id);
    if (!result.ok) { footer(el.keyMsg, result.error, 'err'); return; }
    state.settings = result.settings;
    footer(el.keyMsg, t('Modell gewählt. Buddy lädt es im Hintergrund.'), 'ok');
    fillSettings();
    renderEmpty();
  }

  function fillTools() {
    const d = state.settings?.discovery;
    el.toolsList.textContent = '';
    el.toolsList.dataset.empty = d ? t('Keine KI-Tools auf diesem PC gefunden.') : t('Suche läuft …');
    for (const tool of d?.tools || []) {
      const row = document.createElement('div');
      row.className = 'tool-item';
      const dot = document.createElement('i');
      const name = document.createElement('span');
      name.textContent = tool.name;
      const detail = document.createElement('small');
      detail.textContent = t(tool.detail || '') || tool.version || (tool.kind === 'app' ? t('App') : tool.kind === 'runtime' ? t('Laufzeit') : t('Kommandozeile'));
      row.append(dot, name, detail);
      el.toolsList.appendChild(row);
    }
    // Einstellungen für nicht installierte Tools gibt es gar nicht
    el.usageLocalRow.hidden = !(d?.has?.claude_code || d?.has?.codex);
    el.usageLocalSettingsToggle.checked = state.settings?.usageLocal !== false;
  }

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
    el.glowMusicToggle.checked = s.glowMusic !== false;
    el.glowMusicToggle.disabled = !s.glow;
  }

  function fillSettings() {
    if (typeof renderHealth === "function" && health.groups.size) renderHealth();
    const s = state.settings;
    if (!s) return;
    fillProvider();
    fillTools();
    fillLanguage();
    const auto = s.autoModel !== false;
    el.autoToggle.checked = auto;
    el.modelSelect.disabled = auto;
    el.modelLabel.textContent = auto ? t('Modell (wird gewählt)') : t('Modell');
    el.routeToggle.checked = s.showRouting !== false;
    el.routeHint.textContent = auto
      ? t('Haiku prüft jede Anfrage und nimmt das günstigste Modell, das reicht: Haiku für Einfaches, Sonnet für mehrstufige Aufgaben, Opus nur für sehr Schwieriges. Einzelne Schritte einer Aufgabe können verschiedene Modelle übernehmen. Hakt es, wechselt Buddy selbst auf ein stärkeres Modell.')
      : t('Buddy nimmt immer das gewählte Modell und wechselt nicht selbst. «Auto» bei der Denktiefe lässt das Modell selbst entscheiden.');
    el.limitSelect.value = [...el.limitSelect.options].some((o) => Number(o.value) === Number(s.monthlyLimit)) ? String(Number(s.monthlyLimit)) : '5';
    if (![...el.limitSelect.options].some((o) => Number(o.value) === Number(s.monthlyLimit))) {
      const opt = document.createElement('option');
      opt.value = String(s.monthlyLimit);
      opt.textContent = `$${s.monthlyLimit}`;
      el.limitSelect.appendChild(opt);
      el.limitSelect.value = String(s.monthlyLimit);
    }
    el.permMedium.value = s.permissions?.medium || 'ask';
    el.permHigh.value = s.permissions?.high || 'ask';
    el.historyToggle.checked = s.historyEnabled !== false;
    el.memoryToggle.checked = s.memoryEnabled !== false;
    loadMemory();
    el.rollbackBtn.hidden = !s.rollbackVersion;
    if (s.rollbackVersion) el.rollbackBtn.textContent = t('Vorherige Version {v} wiederherstellen', { v: s.rollbackVersion });
    renderStats();
    el.workspaceInput.value = s.workspaceId || '';
    el.nameInput.value = s.name || '';
    el.promptInput.value = s.systemPrompt || '';
    el.soundToggle.checked = Boolean(s.sound);
    el.autostartToggle.checked = Boolean(s.autostart);
    el.computerToggle.checked = Boolean(s.computerUse);
    el.computerToggle.disabled = !s.canControl;
    el.confirmToggle.checked = Boolean(s.confirmControl);
    el.confirmToggle.disabled = !s.computerUse;
    el.glowToggle.checked = Boolean(s.glow);
    el.notifyToggle.checked = Boolean(s.notifications);
    const status = s.notifications ? s.notifyStatus : 'Off';
    el.notifyStatus.textContent = NOTIFY_STATUS[status] || status || '–';
    el.dndBtn.textContent = status === 'Denied' ? t('Zugriff in Windows erlauben') : t('Windows-Banner unten rechts ausschalten');
    fillShortcuts();
    el.wakeToggle.checked = Boolean(s.voiceWake);
    el.wakeToggle.disabled = !s.canControl;
    el.speakToggle.checked = s.speak !== false;
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
    let preset = false;
    for (const b of el.swatches.querySelectorAll('button')) {
      const on = b.dataset.color.toLowerCase() === (s.accent || '').toLowerCase();
      b.classList.toggle('on', on);
      preset = preset || on;
    }
    el.customColor.parentElement.classList.toggle('on', !preset);
    el.customColor.value = (s.accent || '#0a84ff').toLowerCase();
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
  }

  // ---------- KI-Nutzung (Dashboard) ----------

  const USAGE_STATUS = { ok: t('Daten'), empty: t('Keine Daten'), unavailable: t('Nicht verfügbar'), setup: t('Einrichten'), error: t('Fehler'), off: t('Aus') };
  let usageLoading = false;

  async function loadUsage(force) {
    if (usageLoading) return;
    usageLoading = true;
    el.usageRefresh.disabled = true;
    el.usageUpdated.textContent = t('Lädt …');
    try {
      renderUsage(await api.getAiUsage(force));
    } catch {
      el.usageUpdated.textContent = t('Konnte nicht geladen werden');
    } finally {
      usageLoading = false;
      el.usageRefresh.disabled = false;
    }
    fillUsageConnections();
  }

  function fillUsageConnections() {
    const s = state.settings || {};
    el.adminAnthStatus.textContent = s.hasAnthropicAdmin ? t('Verbunden') : t('Nicht verbunden');
    el.adminAnthStatus.classList.toggle('ok', Boolean(s.hasAnthropicAdmin));
    el.adminOaiStatus.textContent = s.hasOpenaiAdmin ? t('Verbunden') : t('Nicht verbunden');
    el.adminOaiStatus.classList.toggle('ok', Boolean(s.hasOpenaiAdmin));
    el.usageLocalToggle.checked = s.usageLocal !== false;
    // Nur zeigen, was es auf diesem PC gibt (nicht installierte Tools komplett ausblenden)
    const has = s.discovery?.has || {};
    const keyOf = (id) => Boolean((s.providers || []).find((p) => p.id === id)?.hasKey);
    $('adminAnthRows').hidden = !(keyOf('anthropic') || s.hasAnthropicAdmin);
    $('adminOaiRows').hidden = !(keyOf('openai') || s.hasOpenaiAdmin || has.chatgpt_app || has.codex);
    $('usageLocalUsageRow').hidden = !(has.claude_code || has.codex);
  }

  const ago = (ts) => {
    const secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 60) return t('gerade eben');
    if (secs < 3600) return t('vor {n} min', { n: Math.round(secs / 60) });
    if (secs < 86400) return t('vor {n} h', { n: Math.round(secs / 3600) });
    return new Date(ts).toLocaleDateString(I18N.locale);
  };
  const dur = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3600e3 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600e3).toFixed(1)} h`);
  const when = (ts) => new Date(ts).toLocaleString(I18N.locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderUsage(report) {
    el.usageUpdated.textContent = report.cached
      ? t('Zwischengespeichert, Stand {time}', { time: clock(report.updatedAt) })
      : t('Live abgefragt: {time}', { time: clock(report.updatedAt) });
    el.usageCards.textContent = '';

    // Laufende KI-Programme zuerst
    const live = node('div', 'ucard');
    const lh = node('div', 'ucard-head');
    lh.append(node('b', '', t('Läuft gerade')), node('span', `tag ${report.programsError ? 'error' : 'ok'}`, report.programsError ? t('Fehler') : t('Live')));
    live.appendChild(lh);
    const items = [...report.programs.map((p) => ({ title: p.name, sub: t('Programm läuft') })), ...report.running.map((r) => ({ title: r.name, sub: r.detail, running: true }))];
    const box = node('div', 'uact');
    if (report.programsError) box.appendChild(node('div', 'unote', t('Nicht prüfbar: {e}', { e: report.programsError })));
    else if (!items.length) box.appendChild(node('div', 'uact-item', t('Keine bekannten KI-Programme oder Agents aktiv.')));
    for (const it of items) {
      const i = node('div', `uact-item${it.running ? ' running' : ''}`);
      i.append(node('b', '', it.title), node('div', '', it.sub));
      box.appendChild(i);
    }
    live.appendChild(box);
    el.usageCards.appendChild(live);

    // Getrennt nach Art: Abo, API und lokal werden nie zusammengezählt
    const GROUPS = [
      ['subscription', t('Abo-Nutzung'), t('Nutzung über deine Abos (Claude, ChatGPT, Grok …), soweit die Anbieter sie herausgeben.')],
      ['api', t('API-Nutzung'), t('Anfragen, Tokens und Kosten über API-Keys.')],
      ['local', t('Lokal auf diesem PC'), t('Was lokale Modelle auf deinem PC belegen.')],
    ];
    const ordered = [];
    for (const [cat, title, sub] of GROUPS) {
      const list = report.providers.filter((p) => (p.category || 'api') === cat);
      if (!list.length) continue;
      ordered.push({ header: title, sub }, ...list);
    }
    for (const p of ordered) {
      if (p.header) {
        const h = node('div', 'ugroup');
        h.append(node('b', '', p.header), node('small', '', p.sub));
        el.usageCards.appendChild(h);
        continue;
      }
      const card = node('div', 'ucard');
      const head = node('div', 'ucard-head');
      head.append(node('b', '', p.name), node('span', `tag ${p.status}`, t(USAGE_STATUS[p.status] || p.status)));
      card.appendChild(head);
      if (p.source) card.appendChild(node('div', 'ucard-src', t('Quelle: {s}', { s: t(p.source) })));
      if (p.status === 'error') card.appendChild(node('div', 'unote', p.error || t('Fehler beim Abrufen')));
      for (const m of p.metrics || []) {
        const row = node('div', `urow ${m.kind}`);
        row.title = m.hint || (m.kind === 'estimate' ? t('Schätzung') : m.kind === 'measured' ? t('Gemessen') : '');
        row.append(node('span', '', t(m.label)), node('span', '', t(m.value)));
        card.appendChild(row);
      }
      for (const l of p.limits || []) {
        const lim = node('div', 'ulimit');
        const top = node('div', 'ulimit-top');
        top.append(node('span', '', t(l.label)), node('span', '', l.usedPercent === null ? t('zurückgesetzt') : t('{a} % genutzt · {b} % übrig', { a: l.usedPercent, b: 100 - l.usedPercent })));
        const bar = node('div', 'budget-bar');
        const fill = node('i');
        fill.style.width = `${Math.min(100, l.usedPercent || 0)}%`;
        if ((l.usedPercent || 0) >= 90) fill.style.background = 'var(--red)';
        else if ((l.usedPercent || 0) >= 70) fill.style.background = '#ffd60a';
        bar.appendChild(fill);
        const meta = [l.detail, l.resetsAt ? t('setzt zurück {time}', { time: when(l.resetsAt) }) : null, l.asOf ? t('Stand {time}', { time: ago(l.asOf) }) : null, l.note].filter(Boolean).join(' · ');
        lim.append(top, bar, node('small', '', meta));
        card.appendChild(lim);
      }
      const notes = [p.note ? t(p.note) : null, p.limitsNote ? `${t('Limits')}: ${t(p.limitsNote)}` : null].filter(Boolean);
      for (const n of notes) card.appendChild(node('div', 'unote', n));
      const acts = (p.activity || []).slice(0, 5);
      if (acts.length) {
        const list = node('div', 'uact');
        for (const a of acts) {
          const i = node('div', `uact-item${a.running ? ' running' : ''}`);
          i.appendChild(node('b', '', a.title));
          const meta = [a.project, when(a.end), a.durationMs ? dur(a.durationMs) : null, a.tools?.length ? a.tools.join(', ') : null, a.errors ? t('{n} Fehler', { n: a.errors }) : null].filter(Boolean).join(' · ');
          i.appendChild(node('div', '', meta));
          list.appendChild(i);
        }
        card.appendChild(list);
      }
      card.appendChild(node('div', 'ucard-foot', t('Aktualisiert {time}', { time: clock(p.updatedAt) })));
      el.usageCards.appendChild(card);
    }
  }

  async function saveUsageKey(provider, input) {
    footer(el.adminMsg, t('Prüfe …'));
    const result = await api.setUsageKey(provider, input.value);
    if (!result.ok) { footer(el.adminMsg, result.error, 'err'); return; }
    input.value = '';
    state.settings = result.settings;
    footer(el.adminMsg, 'Gespeichert.', 'ok');
    if (result.report) renderUsage(result.report);
    fillUsageConnections();
  }
  el.adminAnthSave.addEventListener('click', () => saveUsageKey('anthropicAdmin', el.adminAnthInput));
  el.adminOaiSave.addEventListener('click', () => saveUsageKey('openaiAdmin', el.adminOaiInput));
  el.usageRefresh.addEventListener('click', () => loadUsage(true));
  el.usageLocalToggle.addEventListener('change', async () => { await save({ usageLocal: el.usageLocalToggle.checked }); loadUsage(true); });

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
    const st = state.stats;
    if (!st || !st.usage) return;
    const u = st.usage;
    const b = u.budget;
    el.costMonth.textContent = usd(u.totals.cost);
    const box = el.costBar.closest('.budget');
    box.classList.remove('ok', 'warn', 'tight', 'blocked', 'none');
    box.classList.add(b.level);
    el.costBar.style.width = b.limit ? `${Math.min(100, Math.round(b.ratio * 100))}%` : '0%';
    el.costNote.textContent = b.limit
      ? (b.level === 'blocked' ? t('Limit von ${l} erreicht', { l: b.limit.toFixed(2) }) : t('{p} % von ${l} · noch {left}', { p: Math.round(b.ratio * 100), l: b.limit.toFixed(2), left: usd(b.left) }))
      : t('Kein Limit gesetzt');
    el.costEstimate.textContent = u.estimate ? `≈ ${usd(u.estimate)}` : '–';
    el.costSession.textContent = `${usd(u.session.cost)} · ${u.session.requests} ${u.session.requests === 1 ? t('Anfrage') : t('Anfragen')}`;
    el.costTokens.textContent = t('{a} ein · {b} aus', { a: tokens(u.totals.input + u.totals.cacheWrite + u.totals.cacheRead), b: tokens(u.totals.output) });
    el.modelUsage.textContent = '';
    for (const m of u.models) {
      const row = document.createElement('div');
      row.className = 'usage-row';
      const name = document.createElement('span');
      name.className = 'row-label';
      name.textContent = m.name;
      const value = document.createElement('span');
      value.className = 'row-value';
      value.textContent = `${m.requests}× · ${usd(m.cost)}`;
      row.append(name, value);
      el.modelUsage.appendChild(row);
    }
    el.recentCount.textContent = u.recent.length ? String(u.recent.length) : '';
    el.recentList.textContent = '';
    for (const r of u.recent) {
      const row = document.createElement('div');
      const left = document.createElement('span');
      left.textContent = `${clock(r.time)} · ${r.purpose} · ${(r.model || '').replace(/^claude-/, '')}`;
      const right = document.createElement('span');
      right.textContent = `${tokens(r.input)}/${tokens(r.output)} · ${usd(r.cost)}`;
      row.append(left, right);
      el.recentList.appendChild(row);
    }
    renderHistoryList(st.history || []);
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
    applyAccent(state.settings.accent);
    render();
    updateFootnote();
    return result;
  }

  function footer(node, text, kind) {
    node.className = 'footer' + (kind ? ' ' + kind : '');
    node.textContent = text || '';
  }

  el.keySave.addEventListener('click', async () => {
    footer(el.keyMsg, t('Prüfe Key …'));
    el.keySave.disabled = true;
    const result = await api.setProviderKey(el.providerSelect.value, el.keyInput.value, el.workspaceInput.value);
    el.keySave.disabled = false;
    if (!result.ok) {
      footer(el.keyMsg, result.error, 'err');
      return;
    }
    el.keyInput.value = '';
    state.settings = result.settings;
    if (result.models?.length) state.models = result.models;
    footer(el.keyMsg, t('Verbunden. Buddy nutzt jetzt {name}.', { name: (state.settings.providers || []).find((x) => x.id === state.settings.provider)?.name || '' }), 'ok');
    fillSettings();
    loadModels();
    renderEmpty();
  });
  el.keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.keySave.click(); });
  el.keyRemove.addEventListener('click', async () => {
    state.settings = await api.clearProviderKey(el.providerSelect.value);
    footer(el.keyMsg, '');
    fillSettings();
    renderEmpty();
  });

  el.keyRevoke.addEventListener('click', () => confirmTwice(el.keyRevoke, t('Wirklich? Key wird hier gelöscht'), async () => {
    state.settings = await api.revokeProviderKey(el.providerSelect.value);
    footer(el.keyMsg, t('Key gelöscht. Sperre ihn jetzt in der Console des Anbieters (dort beim Key auf «Delete»).'), 'ok');
    fillSettings();
    renderEmpty();
  }));
  el.providerSelect.addEventListener('change', async () => {
    footer(el.keyMsg, '');
    await save({ provider: el.providerSelect.value });
    state.models = [];
    fillSettings();
    loadModels();
    renderEmpty();
  });

  // Lokales Modell
  el.hfSave.addEventListener('click', async () => {
    footer(el.keyMsg, t('Speichere …'));
    const token = el.hfTokenInput.value.trim();
    const result = await api.setLocalModel(el.hfModelInput.value, token ? token : undefined);
    if (!result.ok) { footer(el.keyMsg, result.error, 'err'); return; }
    el.hfTokenInput.value = '';
    state.settings = result.settings;
    footer(el.keyMsg, t('Gespeichert. Buddy lädt das Modell im Hintergrund.'), 'ok');
    fillSettings();
    renderEmpty();
  });
  el.hfModelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.hfSave.click(); });
  el.hfTest.addEventListener('click', async () => {
    el.hfTest.disabled = true;
    footer(el.keyMsg, t('Lade und teste das Modell … (beim ersten Mal mit Download, das kann dauern)'));
    const r = await api.testLocalModel();
    el.hfTest.disabled = false;
    if (!r.ok) { footer(el.keyMsg, r.error, 'err'); return; }
    footer(el.keyMsg, t('Antwort in {s} s ({n} Tokens): «{text}»', { s: r.seconds, n: r.tokens, text: r.text }), 'ok');
  });
  async function startSetup() {
    state.setup = { state: 'running', text: t('Richte die lokale KI ein …') };
    fillSetup();
    renderEmpty();
    const r = await api.setupLocal();
    if (r && r.ok) state.settings = await api.getSettings();
    fillSettings();
    renderEmpty();
  }
  el.setupBtn.addEventListener('click', startSetup);
  el.localBtn.addEventListener('click', startSetup);
  api.onLocalSetup((st) => {
    state.setup = st;
    if (state.view === 'settings') fillSetup();
    renderEmpty();
  });
  api.onLocalStatus((st) => {
    state.local = st;
    if (state.settings) state.settings.hfStatus = st;
    if (state.view === 'settings' && el.localBlock && !el.localBlock.hidden) fillProvider();
    updateFootnote();
    if (state.open && !state.history.length) renderEmpty();
  });
  api.onSettingsChanged((s) => {
    state.settings = s;
    if (state.view === 'settings') fillSettings();
    renderEmpty();
    updateFootnote();
  });
  api.onDiscovery((d) => {
    if (!state.settings) return;
    state.settings.discovery = d;
    if (state.view === 'settings') fillSettings();
    if (state.view === 'usage') loadUsage(false);
    renderEmpty();
  });
  el.toolsRescan.addEventListener('click', async () => {
    el.toolsRescan.disabled = true;
    const d = await api.getDiscovery(true);
    el.toolsRescan.disabled = false;
    state.settings.discovery = d;
    state.specs = null;
    fillSettings();
  });
  el.usageLocalSettingsToggle.addEventListener('change', () => save({ usageLocal: el.usageLocalSettingsToggle.checked }));
  el.langSelect.addEventListener('change', async () => {
    await save({ language: el.langSelect.value });
    // Neu aufbauen, damit alle Texte in der neuen Sprache erscheinen (Chat bleibt erhalten)
    location.reload();
  });
  el.visualizerToggle.addEventListener('change', async () => { await save({ visualizer: el.visualizerToggle.checked }); syncVisualizer(); });
  el.glowMusicToggle.addEventListener('change', () => save({ glowMusic: el.glowMusicToggle.checked }));

  // Bereichs-Navigation in den Einstellungen
  const catNav = document.querySelector('.cat-nav');
  catNav?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]');
    if (!b) return;
    document.getElementById(b.dataset.cat)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const catObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      for (const b of catNav.querySelectorAll('button')) b.classList.toggle('on', b.dataset.cat === en.target.id);
    }
  }, { root: el.settingsView.querySelector('.settings-scroll'), rootMargin: '0px 0px -75% 0px' });
  for (const h of el.settingsView.querySelectorAll('.category')) catObserver.observe(h);
  el.autoToggle.addEventListener('change', async () => { await save({ autoModel: el.autoToggle.checked }); fillSettings(); });
  el.routeToggle.addEventListener('change', async () => { await save({ showRouting: el.routeToggle.checked }); renderHistory(); });
  el.limitSelect.addEventListener('change', async () => { await save({ monthlyLimit: Number(el.limitSelect.value) }); loadAiStats(); });
  el.permMedium.addEventListener('change', () => save({ permissions: { medium: el.permMedium.value } }));
  el.permHigh.addEventListener('change', () => save({ permissions: { high: el.permHigh.value } }));
  el.historyToggle.addEventListener('change', () => save({ historyEnabled: el.historyToggle.checked }));

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
  el.usageReset.addEventListener('click', () => confirmTwice(el.usageReset, t('Wirklich zurücksetzen?'), async () => {
    await api.resetUsage();
    loadAiStats();
  }));
  el.rollbackBtn.addEventListener('click', () => confirmTwice(el.rollbackBtn, t('Buddy startet danach neu. Nochmals klicken'), async () => {
    el.rollbackBtn.disabled = true;
    const result = await api.rollbackUpdate();
    el.rollbackBtn.disabled = false;
    if (result && !result.ok) el.updateStatus.textContent = result.error || t('Ging nicht');
  }));
  el.workspaceInput.addEventListener('change', () => save({ workspaceId: el.workspaceInput.value.trim() }));
  el.modelSelect.addEventListener('change', () => save({ model: el.modelSelect.value }));
  el.effortSeg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await save({ effort: b.dataset.value });
    fillSettings();
  });
  el.nameInput.addEventListener('change', () => save({ name: el.nameInput.value.trim() || t('Buddy') }));
  el.promptInput.addEventListener('change', () => save({ systemPrompt: el.promptInput.value }));
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
  el.computerToggle.addEventListener('change', async () => { await save({ computerUse: el.computerToggle.checked }); fillSettings(); });
  el.confirmToggle.addEventListener('change', () => save({ confirmControl: el.confirmToggle.checked }));
  el.glowToggle.addEventListener('change', () => save({ glow: el.glowToggle.checked }));
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
  el.speakToggle.addEventListener('change', () => save({ speak: el.speakToggle.checked }));
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
  el.connectBtn.addEventListener('click', () => open('settings'));

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
    if (!state.settings?.hasKey) { open('settings'); return; }
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
  el.usageBtn.addEventListener('click', () => showView(state.view === 'usage' ? 'chat' : 'usage'));
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

  // ---------- Start ----------

  (async function init() {
    state.settings = await api.getSettings();
    applyAccent(state.settings.accent);
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
  })();
})();
