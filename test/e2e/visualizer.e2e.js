// Musik-Visualizer und Bildschirmrand mit einem Ersatz-Audiohelfer (gleiches Zeilenformat wie unter Windows).
// Prüft: Wiedergabe gemeldet ohne Ton = Ruhe; echter Ton = Balken + Rand; Pause = zurück in Ruhe;
// Weiterspielen = sofort; Rand deckt den ganzen Bildschirm ab (bounds, nicht workArea), nimmt keinen Fokus;
// Rand beim Bedienen erst nach 3 s; Akzentfarbe; keine doppelten Analyse-Prozesse; Aufräumen beim Beenden.
// Aufruf: xvfb-run -a node test/e2e/visualizer.e2e.js
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appDir = path.join(__dirname, '..', '..');
let failed = 0;
const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FEHLER'} ${text}`); if (!ok) failed += 1; };
const helperCount = () => { try { return Number(execSync('pgrep -fc "[f]ake-audio[.]js"').toString().trim()); } catch { return 0; } };

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-viz-'));
  const stateFile = path.join(ud, 'audio-state');
  const setAudio = (m) => fs.writeFileSync(stateFile, m);
  setAudio('pause');
  const app = await electron.launch({
    // Gepackte App: E2E_EXE=<Pfad zur ausführbaren Datei>
    executablePath: process.env.E2E_EXE || require('electron'),
    args: [...(process.env.E2E_EXE ? [] : [appDir]), `--user-data-dir=${ud}`, '--no-sandbox', ...(process.env.E2E_ARGS ? process.env.E2E_ARGS.split(' ') : [])],
    env: { ...process.env, LANG: 'de_CH.UTF-8', BUDDY_TEST_HOOKS: '1', BUDDY_FAKE_AUDIO: path.join(__dirname, 'fake-audio.js'), BUDDY_FAKE_AUDIO_STATE: stateFile },
  });
  await app.evaluate(() => { global.__errs = []; process.on('uncaughtException', (e) => global.__errs.push(e.message)); });
  const page = await app.firstWindow();
  await page.waitForTimeout(2500);
  const hook = (name, arg) => app.evaluate((_e, [n, a]) => global.__buddyTest[n](a), [name, arg]);
  const glowWin = () => app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() === 'Buddy Glow');
    if (!w) return null;
    const d = screen.getDisplayMatching(w.getBounds());
    return { bounds: w.getBounds(), display: d.bounds, workArea: d.workArea, focusable: w.isFocusable(), top: w.isAlwaysOnTop(), visible: w.isVisible() };
  });
  const bars = () => page.evaluate(() => [...document.querySelectorAll('.eq i')].map((b) => Number((b.style.transform.match(/scaleY\(([\d.]+)\)/) || [0, 0.18])[1])));
  const media = { app: 'Spotify.exe', title: 'Testlied', artist: 'Band', playing: true, status: 'Playing' };

  check(!(await hook('audioRunning')) && (await hook('glowMode')) === 'off', 'Start: keine Analyse, kein Rand');

  await hook('media', { ...media, playing: false, status: 'Paused' });
  await sleep(600);
  check(!(await hook('audioRunning')), 'Spotify offen, pausiert: Analyse läuft gar nicht');

  await hook('media', media);
  await sleep(1200);
  check(await hook('audioRunning'), 'Windows meldet Wiedergabe: Analyse startet');
  check(!(await hook('musicActive')) && (await hook('glowMode')) === 'off' && !(await glowWin()), 'aber ohne hörbaren Ton: Ruhe, kein Rand');
  const idleBars = await bars();
  check(idleBars.every((v) => v < 0.2), `Balken still ohne Ton (${idleBars.join(', ')})`);

  setAudio('play');
  await sleep(350);
  check(await hook('musicActive'), 'Ton läuft: in < 350 ms aktiv');
  await sleep(900);
  check((await hook('glowMode')) === 'music', 'Rand im Musik-Modus');
  const g = await glowWin();
  const near = (a, b) => a && b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
  check(g && near(g.bounds, g.display), `Rand = ganzer Bildschirm (±1 px) ${JSON.stringify(g?.bounds)} (Arbeitsbereich ${JSON.stringify(g?.workArea)})`);
  check(g && !g.focusable && g.top && g.visible, 'Rand: kein Fokus, immer oben, sichtbar');
  const samples = [];
  for (let i = 0; i < 6; i += 1) { samples.push((await bars())[0]); await sleep(90); }
  check(Math.max(...samples) - Math.min(...samples) > 0.15, `Bass-Balken folgt dem Takt (${samples.map((v) => v.toFixed(2)).join(' ')})`);
  const glowPage = app.windows().find((p) => p.url().includes('glow.html'));
  const layers = glowPage ? await glowPage.evaluate(() => ({ haze: document.querySelector('.haze').style.transform, sheen: document.querySelector('.sheen').style.transform, mode: document.body.dataset.mode })) : null;
  check(layers && layers.mode === 'music' && /scaleY/.test(layers.haze) && /translateX/.test(layers.sheen), `Rand-Schichten reagieren (${JSON.stringify(layers)})`);

  // Akzentfarbe
  await page.evaluate(() => window.buddy.setSettings({ accent: '#FF375F' }));
  await sleep(300);
  const accent = glowPage ? await glowPage.evaluate(() => document.documentElement.style.getPropertyValue('--accent')) : '';
  check(accent.toLowerCase() === '#ff375f', `Rand übernimmt Akzentfarbe (${accent})`);

  // Pause
  setAudio('pause');
  await sleep(600);
  check(await hook('musicActive'), 'kurze Stille (< 1,2 s) hält die Anzeige');
  await sleep(1000);
  check(!(await hook('musicActive')) && (await hook('glowMode')) === 'off', 'Pause: zurück in Ruhe');
  await sleep(1200);
  check(!(await glowWin()), 'Rand-Fenster danach geschlossen (keine Kosten)');
  const after = await bars();
  check(after.every((v) => v < 0.22), `Balken sanft auf Ruhe (${after.map((v) => v.toFixed(2)).join(', ')})`);

  // Weiterspielen
  setAudio('play');
  await sleep(300);
  check(await hook('musicActive'), 'Weiterspielen: sofort wieder aktiv');
  check(helperCount() === 1, `genau ein Analyse-Prozess (${helperCount()})`);

  // Einstellungen
  await page.evaluate(() => window.buddy.setSettings({ glowMusic: false }));
  await sleep(400);
  check((await hook('glowMode')) === 'off', 'Rand zur Musik ausgeschaltet: kein Rand');
  await page.evaluate(() => window.buddy.setSettings({ visualizer: false }));
  await sleep(400);
  check(!(await hook('audioRunning')) && helperCount() === 0, 'Visualizer und Rand aus: Analyse beendet');
  await page.evaluate(() => window.buddy.setSettings({ visualizer: true, glowMusic: true }));
  await sleep(500);
  check(await hook('audioRunning'), 'wieder eingeschaltet: Analyse läuft');
  setAudio('pause');
  await sleep(1800);

  // Bedienen: Rand erst nach 3 s
  await hook('control', true);
  await sleep(1000);
  await hook('control', false);
  await sleep(2500);
  check((await hook('glowMode')) === 'off', 'kurzer Blick auf den Bildschirm (1 s): kein Rand');
  await hook('control', true);
  await sleep(2500);
  check((await hook('glowMode')) === 'off', 'nach 2,5 s Bedienen noch kein Rand');
  await sleep(800);
  check((await hook('glowMode')) === 'control', 'nach > 3 s Bedienen: Rand erscheint');
  await hook('control', false);
  await sleep(200);
  check((await hook('glowMode')) === 'off', 'Bedienen fertig: Rand weg');

  const errs = await app.evaluate(() => global.__errs.slice());
  check(errs.length === 0, `keine Fehler im Hauptprozess ${JSON.stringify(errs)}`);
  const closed = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 50); });
  await Promise.race([closed, sleep(8000)]);
  await sleep(300);
  check(helperCount() === 0, 'nach dem Beenden kein Analyse-Prozess übrig');
  console.log(failed ? `visualizer.e2e: ${failed} Fehler` : 'visualizer.e2e: alles ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
