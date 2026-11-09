// @ts-check
// Buddy-Cloud-Konto im Hauptprozess: Anmeldung, Sitzung, Guthaben, Verläufe, Kauf.
// Tokens bleiben im Hauptprozess (verschlüsselt mit safeStorage gespeichert) und gehen
// nie an die Oberfläche. Die Oberfläche bekommt nur publicState() ohne Tokens.
// Ohne Internet oder bei Ausfall des Backends läuft Buddy normal weiter (lokale KI, eigene Keys).

const { authorize } = require('./google-oauth');

const REFRESH_BEFORE_SEC = 120;
const TIMEOUT_MS = 15000;

class CloudError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {{
 *   apiUrl: () => string,
 *   fetchImpl?: typeof fetch,
 *   storage: { load: () => any, save: (session: any|null) => void },
 *   openExternal: (url: string) => Promise<void>|void,
 *   t?: (s: string, v?: any) => string,
 *   log?: (m: string) => void,
 *   onChange?: (state: any) => void,
 *   now?: () => number,
 * }} opts
 */
function createCloudAccount({ apiUrl, fetchImpl = globalThis.fetch, storage, openExternal, t = (s) => s, log = () => {}, onChange = () => {}, now = Date.now }) {
  /** @type {{ accessToken: string, refreshToken: string, expiresAt: number, user: { id: string, email?: string, provider?: string|null } } | null} */
  let session = null;
  /** @type {any} */
  let profile = null;
  /** @type {any} */
  let wallet = null;
  /** @type {any} */
  let subscription = null;
  let status = 'signed_out'; // signed_out | signed_in | offline | expired
  /** @type {string|null} */
  let lastError = null;
  /** @type {Promise<void>|null} */
  let refreshing = null;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let refreshTimer;
  /** @type {AbortController|null} */
  let googleFlow = null;

  const configured = () => Boolean(apiUrl());

  function publicState() {
    return {
      configured: configured(),
      signedIn: Boolean(session),
      status,
      email: session?.user?.email || null,
      provider: session?.user?.provider || null,
      displayName: profile?.displayName || null,
      wallet: wallet ? {
        available: wallet.available,
        purchased: wallet.purchased ?? wallet.available,
        subscriptionCredits: wallet.subscription?.credits ?? '0',
        subscriptionExpiresAt: wallet.subscription?.expiresAt ?? null,
        reserved: wallet.reserved,
        lifetimeConsumed: wallet.lifetimeConsumed,
      } : null,
      subscription: subscription ? {
        status: subscription.status,
        active: Boolean(subscription.active),
        currentPeriodEnd: subscription.currentPeriodEnd || null,
        cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
        plan: subscription.plan || null,
      } : null,
      error: lastError,
      googleRunning: Boolean(googleFlow),
    };
  }
  const changed = () => { try { onChange(publicState()); } catch { /* Oberfläche zu */ } };

  /** @param {string} method @param {string} path @param {{ body?: any, auth?: boolean, retry?: boolean }} [opts] */
  async function request(method, path, { body, auth = false, retry = true } = {}) {
    const base = apiUrl();
    if (!base) throw new CloudError('not_configured', t('Buddy Cloud ist in dieser Version noch nicht verfügbar.'));
    if (auth) await ensureFresh();
    if (auth && !session) throw new CloudError('signed_out', t('Bitte melde dich an.'), 401);
    let r;
    try {
      r = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(auth && session ? { authorization: `Bearer ${session.accessToken}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new CloudError('offline', t('Buddy Cloud ist gerade nicht erreichbar. Lokale KI funktioniert weiter.'));
    }
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (r.ok) return data;
    const code = String(data?.error?.code || 'error');
    const message = String(data?.error?.message || t('Unbekannter Fehler.'));
    // Token abgelehnt: einmal erneuern und nochmals versuchen
    if (auth && r.status === 401 && retry && session) {
      await refresh(true).catch(() => {});
      if (session) return request(method, path, { body, auth, retry: false });
    }
    throw new CloudError(code, message, r.status);
  }

  /** @param {any} s */
  function setSession(s) {
    if (!s?.accessToken || !s?.refreshToken) throw new CloudError('bad_session', t('Ungültige Antwort vom Server.'));
    session = { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: Number(s.expiresAt) || 0, user: s.user || { id: '' } };
    storage.save(session);
    status = 'signed_in';
    lastError = null;
    schedule();
  }

  function clearSession(next = 'signed_out') {
    session = null;
    profile = null;
    wallet = null;
    subscription = null;
    status = next;
    clearTimeout(refreshTimer);
    storage.save(null);
  }

  function schedule() {
    clearTimeout(refreshTimer);
    if (!session) return;
    const ms = Math.max(5000, (session.expiresAt - REFRESH_BEFORE_SEC) * 1000 - now());
    refreshTimer = setTimeout(() => { refresh().catch(() => {}); }, Math.min(ms, 2 ** 31 - 1));
    /** @type {any} */ (refreshTimer).unref?.();
  }

  /** Sitzung erneuern (nur einmal gleichzeitig) @param {boolean} [force] */
  function refresh(force = false) {
    if (!session) return Promise.resolve();
    if (!force && session.expiresAt - REFRESH_BEFORE_SEC > now() / 1000) return Promise.resolve();
    if (refreshing) return refreshing;
    const token = session.refreshToken;
    refreshing = (async () => {
      try {
        const data = await request('POST', '/v1/auth/refresh', { body: { refreshToken: token } });
        setSession(data.session);
      } catch (err) {
        const e = /** @type {CloudError} */ (err);
        if (e.status === 401) {
          clearSession('expired');
          lastError = t('Deine Anmeldung ist abgelaufen. Bitte melde dich neu an.');
        } else if (e.code === 'offline') {
          status = 'offline';
          schedule();
        }
        throw err;
      } finally {
        refreshing = null;
        changed();
      }
    })();
    return refreshing;
  }

  /** Vor jeder Cloud-Anfrage: Token gültig? Offline ist kein Fehler hier. */
  async function ensureFresh() {
    if (!session) return;
    if (session.expiresAt - REFRESH_BEFORE_SEC > now() / 1000) return;
    try { await refresh(); } catch (err) { if (/** @type {any} */ (err).code !== 'offline') throw err; }
  }

  /** Beim Start: gespeicherte Sitzung laden und prüfen. Wirft nie. */
  async function restore() {
    try {
      const s = storage.load();
      if (s?.accessToken && s?.refreshToken) {
        session = s;
        status = 'signed_in';
        schedule();
        await loadMe();
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e.code === 'offline') status = 'offline';
      log(`Cloud: Sitzung wiederherstellen: ${e.code || 'Fehler'}`);
    }
    changed();
  }

  async function loadMe() {
    const data = await request('GET', '/v1/me', { auth: true });
    profile = data.profile;
    wallet = data.wallet;
    subscription = data.subscription || null;
    if (session) status = 'signed_in';
    changed();
    return publicState();
  }

  /** @param {any} data */
  function signedIn(data) {
    setSession(data.session);
    changed();
    return loadMe().catch(() => publicState());
  }

  // ---- Aktionen für die Oberfläche ----
  async function signup(/** @type {{ email: string, password: string, displayName?: string }} */ input) {
    const data = await request('POST', '/v1/auth/signup', { body: input });
    if (data.session) return { ...(await signedIn(data)), confirmationRequired: false };
    return { ...publicState(), confirmationRequired: true };
  }
  const login = async (/** @type {{ email: string, password: string }} */ input) => signedIn(await request('POST', '/v1/auth/login', { body: input }));
  const verifyEmail = async (/** @type {{ email: string, code: string }} */ input) => signedIn(await request('POST', '/v1/auth/verify-email', { body: input }));
  const resendConfirmation = async (/** @type {{ email: string }} */ input) => { await request('POST', '/v1/auth/resend-confirmation', { body: input }); return { ok: true }; };
  const requestPasswordReset = async (/** @type {{ email: string }} */ input) => { await request('POST', '/v1/auth/password-reset', { body: input }); return { ok: true }; };
  const confirmPasswordReset = async (/** @type {{ email: string, code: string, password: string }} */ input) => signedIn(await request('POST', '/v1/auth/password-reset/confirm', { body: input }));

  async function google() {
    if (googleFlow) throw new CloudError('busy', t('Die Google-Anmeldung läuft schon im Browser.'));
    googleFlow = new AbortController();
    changed();
    try {
      const cfg = await request('GET', '/v1/auth/google/config');
      const result = await authorize({
        clientId: cfg.clientId,
        openExternal,
        signal: googleFlow.signal,
        texts: {
          ok: [t('Angemeldet'), t('Du kannst dieses Fenster schliessen und zu Buddy zurückkehren.')],
          fail: [t('Anmeldung abgebrochen'), t('Du kannst dieses Fenster schliessen. Versuch es in Buddy nochmals.')],
        },
      });
      return await signedIn(await request('POST', '/v1/auth/google', { body: result }));
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e instanceof CloudError) throw e;
      const map = {
        google_cancelled: t('Google-Anmeldung abgebrochen.'),
        google_timeout: t('Google-Anmeldung hat zu lange gedauert. Bitte nochmals.'),
        browser_failed: t('Der Browser liess sich nicht öffnen.'),
        google_not_configured: t('Google-Anmeldung ist noch nicht eingerichtet.'),
      };
      throw new CloudError(String(e.message), /** @type {any} */ (map)[e.message] || t('Google-Anmeldung fehlgeschlagen.'));
    } finally {
      googleFlow = null;
      changed();
    }
  }
  const cancelGoogle = () => { googleFlow?.abort(); };

  async function logout() {
    try { if (session) await request('POST', '/v1/auth/logout', { auth: true, retry: false }); } catch { /* lokal trotzdem abmelden */ }
    clearSession();
    lastError = null;
    changed();
    return publicState();
  }

  const updateProfile = async (/** @type {{ displayName: string }} */ input) => {
    const data = await request('PATCH', '/v1/me', { auth: true, body: input });
    profile = data.profile;
    changed();
    return publicState();
  };

  const history = async () => {
    const [u, p, tx] = await Promise.all([
      request('GET', '/v1/usage?limit=30', { auth: true }),
      request('GET', '/v1/purchases?limit=30', { auth: true }),
      request('GET', '/v1/wallet/transactions?limit=30', { auth: true }),
    ]);
    return { usage: u.usage, purchases: p.purchases, transactions: tx.transactions };
  };

  const packages = async () => (await request('GET', '/v1/credit-packages')).packages;
  const plans = async () => (await request('GET', '/v1/subscription-plans')).plans;
  const billingConfig = async () => request('GET', '/v1/billing/config');

  /** Nur echte Stripe-Seiten im Browser öffnen */
  async function openStripe(/** @type {string} */ url, /** @type {RegExp} */ allowed) {
    if (!allowed.test(String(url))) throw new CloudError('bad_checkout', t('Ungültige Zahlungsseite.'));
    await openExternal(url);
  }

  /**
   * Pay as you go: Paket ODER eigener Betrag in USD («12.50»). Öffnet Stripe Checkout im
   * System-Browser. Gutschrift kommt nur über den Webhook.
   * @param {{ packageId?: string, amount?: string }} what
   */
  async function buy(what) {
    const body = what.packageId ? { packageId: what.packageId } : { amount: String(what.amount || '') };
    const data = await request('POST', '/v1/purchases/checkout', { auth: true, body });
    await openStripe(data.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
    return { amount: data.amount, currency: data.currency, credits: data.credits };
  }

  /** Abo abschliessen (Stripe Checkout, monatlich) */
  async function subscribe(/** @type {string} */ planId) {
    const data = await request('POST', '/v1/subscription/checkout', { auth: true, body: { planId } });
    await openStripe(data.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
    return { plan: data.plan };
  }

  /** Abo verwalten (kündigen, Zahlungsart, Rechnungen) im Stripe-Kundenportal */
  async function portal() {
    const data = await request('POST', '/v1/subscription/portal', { auth: true });
    await openStripe(data.portalUrl, /^https:\/\/billing\.stripe\.com\//);
    return {};
  }

  /** Für den Anbieter «Buddy Cloud»: aktuelles Access-Token (synchron) */
  const accessToken = () => session?.accessToken || null;

  /** Nach einer Cloud-Antwort: Guthaben neu laden (Fehler egal) */
  const refreshWallet = () => request('GET', '/v1/wallet', { auth: true }).then((d) => { wallet = d.wallet; changed(); }).catch(() => {});

  return {
    publicState, restore, ensureFresh, accessToken, refresh, refreshWallet, loadMe,
    signup, login, verifyEmail, resendConfirmation, requestPasswordReset, confirmPasswordReset,
    google, cancelGoogle, logout, updateProfile, history, packages, plans, billingConfig, buy, subscribe, portal, configured,
  };
}

module.exports = { createCloudAccount, CloudError };
