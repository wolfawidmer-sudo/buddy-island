(function () {
  const api = window.buddy;
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
  };

  const STORE_KEY = 'buddy.chat.v1';
  const MAX_HISTORY = 40;
  const CLOSED_H = 40;
  const PEEK_H = 56;
  const PEEK_MS = 6000;

  const state = {
    open: false,
    view: 'chat',
    settings: null,
    models: [],
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

  function prettyHotkey(acc) {
    return (acc || '')
      .replace(/CommandOrControl|Control/g, 'Strg')
      .replace(/Shift/g, 'Umschalt')
      .replace(/Space/g, 'Leertaste')
      .replace(/Super/g, 'Win')
      .replace(/Delete/g, 'Entf')
      .replace(/Backspace/g, 'Rücktaste')
      .replace(/\bUp\b/g, '↑').replace(/\bDown\b/g, '↓').replace(/\bLeft\b/g, '←').replace(/\bRight\b/g, '→')
      .replace(/num(\d)/g, 'Num $1')
      .replace(/\+/g, ' + ');
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clock = (ts) => new Date(ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const capitalize = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

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
    if (state.timers.length && !state.open) return 'timer';
    if (state.media && !state.open && state.settings?.media !== false) return 'music';
    return 'idle';
  }

  function labelFor(shown) {
    const name = state.settings?.name || 'Buddy';
    const next = state.timers[0];
    switch (shown) {
      case 'busy':
        if (state.stream?.text) return 'schreibt …';
        if (state.stream?.tools.length) return 'macht …';
        return 'denkt …';
      case 'done': return 'Fertig';
      case 'error': return 'Fehler';
      case 'timer': return next ? `${next.label}  ${countdown(next.endsAt - Date.now())}` : name;
      case 'alarm': return state.alarm ? `${state.alarm.label} ist um` : name;
      case 'control': return `${capitalize(state.actionLabel || 'steuert')} …`;
      case 'listen': return state.voiceNote || (state.listening === 'listening' ? 'Hört zu …' : 'Mikrofon startet …');
      case 'music': return [state.media?.title, state.media?.artist].filter(Boolean).join(' · ');
      default: return name;
    }
  }

  function render() {
    const shown = visibleState();
    el.island.dataset.state = shown;
    el.island.classList.toggle('paused', Boolean(state.media && !state.media.playing));
    el.island.classList.toggle('listening', Boolean(state.listening));
    if (state.open && shown !== 'alarm' && shown !== 'control') {
      el.label.textContent = state.view === 'settings' ? 'Einstellungen' : state.settings?.name || 'Buddy';
    } else {
      el.label.textContent = labelFor(shown);
    }
    el.peek.hidden = shown !== 'peek';
    syncLayout();
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
      return { width: Math.ceil(Math.min(360, Math.max(240, 12 + 24 + 10 + w + 18)) / 8) * 8, height: PEEK_H };
    }
    const extra = { busy: 30, done: 18, control: 34, alarm: 18, music: 22, listen: 16 }[shown] || 0;
    const w = 8 + 24 + 8 + textWidth(el.label.textContent) + extra + 16;
    // auf 8 px runden, damit sich das Fenster nicht bei jeder Ziffer ändert
    return { width: Math.min(shown === 'music' ? 300 : 340, Math.max(148, Math.ceil(w / 8) * 8)), height: CLOSED_H };
  }

  let windowSize = { open: false, width: 148, height: CLOSED_H };
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
    el.island.style.setProperty('--w', size.width + 'px');
    const grows = !windowSize.open && size.width >= windowSize.width && size.height >= windowSize.height;
    if (grows) {
      clearTimeout(shrinkTimer);
      if (size.width !== windowSize.width || size.height !== windowSize.height) sendLayout({ open: false, ...size });
      return;
    }
    // Kleiner werden erst nach der Animation
    clearTimeout(shrinkTimer);
    shrinkTimer = setTimeout(() => {
      if (state.open) return;
      sendLayout({ open: false, ...closedSize() });
    }, 480);
  }

  // ---------- Öffnen & Schliessen ----------

  let openTimer = 0;

  function open(view) {
    if (view) showView(view);
    if (state.alarm) stopAlarm();
    if (state.status === 'done' || state.status === 'error') state.status = state.stream ? 'busy' : 'idle';
    state.peek = null;
    if (!state.open) {
      state.open = true;
      sendLayout({ open: true });
      // kurz warten, bis das Fenster gross ist, dann animieren
      clearTimeout(openTimer);
      openTimer = setTimeout(() => {
        if (!state.open) return;
        el.island.classList.add('open');
        if (state.view === 'chat') el.input.focus();
        scrollToBottom(true);
      }, 16);
    }
    renderInbox();
    renderNowPlaying();
    renderAgenda();
    renderEmpty();
    render();
  }

  function close() {
    clearTimeout(openTimer);
    if (!state.open) return;
    state.open = false;
    stopHotkeyRecording();
    el.island.classList.remove('open');
    if (state.view === 'settings') showView('chat');
    api.releaseWindow();
    render();
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  function showView(view) {
    state.view = view;
    el.chatView.hidden = view !== 'chat';
    el.settingsView.hidden = view !== 'settings';
    el.settingsBtn.classList.toggle('active', view === 'settings');
    if (view === 'settings') fillSettings();
    if (view === 'chat' && state.open) renderAgenda();
    render();
  }

  // Offen: Mausklicks nur abfangen, wenn die Maus über dem Island ist.
  el.island.addEventListener('mouseenter', () => { if (state.open) api.setMouseCapture(true); });
  el.island.addEventListener('mouseleave', () => { if (state.open) api.setMouseCapture(false); });

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

  function toolChip(t) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip' + (t.error ? ' err' : '');
    chip.textContent = t.label;
    return chip;
  }

  function toolRow(list) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    for (const t of list || []) row.appendChild(toolChip(t));
    return row;
  }

  function assistantBubble(text, toolList) {
    const node = document.createElement('div');
    node.className = 'bubble assistant';
    if (toolList && toolList.length) node.appendChild(toolRow(toolList));
    if (!text) return node;
    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = window.renderMarkdown(text);
    node.appendChild(body);

    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Kopieren';
    copy.addEventListener('click', () => copyText(text, copy));
    tools.appendChild(copy);
    node.appendChild(tools);
    return node;
  }

  function typingBubble() {
    const node = document.createElement('div');
    node.className = 'bubble assistant';
    node.innerHTML = '<div class="md"><span class="typing"><i></i><i></i><i></i></span></div>';
    return node;
  }

  function noticeNode(text, soft) {
    const node = document.createElement('div');
    node.className = 'notice' + (soft ? ' soft' : '');
    const span = document.createElement('span');
    span.textContent = text;
    node.appendChild(span);
    return node;
  }

  function renderHistory() {
    el.messages.textContent = '';
    for (const msg of state.history) {
      el.messages.appendChild(msg.role === 'user' ? userBubble(msg.content) : assistantBubble(msg.content, msg.tools));
    }
    renderEmpty();
    scrollToBottom(true);
  }

  function renderEmpty() {
    const hasKey = state.settings?.hasKey;
    const isEmpty = state.history.length === 0 && !state.stream;
    if (!hasKey) {
      el.empty.hidden = false;
      el.emptyTitle.textContent = `Hoi, ich bin ${state.settings?.name || 'Buddy'}.`;
      el.emptyText.textContent = 'Damit ich antworten kann, verbinde zuerst deinen Claude-API-Key.';
      el.chips.hidden = true;
      el.connectBtn.hidden = false;
    } else {
      el.empty.hidden = !isEmpty;
      el.emptyTitle.textContent = 'Was kann ich für dich tun?';
      el.emptyText.textContent = '';
      el.chips.hidden = false;
      el.connectBtn.hidden = true;
    }
    el.composer.hidden = !hasKey;
    el.footnote.hidden = !hasKey;
    updateFootnote();
  }

  function updateFootnote() {
    const s = state.settings;
    if (!s) return;
    el.footnote.textContent = '';
    const left = document.createElement('span');
    left.textContent = modelLabel(s.model);
    const right = document.createElement('span');
    right.textContent = `${prettyHotkey(s.hotkey)} öffnet`;
    el.footnote.append(left, right);
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const old = button.textContent;
      button.textContent = 'Kopiert';
      button.classList.add('ok');
      setTimeout(() => { button.textContent = old; button.classList.remove('ok'); }, 1400);
    } catch {
      /* Zwischenablage nicht verfügbar */
    }
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
        content: tools && tools.length ? `[Erledigt: ${tools.map((t) => t.label).join(', ')}]\n\n${content || ''}`.trim() : content,
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
    state.stream = { id, text: '', node, raf: 0, tools: [], voice: viaVoice };
    stopSpeaking();
    el.island.classList.add('streaming');
    setStatus('busy');
    updateSendButton();
    api.sendChat(id, apiMessages());
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
      s.node.appendChild(body);
    }
    body.innerHTML = window.renderMarkdown(s.text);
    const last = body.lastElementChild;
    if (last && !last.classList.contains('codeblock')) last.classList.add('cursor');
    scrollToBottom(false);
  }

  function finishStream({ error, stopReason }) {
    const s = state.stream;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    state.stream = null;
    state.control = false;
    el.island.classList.remove('streaming');
    updateSendButton();
    el.messages.querySelector('.confirm')?.remove();

    const text = s.text;
    if (text || s.tools.length) {
      s.node.replaceWith(assistantBubble(text, s.tools));
      state.history.push({ role: 'assistant', content: text || '', tools: s.tools });
      saveHistory();
    } else {
      s.node.remove();
    }
    if (stopReason === 'max_tokens') el.messages.appendChild(noticeNode('Die Antwort wurde gekürzt (Längenlimit).', true));
    if (stopReason === 'aborted') el.messages.appendChild(noticeNode('Gestoppt.', true));
    if (stopReason === 'refusal' && !text) el.messages.appendChild(noticeNode('Dabei kann ich leider nicht helfen.', true));

    if (error) {
      el.messages.appendChild(noticeNode(error));
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

  api.onDone(({ id, stopReason }) => {
    if (state.stream?.id === id) finishStream({ stopReason });
  });

  api.onError(({ id, message }) => {
    if (state.stream?.id === id) finishStream({ error: message });
  });

  api.onTool(({ id, label, error }) => {
    if (state.stream?.id === id) addStreamTool({ label, error });
  });

  function addStreamTool(tool) {
    const s = state.stream;
    s.tools.push(tool);
    let row = s.node.querySelector('.tool-row');
    if (!row) {
      row = toolRow([]);
      s.node.insertBefore(row, s.node.firstChild);
    }
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
    card.querySelector('.confirm-title').textContent = `Darf ${state.settings?.name || 'Buddy'} deinen PC steuern?`;
    card.querySelector('.confirm-text').textContent =
      `Ich sehe dann deinen Bildschirm und benutze Maus und Tastatur, bis die Aufgabe fertig ist. Stoppen kannst du jederzeit mit ${prettyHotkey(state.settings?.hotkey)} oder dem Stopp-Knopf.`;
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

  api.onControl(({ id, active, actions }) => {
    if (state.stream?.id !== id) return;
    state.control = active;
    if (!active && actions) addStreamTool({ label: `PC gesteuert · ${actions} ${actions === 1 ? 'Schritt' : 'Schritte'}` });
    render();
  });

  api.onAction(({ id, label }) => {
    if (state.stream?.id !== id) return;
    state.actionLabel = label;
    if (state.control) render();
  });

  el.stopBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (state.stream) api.abortChat(state.stream.id);
  });

  // ---------- Eingabe ----------

  function updateSendButton() {
    el.sendBtn.disabled = !state.stream && !el.input.value.trim();
    el.sendBtn.setAttribute('aria-label', state.stream ? 'Stoppen' : 'Senden');
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
    for (const t of state.timers) {
      const row = document.createElement('div');
      row.className = 'timer';
      const label = document.createElement('span');
      label.className = 'timer-label';
      label.textContent = t.label;
      const time = document.createElement('span');
      time.className = 'timer-time';
      time.dataset.endsAt = t.endsAt;
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.title = 'Timer stoppen';
      stop.setAttribute('aria-label', 'Timer stoppen');
      stop.innerHTML = '<svg viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8"/></svg>';
      stop.addEventListener('click', () => api.cancelTimer(t.id));
      const bar = document.createElement('i');
      bar.className = 'timer-bar';
      bar.dataset.endsAt = t.endsAt;
      bar.dataset.total = t.durationMs;
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
    render();
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
      state.inbox.unshift({ id: `timer-${Date.now()}`, app: 'Timer', title: timer.label, body: 'ist abgelaufen', time: Date.now() });
      return;
    }
    state.alarm = timer;
    state.peek = null;
    render();
    pop();
    if (state.open) {
      el.messages.appendChild(noticeNode(`Timer «${timer.label}» ist abgelaufen.`, true));
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
    return [n.title, n.body].filter(Boolean).join(': ') || 'Neue Mitteilung';
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
      when.textContent = e.allDay ? 'Ganztägig' : `${sameDay ? 'Heute' : 'Morgen'} ${clock(e.start)}`;
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

  function startVoice() {
    if (state.listening) return;
    if (!state.settings?.hasKey) { open('settings'); return; }
    stopSpeaking();
    state.listening = 'starting';
    render();
    api.voiceListen();
  }

  el.micBtn.addEventListener('click', startVoice);

  api.onVoice((msg) => {
    switch (msg.kind) {
      case 'starting':
        state.listening = state.listening || 'starting';
        break;
      case 'wake':
        if (state.game.active) return;
        pop();
        state.listening = 'listening';
        break;
      case 'listening':
        state.listening = 'listening';
        if (state.settings?.sound) chime(true);
        break;
      case 'text':
        state.listening = '';
        if (msg.text && msg.text.trim()) {
          if (state.stream) { voiceNote('Buddy arbeitet noch …'); break; }
          send(msg.text, true);
        }
        break;
      case 'nothing':
        state.listening = '';
        voiceNote('Nichts gehört');
        return;
      case 'unavailable':
        state.listening = '';
        voiceNote('Sprache geht nur unter Windows');
        return;
      case 'ready':
        if (state.settings) state.settings.voiceInfo = { ...msg, ready: true };
        if (!msg.offline && !msg.online) { state.listening = ''; voiceNote('Keine Spracherkennung gefunden'); }
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
      .replace(/https?:\/\/\S+/g, 'Link')
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
        state.peek = { app: 'Während du gespielt hast', title: `${count} ${count === 1 ? 'Mitteilung' : 'Mitteilungen'}`, body: 'Klick zum Anschauen' };
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
      case 'checking': return 'Prüfe …';
      case 'latest': return 'Aktuell';
      case 'downloading': return u.percent ? `Lädt Version ${u.version} (${u.percent} %)` : `Lädt Version ${u.version} …`;
      case 'ready': return `Version ${u.version} bereit`;
      case 'error': return u.error || 'Fehler';
      default: return state.settings?.canUpdate ? 'Noch nicht geprüft' : 'Nur mit dem Installer';
    }
  }

  api.onUpdate((u) => {
    const becameReady = u?.state === 'ready' && state.update.state !== 'ready';
    state.update = u || { state: 'idle' };
    if (state.view === 'settings') fillSettings();
    if (becameReady && !state.game.active) {
      state.peek = { app: 'Buddy Island', title: `Update ${u.version} ist bereit`, body: 'Neustart in den Einstellungen' };
      el.peekApp.textContent = 'Buddy Island';
      el.peekText.textContent = `Update ${u.version} ist bereit`;
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
    el.diagBtn.textContent = 'Test läuft …';
    el.diagList.hidden = false;
    el.diagList.textContent = '';
    const results = await api.runDiagnostics();
    el.diagBtn.disabled = false;
    el.diagBtn.textContent = 'Selbsttest erneut starten';
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
    Allowed: 'Aktiv',
    Starting: 'Startet …',
    Denied: 'Zugriff verweigert',
    Unspecified: 'Wartet auf Erlaubnis',
    Off: 'Aus',
    Unsupported: 'Nur unter Windows',
    Error: 'Nicht verfügbar',
  };

  // Text auf der Akzentfarbe: Schwarz bei hellen Farben, sonst Weiss
  function applyAccent(color) {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#0A84FF';
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--on-accent', lum > 0.6 ? '#000' : '#fff');
  }

  function fillSettings() {
    const s = state.settings;
    if (!s) return;
    el.keyStatus.textContent = s.hasKey ? `Verbunden · …${s.keyHint || ''}` : 'Nicht verbunden';
    el.keyStatus.classList.toggle('ok', Boolean(s.hasKey));
    el.keyRemove.hidden = !s.hasKey;
    el.keySave.textContent = s.hasKey ? 'Ersetzen' : 'Verbinden';
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
    el.dndBtn.textContent = status === 'Denied' ? 'Zugriff in Windows erlauben' : '«Nicht stören» in Windows öffnen';
    fillShortcuts();
    el.wakeToggle.checked = Boolean(s.voiceWake);
    el.wakeToggle.disabled = !s.canControl;
    el.speakToggle.checked = s.speak !== false;
    const v = s.voiceInfo;
    el.voiceStatus.textContent = !s.canControl ? 'Nur unter Windows'
      : !v || !v.ready ? 'Startet beim ersten Sprechen'
        : [v.online ? 'Online-Diktat' : null, v.offline ? `Offline · ${v.language}` : null].filter(Boolean).join(' + ') || 'Nicht installiert';
    el.mediaToggle.checked = s.media !== false;
    el.gameToggle.checked = s.gameMode !== false;
    const cal = s.calendarStatus;
    el.calStatus.textContent = !s.hasCalendar ? 'Nicht verbunden'
      : cal?.error ? 'Fehler beim Laden'
        : `Verbunden · ${cal?.events ?? 0} Termine`;
    el.calStatus.classList.toggle('ok', Boolean(s.hasCalendar && !cal?.error));
    el.calRemove.hidden = !s.hasCalendar;
    el.calSave.textContent = s.hasCalendar ? 'Ersetzen' : 'Verbinden';
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
    el.updateBtn.textContent = u.state === 'ready' ? 'Neu starten' : 'Prüfen';
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
    footer(el.keyMsg, 'Prüfe Key …');
    el.keySave.disabled = true;
    const result = await api.setKey(el.keyInput.value, el.workspaceInput.value);
    el.keySave.disabled = false;
    if (!result.ok) {
      footer(el.keyMsg, result.error, 'err');
      return;
    }
    el.keyInput.value = '';
    state.settings = result.settings;
    if (result.models?.length) state.models = result.models;
    footer(el.keyMsg, 'Verbunden. Buddy ist bereit.', 'ok');
    if (state.models.length && !state.models.some((m) => m.id === state.settings.model)) {
      const preferred = state.models.find((m) => /sonnet/i.test(m.id)) || state.models[0];
      await save({ model: preferred.id });
    }
    fillSettings();
    renderEmpty();
  });
  el.keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.keySave.click(); });
  el.keyRemove.addEventListener('click', async () => {
    state.settings = await api.clearKey();
    footer(el.keyMsg, '');
    fillSettings();
    renderEmpty();
  });

  el.workspaceInput.addEventListener('change', () => save({ workspaceId: el.workspaceInput.value.trim() }));
  el.modelSelect.addEventListener('change', () => save({ model: el.modelSelect.value }));
  el.effortSeg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    await save({ effort: b.dataset.value });
    fillSettings();
  });
  el.nameInput.addEventListener('change', () => save({ name: el.nameInput.value.trim() || 'Buddy' }));
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
    footer(el.calMsg, 'Lade Kalender …');
    el.calSave.disabled = true;
    const result = await api.setCalendar(el.calInput.value);
    el.calSave.disabled = false;
    if (!result.ok) { footer(el.calMsg, result.error, 'err'); return; }
    el.calInput.value = '';
    state.settings = result.settings;
    footer(el.calMsg, 'Kalender verbunden.', 'ok');
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
    button.textContent = 'Tasten drücken …';
    button.focus();
  }

  function shortcutLabel(keys) {
    return keys ? prettyHotkey(keys) : 'Nicht festgelegt';
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
        footer(el.hotkeyMsg, 'Zum Öffnen braucht Buddy immer ein Kürzel.', 'err');
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
      footer(el.hotkeyMsg, 'Bitte mit Strg, Alt oder Umschalt kombinieren (F-Tasten gehen auch allein).', 'err');
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
      keyBtn.textContent = item.keys ? prettyHotkey(item.keys) : 'Kürzel wählen';
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
      remove.textContent = 'Entfernen';
      remove.addEventListener('click', () => saveShortcuts({ customShortcuts: customList().filter((c) => c.id !== item.id) }));
      top.append(keyBtn, remove);

      const prompt = document.createElement('input');
      prompt.type = 'text';
      prompt.maxLength = 500;
      prompt.placeholder = 'Was soll Buddy tun? z. B. Pausier die Musik';
      prompt.value = item.prompt || '';
      prompt.setAttribute('aria-label', 'Auftrag für Buddy');
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
    // Nur ein Klick aufs geschlossene Island öffnet es (nicht Klicks im Inhalt)
    if (!state.open && !event.target.closest('.stop') && !event.target.closest('.body')) open();
  });
  el.newBtn.addEventListener('click', newChat);
  el.settingsBtn.addEventListener('click', () => showView(state.view === 'settings' ? 'chat' : 'settings'));
  el.closeBtn.addEventListener('click', close);

  document.addEventListener('keydown', (event) => {
    if (state.recordingHotkey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
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
    // Klick ausserhalb schliesst, ausser während der Hotkey aufgenommen oder gefragt wird
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
