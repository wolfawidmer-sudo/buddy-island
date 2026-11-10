// Nachgebaute Brücke (window.buddy) für die Vorschau im Browser. Kein Electron, keine Netzaufrufe.
// Szenario kommt aus window.__MOCK (von screens.py gesetzt).
(function () {
  const M = window.__MOCK || {};
  const listeners = {};
  const on = (name) => (cb) => { (listeners[name] = listeners[name] || []).push(cb); return () => {}; };
  window.__emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb(payload));
  const cloudState = () => ({
    configured: M.cloudConfigured !== false,
    signedIn: Boolean(M.signedIn),
    email: M.signedIn ? 'wolf@example.com' : null,
    displayName: M.signedIn ? 'Wolf' : null,
    provider: 'google',
    status: 'ok',
    wallet: M.signedIn ? { available: M.balance ?? 482.5, subscriptionCredits: M.sub ? 1000 : 0, subscriptionExpiresAt: '2026-12-09T00:00:00Z' } : null,
    subscription: M.sub ? { active: true, plan: { name: 'Buddy Plus', monthlyCredits: 1000 }, currentPeriodEnd: '2026-12-09T00:00:00Z' } : null,
    googleRunning: false,
  });
  const settings = Object.assign({
    name: 'Buddy', provider: 'buddy', model: 'cloud:gpt-6.1-terra', autoModel: true, effort: 'auto', theme: M.theme || 'dark',
    accent: '#F2F2F7', hotkey: 'Control+Shift+Space', shortcuts: { newChat: '', settings: '', stop: '', voice: '' }, customShortcuts: [],
    sound: true, autostart: false, computerUse: true, confirmControl: true, notifications: true, media: true, gameMode: true,
    calendarLead: 10, voiceWake: false, speak: true, permissions: { medium: 'ask', high: 'ask' }, historyEnabled: true, memoryEnabled: true,
    promptPrefs: { length: 'normal', style: 'friendly', notes: '' }, language: 'auto', lang: (window.__I18N || {}).lang || 'de',
    languages: [{ id: 'de', name: 'Deutsch' }, { id: 'en', name: 'English' }, { id: 'fr', name: 'Français' }],
    providers: [{ id: 'buddy', name: 'Buddy Cloud', hasKey: Boolean(M.signedIn) }], hasKey: Boolean(M.signedIn),
    displays: [{ id: '1', label: 'Bildschirm 1 (1920×1080)' }], version: '0.13.0', canUpdate: true, canControl: true,
    updateState: { state: 'latest' }, notifyStatus: 'Allowed', voiceInfo: null, onboarded: M.onboarded !== false, cloudNotice: M.cloudNotice || null,
  }, M.settings || {});
  const ok = (extra) => Promise.resolve(Object.assign({ ok: true, settings, state: cloudState() }, extra || {}));
  const cloud = {
    state: () => ok(), reload: () => ok(), login: () => ok(), signup: () => ok(), verifyEmail: () => ok(), google: () => ok(), cancelGoogle: () => ok(),
    logout: () => ok(), requestPasswordReset: () => ok(), confirmPasswordReset: () => ok(), portal: () => ok(), subscribe: () => ok(),
    offer: () => ok({ config: { ready: true, minPurchase: '5', maxPurchase: '500', creditsPerUsd: '100' },
      plans: [{ id: 'plus', name: 'Buddy Plus', monthlyCredits: 1000, price: 10 }],
      packages: [{ id: 'p5', name: 'Klein', credits: 500, price: 5 }, { id: 'p20', name: 'Mittel', credits: 2000, price: 20 }] }),
    history: () => ok({ history: { usage: [{ model: 'gpt-6-luna', createdAt: '2026-11-09T16:02:00Z', credits: 0.038275, status: 'settled' }], purchases: [{ credits: 500, amount: 5, status: 'completed', completedAt: '2026-11-09T15:40:00Z' }] } }),
    buy: () => ok({ checkout: { credits: 500, amount: 5 } }), buyAmount: () => ok({ checkout: { credits: 500, amount: 5 } }),
  };
  const base = {
    i18n: window.__I18N || { lang: 'de', dict: {}, locale: 'de-CH' },
    cloud,
    getSettings: () => Promise.resolve(settings),
    setSettings: (patch) => { Object.assign(settings, patch); return ok(); },
    listModels: () => Promise.resolve({ models: [{ id: 'cloud:gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'cloud:gpt-6.1-terra', name: 'GPT-6.1 Terra' }] }),
    getAiStats: () => Promise.resolve({ usage: null, history: [] }),
    getTimers: () => Promise.resolve([]), listNotifications: () => Promise.resolve([]), getMedia: () => Promise.resolve(null),
    // Chat: antwortet sofort mit M.reply (für Screenshots von Antworten)
    sendChat: (id) => { setTimeout(() => { window.__emit('onDelta', { id, text: M.reply || 'Okay.' }); window.__emit('onDone', { id, stopReason: 'end_turn' }); }, 30); },
    listMemory: () => Promise.resolve([]), upcomingEvents: () => Promise.resolve([]), runDiagnostics: () => Promise.resolve([]),
  };
  window.buddy = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && /^on[A-Z]/.test(prop)) return on(prop);
      return () => Promise.resolve({ ok: true, settings });
    },
  });
})();
