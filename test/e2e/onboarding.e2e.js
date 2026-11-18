// Einführung und Oberfläche im Browser (ohne Electron) mit nachgebauter Brücke (test/ui/mock-api.js).
// Prüft: erster Start zeigt die Einführung, überspringen, durchklicken, erneut starten, bestehende
// Nutzer sehen sie nicht (nur den Hinweis), Reiter in den Einstellungen, keine alten Bereiche,
// Google-Knopf nach Vorgabe, keine Konsolenfehler.
// Aufruf: node test/e2e/onboarding.e2e.js   (Chrome: CHROME=/pfad/zu/chrome, sonst /usr/bin/google-chrome)
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const URL = pathToFileURL(path.join(ROOT, 'src/renderer/index.html')).href;
const MOCK = fs.readFileSync(path.join(ROOT, 'test/ui/mock-api.js'), 'utf8');
let failed = 0;
const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FEHLER'} ${text}`); if (!ok) failed += 1; };

async function page(browser, mock, i18n = { lang: 'de', dict: {}, locale: 'de-CH' }) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 720 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') p.errors.push(m.text()); });
  await p.addInitScript(`window.__MOCK = ${JSON.stringify(mock)}; window.__I18N = ${JSON.stringify(i18n)};\n${MOCK}`);
  await p.goto(URL);
  await p.waitForTimeout(500);
  return p;
}
const visible = (p, sel) => p.evaluate((s) => { const n = document.querySelector(s); return Boolean(n && !n.closest('[hidden]') && n.getClientRects().length); }, sel);
const settings = (p) => p.evaluate(() => window.buddy.getSettings());

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  // 1) Erster Start: Einführung öffnet sich selbst, Schritt 1
  {
    const p = await page(browser, { onboarded: false });
    check(await visible(p, '#onboardingView'), 'erster Start: Einführung ist offen');
    check(await visible(p, '.ob-step[data-step="0"]'), 'erster Start: Schritt 1 (Begrüssung, Sprache)');
    check(!(await visible(p, '#settingsBtn')), 'Einführung: kein Weg daneben (Einstellungen-Knopf versteckt)');
    // Schritt 2: das Anmeldeformular wandert in die Einführung, mit Google-Knopf
    await p.click('#obNext');
    check(await p.evaluate(() => document.getElementById('cloudSignedOut').parentElement.id === 'obSigninHost'), 'Schritt 2: Anmeldeformular in der Einführung');
    check(await visible(p, '#cloudGoogle'), 'Schritt 2: «Mit Google anmelden» sichtbar');
    check((await p.textContent('#obNext')).trim() === 'Später', 'Schritt 2 ohne Konto: «Später» statt «Weiter»');
    // Überspringen: Einführung zu, gespeichert, Formular zurück im Konto
    await p.click('#obSkip');
    await p.waitForTimeout(200);
    check(!(await visible(p, '#onboardingView')) && await visible(p, '#chatView'), 'Überspringen: zurück im Chat');
    check((await settings(p)).onboarded === true, 'Überspringen: onboarded gespeichert');
    check(await p.evaluate(() => document.getElementById('cloudSignedOut').closest('#accountView') !== null), 'Formular wieder in der Kontoansicht');
    check(await p.evaluate(() => localStorage.getItem('buddy.onboarding.step') === null), 'Schritt-Speicher aufgeräumt');
    // Erneut starten: System › Einführung zeigen
    await p.evaluate(() => window.__emit('onOpen', 'settings'));
    await p.click('[data-tab="system"]');
    await p.click('#onboardingBtn');
    check(await visible(p, '.ob-step[data-step="0"]'), 'erneut gestartet: wieder bei Schritt 1');
    check(p.errors.length === 0, `keine Konsolenfehler (${p.errors.join(' | ') || '–'})`);
  }

  // 2) Durchklicken bis zum Ende mit Konto: Beispiel-Frage schliesst ab
  {
    const p = await page(browser, { onboarded: false, signedIn: true });
    for (let i = 0; i < 4; i += 1) await p.click('#obNext');
    check(await visible(p, '#obChips'), 'letzter Schritt mit Konto: Beispiel-Fragen');
    check((await p.textContent('#obNext')).trim() === 'Los geht’s', 'letzter Schritt: «Los geht’s»');
    await p.click('#obChips .chip');
    await p.waitForTimeout(200);
    check((await settings(p)).onboarded === true && await visible(p, '#chatView'), 'Beispiel-Frage: Einführung fertig, Chat offen');
    check(p.errors.length === 0, `keine Konsolenfehler (${p.errors.join(' | ') || '–'})`);
  }

  // 3) Letzter Schritt ohne Konto: Anmelden statt Beispiel-Fragen
  {
    const p = await page(browser, { onboarded: false });
    for (let i = 0; i < 4; i += 1) await p.click('#obNext');
    check(!(await visible(p, '#obChips')) && await visible(p, '#obToAccount'), 'letzter Schritt ohne Konto: «Anmelden»');
    await p.click('#obToAccount');
    await p.waitForTimeout(200);
    check(await visible(p, '#accountView') && await visible(p, '#cloudGoogle'), '«Anmelden» führt ins Konto');
  }

  // 4) Bestehender Nutzer: keine Einführung, aber Hinweis im Chat; «Verstanden» quittiert
  {
    const p = await page(browser, { onboarded: true, cloudNotice: 'keys-removed' });
    await p.evaluate(() => window.__emit('onOpen', 'chat'));
    await p.waitForTimeout(600);
    check(!(await visible(p, '#onboardingView')), 'bestehender Nutzer: keine Einführung');
    check(await visible(p, '#cloudHint') && /API-Keys/.test(await p.textContent('#cloudHintText')), 'bestehender Nutzer: Hinweis «Neu: Buddy Cloud»');
    check(!(await visible(p, '#composer')) && await visible(p, '#connectBtn'), 'ohne Konto: kein Eingabefeld, dafür «Anmelden»');
    await p.click('#cloudHintDismiss');
    await p.waitForTimeout(150);
    check(!(await visible(p, '#cloudHint')) && (await settings(p)).cloudNotice === null, '«Verstanden» quittiert den Hinweis');
  }

  // 5) Einstellungen: fünf Reiter, immer nur einer sichtbar, alte Bereiche weg
  {
    const p = await page(browser, { onboarded: true, signedIn: true });
    await p.evaluate(() => window.__emit('onOpen', 'settings'));
    await p.waitForTimeout(600);
    const tabs = await p.$$eval('#tabNav button', (b) => b.map((x) => x.dataset.tab));
    check(tabs.join() === 'general,features,safety,keys,system', `fünf Reiter (${tabs.join()})`);
    for (const tab of tabs) {
      await p.click(`[data-tab="${tab}"]`);
      const shown = await p.$$eval('.pane', (ps) => ps.filter((x) => !x.hidden).map((x) => x.dataset.pane));
      check(shown.length === 1 && shown[0] === tab, `Reiter ${tab}: genau ein Bereich sichtbar`);
    }
    const gone = await p.evaluate(() => ['providerSelect', 'keyInput', 'ollamaBox', 'localCard', 'usageView', 'adminAnthInput', 'limitSelect', 'healthBtn', 'toolsList'].filter((id) => document.getElementById(id)));
    check(gone.length === 0, `keine alten Bereiche (eigene Keys, lokale KI, Admin-Keys, Kosten) (${gone.join(',') || '–'})`);
    check(p.errors.length === 0, `keine Konsolenfehler (${p.errors.join(' | ') || '–'})`);
  }

  // 6) Google-Knopf nach Vorgabe (dunkel und hell), lokales G-Logo, Text je Sprache
  for (const theme of ['dark', 'light']) {
    const p = await page(browser, { onboarded: true, theme });
    await p.evaluate(() => window.__emit('onOpen', 'account'));
    await p.waitForTimeout(600);
    const g = await p.evaluate(() => {
      const b = document.getElementById('cloudGoogle');
      const cs = getComputedStyle(b);
      const img = b.querySelector('img');
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, color: cs.color, h: b.getBoundingClientRect().height, src: img.getAttribute('src'), w: img.getBoundingClientRect().width, loaded: img.complete && img.naturalWidth > 0, text: b.textContent.trim() };
    });
    const want = theme === 'dark' ? { bg: 'rgb(19, 19, 20)', stroke: 'rgb(142, 145, 143)', color: 'rgb(227, 227, 227)' } : { bg: 'rgb(255, 255, 255)', stroke: 'rgb(116, 119, 117)', color: 'rgb(31, 31, 31)' };
    check(g.bg === want.bg && g.shadow.includes(want.stroke) && g.color === want.color, `Google-Knopf ${theme}: Fläche, Kante, Text nach Vorgabe (${g.bg}, ${g.color})`);
    check(g.h === 40 && g.w === 20 && g.loaded && g.src === 'img/google-g.svg', `Google-Knopf ${theme}: 40 px hoch, G 20 px, lokal geladen`);
    check(g.text === 'Mit Google anmelden', `Google-Knopf ${theme}: Text «${g.text}»`);
  }
  for (const [lang, text] of [['en', 'Sign in with Google'], ['fr', 'Se connecter avec Google']]) {
    const dict = require(path.join(ROOT, 'src/i18n', lang));
    const p = await page(browser, { onboarded: true }, { lang, dict, locale: lang === 'en' ? 'en-GB' : 'fr-CH' });
    await p.evaluate(() => window.__emit('onOpen', 'account'));
    await p.waitForTimeout(500);
    check((await p.textContent('#cloudGoogleText')).trim() === text, `Google-Knopf ${lang}: «${text}»`);
  }

  await browser.close();
  console.log(failed ? `${failed} Fehler` : 'Einführungs- und Oberflächen-Tests ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
