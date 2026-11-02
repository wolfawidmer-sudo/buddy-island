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
    hotkeyBtn: $('hotkeyBtn'),
    hotkeyMsg: $('hotkeyMsg'),
    soundToggle: $('soundToggle'),
    autostartToggle: $('autostartToggle'),
    quitBtn: $('quitBtn'),
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
    if (state.peek && !state.open) return 'peek';
    if (state.status !== 'idle') return state.status;
    if (state.timers.length && !state.open) return 'timer';
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
      default: return name;
    }
  }

  function render() {
    const shown = visibleState();
    el.island.dataset.state = shown;
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
    const extra = { busy: 30, done: 18, control: 34, alarm: 18 }[shown] || 0;
    const w = 8 + 24 + 8 + textWidth(el.label.textContent) + extra + 16;
    // auf 8 px runden, damit sich das Fenster nicht bei jeder Ziffer ändert
    return { width: Math.min(340, Math.max(148, Math.ceil(w / 8) * 8)), height: CLOSED_H };
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

  function send(text) {
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
    state.stream = { id, text: '', node, raf: 0, tools: [] };
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
      if (state.settings?.sound && (!state.open || !document.hasFocus())) chime();
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

  // ---------- Ton ----------

  // Wird nach jedem Ton wieder geschlossen, damit kein Audio-Thread im Leerlauf läuft.
  function chime() {
    try {
      const ctx = new AudioContext();
      const now = ctx.currentTime;
      [[880, 0], [1318.5, 0.11]].forEach(([freq, delay]) => {
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
    el.hotkeyBtn.textContent = prettyHotkey(s.hotkey);
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

  function stopHotkeyRecording() {
    if (!state.recordingHotkey) return;
    state.recordingHotkey = false;
    el.hotkeyBtn.classList.remove('recording');
    el.hotkeyBtn.textContent = prettyHotkey(state.settings?.hotkey);
  }

  el.hotkeyBtn.addEventListener('click', () => {
    if (state.recordingHotkey) { stopHotkeyRecording(); return; }
    state.recordingHotkey = true;
    el.hotkeyBtn.classList.add('recording');
    el.hotkeyBtn.textContent = 'Tasten drücken …';
    footer(el.hotkeyMsg, '');
  });

  el.hotkeyBtn.addEventListener('keydown', async (event) => {
    if (!state.recordingHotkey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { stopHotkeyRecording(); return; }
    const key = keyFromCode(event.code);
    if (!key) return;
    const mods = [];
    if (event.ctrlKey) mods.push('Control');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    if (event.metaKey) mods.push('Super');
    if (!mods.length) {
      footer(el.hotkeyMsg, 'Bitte mit Strg, Alt oder Umschalt kombinieren.', 'err');
      return;
    }
    const result = await save({ hotkey: [...mods, key].join('+') });
    stopHotkeyRecording();
    footer(el.hotkeyMsg, result.ok ? 'Gespeichert.' : result.error, result.ok ? 'ok' : 'err');
  });

  // ---------- Kopfzeile & Tastatur ----------

  el.island.addEventListener('click', (event) => {
    if (!state.open && !event.target.closest('.stop')) open();
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
    render();
    if (state.settings.hasKey) loadModels();
  })();
})();
