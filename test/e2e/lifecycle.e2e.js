// Lebensdauer des Island-Fensters (Regressionstest für «TypeError: Object has been destroyed»):
// frischer Start, 15× öffnen/schliessen, Alt+F4, zweiter Programmstart, zerstörtes Fenster wird
// neu erstellt, Absturz der Oberfläche, Beenden. Fängt jede unbehandelte Ausnahme im Hauptprozess.
// Aufruf: npm run test:lifecycle  (unter Linux ohne Bildschirm: xvfb-run -a npm run test:lifecycle)
// Gepackte App: node test/e2e/lifecycle.e2e.js <Pfad zur ausführbaren Datei> --packaged
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const path = require('path');
const packaged = process.argv.includes('--packaged');
const appDir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..', '..');
const name = packaged ? 'gepackt' : 'Lebensdauer';
(async () => {
  const ud = fs.mkdtempSync(path.join(require('os').tmpdir(), 'buddy-lifecycle-'));
  let failed = false;
  const app = await electron.launch({ executablePath: packaged ? appDir : require('electron'), args: [...(packaged ? [] : [appDir]), `--user-data-dir=${ud}`, '--no-sandbox'], env: { ...process.env, LANG: 'de_CH.UTF-8' } });
  await app.evaluate(() => { global.__errs = []; process.on('uncaughtException', (e) => global.__errs.push(e.message)); process.on('unhandledRejection', (e) => global.__errs.push('rejection: ' + (e?.message || e))); });
  const page = await app.firstWindow();
  await page.waitForTimeout(2000);
  const errs = () => app.evaluate(() => global.__errs.slice());
  const wins = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getTitle() === 'Buddy Island').length);
  const report = async (step) => {
    const n = await wins(); const e = await errs();
    if (n !== 1 || e.length) failed = true;
    console.log(`${name} | ${step.padEnd(34)} Fenster=${n} Fehler=${JSON.stringify(e)}`);
  };
  await report('frischer Start');
  // Wiederholt öffnen und schliessen
  for (let i = 0; i < 15; i++) { await app.evaluate(({ app }) => app.emit('second-instance')); await page.waitForTimeout(60); await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(60); }
  await report('15× öffnen/schliessen');
  // Alt+F4 / close(): Overlay soll bleiben
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Buddy Island')?.close());
  await sleep(300);
  await report('Fenster schliessen (Alt+F4)');
  await app.evaluate(({ app }) => app.emit('second-instance'));
  await sleep(1500);
  await report('danach zweiter Programmstart');
  // Fenster wird zerstört (z. B. von Windows/Treiber), dann zweiter Programmstart und Tray
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Buddy Island')?.destroy());
  await page.waitForTimeout(300).catch(() => {});
  await app.evaluate(({ app }) => app.emit('second-instance'));
  await new Promise((r) => setTimeout(r, 2500));
  await report('zerstört + zweiter Programmstart');
  const w2 = app.windows().find((p) => !p.isClosed());
  if (w2) {
    await w2.waitForTimeout(500);
    console.log(`${name} | neues Fenster offen: ${await w2.evaluate(() => document.getElementById('island')?.classList.contains('open')).catch(() => 'n/a')}`);
  }
  await app.evaluate(({ app }) => app.emit('second-instance'));
  await new Promise((r) => setTimeout(r, 500));
  await report('nochmals öffnen');
  // Absturz der Oberfläche
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Buddy Island')?.webContents.forcefullyCrashRenderer());
  await new Promise((r) => setTimeout(r, 2500));
  await report('Oberfläche abgestürzt');
  // Beenden
  const closed = new Promise((r) => app.process().once('exit', (c) => r(c)));
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => {});
  const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r('hängt'), 8000))]);
  console.log(`${name} | Beenden: Exit-Code ${code}`);
  if (code === 'hängt') { app.process().kill(); failed = true; }
  fs.rmSync(ud, { recursive: true, force: true });
  if (failed) { console.error('Lebensdauer-Test FEHLGESCHLAGEN'); process.exit(1); }
  console.log('Lebensdauer-Test ok');
})().catch((e) => { console.error(name, 'Testabbruch:', e.message.split('\n')[0]); process.exit(1); });
