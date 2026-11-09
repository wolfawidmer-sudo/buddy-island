// Offenes Island: Eingabefeld muss immer ganz sichtbar und bedienbar sein.
// Szenarien: leer mit allen Karten, lange Unterhaltung, sehr lange Nachricht, mehrzeilige Eingabe,
// alles gleichzeitig. Prüft auch die 75-%-Grenze der Fensterhöhe.
// Aufruf: xvfb-run -a -s "-screen 0 1366x768x24" node test/e2e/layout.e2e.js [Skalierung]
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scale = process.argv[2] || '1';
const shots = process.env.LAYOUT_SHOTS || '';
let failed = 0;
const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FEHLER'} [${scale}x] ${text}`); if (!ok) failed += 1; };

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-layout-'));
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..', '..'), `--user-data-dir=${ud}`, '--no-sandbox', `--force-device-scale-factor=${scale}`], env: { ...process.env, LANG: 'de_CH.UTF-8' } });
  const page = await app.firstWindow();
  await page.waitForTimeout(1800);
  const info = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Buddy Island');
    const d = screen.getDisplayMatching(w.getBounds());
    return { win: w.getBounds(), display: d.bounds, scale: d.scaleFactor };
  });
  const share = info.win.height / info.display.height;
  check(share <= 0.7501, `Fensterhöhe ${info.win.height} von ${info.display.height} (${(share * 100).toFixed(1)} %, Skalierung ${info.scale})`);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Buddy Island').webContents.send('island:open', 'chat'));
  await page.waitForTimeout(900);

  const measure = () => page.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const isl = document.getElementById('island').getBoundingClientRect();
    const inner = document.querySelector('.body-inner').getBoundingClientRect();
    const c = r('composer');
    const ta = r('input');
    const hit = document.elementFromPoint(ta.left + ta.width / 2, ta.top + ta.height / 2);
    const m = document.getElementById('messages');
    return {
      winH: innerHeight, islandBottom: isl.bottom, innerBottom: inner.bottom, composerTop: c.top, composerBottom: c.bottom,
      composerH: c.height, hitInput: hit === document.getElementById('input'), sendVisible: r('sendBtn').bottom <= inner.bottom + 0.5,
      msgScroll: m.scrollHeight > m.clientHeight + 1, msgH: m.clientHeight,
    };
  });
  const verify = async (name) => {
    await page.waitForTimeout(250);
    const v = await measure();
    const ok = v.composerBottom <= v.innerBottom + 0.5 && v.composerBottom <= v.winH && v.islandBottom <= v.winH + 0.5 && v.hitInput && v.sendVisible && v.composerTop >= 0;
    check(ok, `${name}: Eingabe ${Math.round(v.composerTop)}–${Math.round(v.composerBottom)}, sichtbar bis ${Math.round(v.innerBottom)}, Fenster ${v.winH}, Treffer=${v.hitInput}, Unterhaltung ${v.msgH}px${v.msgScroll ? ' (scrollt)' : ''}`);
    if (shots) await page.screenshot({ path: path.join(shots, `layout-${scale}-${name.replace(/\W+/g, '_')}.png`) });
    return v;
  };

  // 1) Leerzustand mit allen Karten gleichzeitig
  await page.evaluate(() => {
    document.body.style.background = '#6b7d93';
    document.getElementById('composer').hidden = false; // wie mit eingerichteter KI
    for (const id of ['inbox', 'agenda', 'nowPlaying', 'timers', 'empty']) document.getElementById(id).hidden = false;
    document.getElementById('nowTitle').textContent = 'Ein Lied mit einem ziemlich langen Titel';
    document.getElementById('nowSub').textContent = 'Eine Band';
    const add = (listId, n, text) => { const l = document.getElementById(listId); for (let i = 0; i < n; i += 1) { const d = document.createElement('div'); d.className = 'note'; d.innerHTML = `<span class="note-app">App</span><span class="note-text">${text} ${i}</span>`; l.appendChild(d); } };
    add('inboxList', 8, 'Mitteilung mit Text');
    add('agendaList', 5, 'Termin');
    const t = document.getElementById('timers');
    for (let i = 0; i < 3; i += 1) { const d = document.createElement('div'); d.className = 'timer'; d.innerHTML = `<span>Timer ${i}</span><span>09:59</span>`; t.appendChild(d); }
    document.getElementById('connectBtn').hidden = false;
  });
  await verify('Leer + alle Karten');

  // 2) Lange Unterhaltung
  await page.evaluate(() => {
    document.getElementById('empty').hidden = true;
    const m = document.getElementById('messages');
    for (let i = 0; i < 40; i += 1) {
      const d = document.createElement('div');
      d.className = i % 2 ? 'bubble' : 'answer';
      d.textContent = `Nachricht ${i}: ` + 'ein längerer Text, der umbrechen muss. '.repeat(i % 5 + 1);
      m.appendChild(d);
    }
  });
  await verify('lange Unterhaltung');

  // 3) Sehr lange Einzelnachricht ohne Leerzeichen und mit Code
  await page.evaluate(() => {
    const m = document.getElementById('messages');
    const d = document.createElement('div'); d.className = 'answer';
    d.innerHTML = '<p>' + 'x'.repeat(3000) + '</p><pre><code>' + 'const a = 1;\n'.repeat(80) + '</code></pre>';
    m.appendChild(d);
  });
  await verify('sehr lange Nachricht');

  // 4) Mehrzeilige Eingabe
  await page.click('#input');
  await page.keyboard.insertText(Array.from({ length: 30 }, (_, i) => `Zeile ${i}`).join('\n'));
  await page.evaluate(() => document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true })));
  const v = await verify('30 Zeilen Eingabe');
  check(v.msgH >= 50, `Unterhaltung bleibt sichtbar (${v.msgH}px)`);

  // 5) Tippen funktioniert noch
  await page.keyboard.insertText(' ok');
  const val = await page.evaluate(() => document.getElementById('input').value.endsWith(' ok'));
  check(val, 'Eingabe nimmt Text an');

  await app.close();
  console.log(failed ? `layout.e2e: ${failed} Fehler` : 'layout.e2e: alles ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
