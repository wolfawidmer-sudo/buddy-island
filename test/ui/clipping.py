"""Sucht abgeschnittene Elemente in der Oberfläche: Text, der nicht in sein Feld passt,
und Knöpfe/Bedienelemente, die über den Rand ihres Behälters ragen.
Alle Ansichten, Reiter, Einführung, Hell/Dunkel, DE/EN/FR, normal, kleiner Bildschirm und 200 %.
Aufruf: python3 test/ui/clipping.py   (vorher /tmp/i18n-en.json und /tmp/i18n-fr.json erzeugen, siehe screens.py)
Exit-Code 1, wenn etwas abgeschnitten ist."""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
MOCK_JS = (ROOT / 'test/ui/mock-api.js').read_text()
URL = (ROOT / 'src/renderer/index.html').as_uri()
OUT = Path('/tmp/buddy-clip'); OUT.mkdir(exist_ok=True)

def i18n(lang):
    if lang == 'de':
        return {'lang': 'de', 'dict': {}, 'locale': 'de-CH'}
    return json.loads(Path(f'/tmp/i18n-{lang}.json').read_text())

# Prüfung im Browser. Gemeldet wird nur, was der Nutzer wirklich sieht:
#  A) Text in einem Element mit overflow hidden/clip ist breiter/höher als das Element (ohne Ellipse gewollt? auch melden)
#  B) ein Bedienelement (button, input, select, a, label.row, .switch) ragt über einen Vorfahren mit overflow hidden/clip
#     oder horizontal über einen Scroll-Behälter oder über das Island.
CHECK = r"""
(() => {
  const out = [];
  const island = document.getElementById('island');
  const ir = island.getBoundingClientRect();
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    // Inhalt eines zugeklappten <details> ist unsichtbar (nur die Überschrift zählt)
    const closed = el.closest('details:not([open])');
    if (closed && !el.closest('summary') && el !== closed) return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || n.hidden) return false;
    }
    return true;
  };
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `${el.tagName.toLowerCase()}${id}${cls} «${txt}»`;
  };
  const all = island.querySelectorAll('*');
  for (const el of all) {
    if (!visible(el) || el.closest('svg') || el.tagName === 'svg') continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // A) Text passt nicht ins eigene Feld
    const clips = /hidden|clip/.test(cs.overflowX + cs.overflowY) ;
    const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (clips && hasText && !/auto|scroll/.test(cs.overflowX + cs.overflowY)) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`Text abgeschnitten (Breite ${el.scrollWidth}>${el.clientWidth}${cs.textOverflow === 'ellipsis' ? ', Ellipse' : ''}): ${name(el)}`);
      else if (el.scrollHeight > el.clientHeight + 2 && cs.webkitLineClamp === 'none') out.push(`Text abgeschnitten (Höhe ${el.scrollHeight}>${el.clientHeight}): ${name(el)}`);
    }
    // Eingaben: Platzhalter oder Wert breiter als das Feld
    if ((el.tagName === 'INPUT' && /text|email|password|search|number|^$/.test(el.type)) || el.tagName === 'SELECT') {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`Feldinhalt abgeschnitten: ${name(el)}`);
    }
    // B) Bedienelemente ragen aus einem Behälter
    // Scroll-Listen selbst auch prüfen: ihr sichtbarer Bereich muss ganz im Island liegen
    const control = el.matches('button, input:not([type=checkbox]):not([type=radio]), select, textarea, a, .switch, .row, .seg, .chip') || /auto|scroll/.test(cs.overflowY);
    if (!control) continue;
    // In einer Scroll-Liste darf ein Element unten/oben ausserhalb liegen (man scrollt hin), seitlich nie
    let inScroll = false;
    for (let p = el.parentElement; p && p !== island; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) { inScroll = true; break; }
    if (r.left < ir.left - 1 || r.right > ir.right + 1 || (!inScroll && (r.top < ir.top - 1 || r.bottom > ir.bottom + 1))) {
      out.push(`ragt aus dem Island: ${name(el)}`);
      continue;
    }
    // Nicht erreichbar: liegt in keiner Scroll-Liste und trotzdem ausserhalb des Fensters
    if (!inScroll && (r.bottom > innerHeight + 1 || r.right > innerWidth + 1)) out.push(`ausserhalb des Fensters: ${name(el)}`);
    let behindScroll = false; // oberhalb einer Scroll-Liste zählt nur noch seitlich
    for (let p = el.parentElement; p && p !== island; p = p.parentElement) {
      const ps = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      const scrollY = /auto|scroll/.test(ps.overflowY);
      const scrollX = /auto|scroll/.test(ps.overflowX);
      const hidX = /hidden|clip/.test(ps.overflowX), hidY = /hidden|clip/.test(ps.overflowY);
      if ((hidX || scrollX) && (r.left < pr.left - 1 || r.right > pr.right + 1)) { out.push(`seitlich abgeschnitten von ${name(p).slice(0, 40)}: ${name(el)}`); break; }
      if (hidY && !scrollY && !behindScroll && (r.top < pr.top - 1 || r.bottom > pr.bottom + 1)) { out.push(`oben/unten abgeschnitten von ${name(p).slice(0, 40)}: ${name(el)}`); break; }
      if (scrollY) behindScroll = true;
    }
  }
  return [...new Set(out)];
})()
"""

OPEN = lambda view: f"window.__emit('onOpen', {json.dumps(view)})"
TAB = lambda tab: f"document.querySelector('[data-tab={tab}]').click()"
OB = lambda n: f"for (let i = 0; i < {n}; i++) document.getElementById('obNext').click()"
SEND = "(() => { const i = document.getElementById('input'); i.value = 'Wie wird das Wetter morgen in Zürich und brauche ich einen Schirm?'; i.dispatchEvent(new Event('input')); document.getElementById('sendBtn').click(); })()"
HOVER_TOOLS = "document.querySelectorAll('.msg-tools').forEach((t) => t.style.opacity = '1')"
REPLY = 'Morgen wird es in Zürich **wechselhaft**: am Vormittag bewölkt, ab 15 Uhr Regen bei etwa 9 °C. Nimm den Schirm mit.'

problems = {}
count = 0

def check(b, name, mock, steps, lang='de', size=(1000, 720), scale=1, shot=False):
    global count
    ctx = b.new_context(viewport={'width': size[0], 'height': size[1]}, device_scale_factor=scale)
    page = ctx.new_page()
    page.add_init_script(f'window.__MOCK = {json.dumps(mock)}; window.__I18N = {json.dumps(i18n(lang))};\n' + MOCK_JS)
    page.goto(URL)
    page.wait_for_timeout(400)
    for st in steps:
        page.evaluate(st)
        page.wait_for_timeout(250)
    page.wait_for_timeout(600)
    found = page.evaluate(CHECK)
    count += 1
    if found:
        problems[name] = found
    if shot or found:
        page.screenshot(path=str(OUT / f'{name}.png'))
    ctx.close()

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for lang in ['de', 'en', 'fr']:
        for theme in ['dark', 'light']:
            base = {'theme': theme}
            sizes = [((1000, 720), 1, ''), ((700, 480), 1, '-klein'), ((683, 384), 2, '-200')]
            for size, scale, tag in sizes:
                k = f'{lang}-{theme}{tag}'
                for i in range(5):
                    check(b, f'{k}-einfuehrung-{i+1}', {**base, 'onboarded': False}, [OB(i)], lang, size, scale)
                check(b, f'{k}-konto-aus', base, [OPEN('account')], lang, size, scale)
                check(b, f'{k}-konto-an', {**base, 'signedIn': True, 'sub': True}, [OPEN('account')], lang, size, scale)
                check(b, f'{k}-chat-leer', {**base, 'signedIn': True}, [OPEN('chat')], lang, size, scale)
                check(b, f'{k}-chat-antwort', {**base, 'signedIn': True, 'reply': REPLY}, [OPEN('chat'), SEND, HOVER_TOOLS], lang, size, scale, shot=(tag == '' and theme == 'dark'))
                check(b, f'{k}-chat-hinweis', {**base, 'cloudNotice': 'keys-removed'}, [OPEN('chat')], lang, size, scale)
                for tab in ['general', 'features', 'safety', 'keys', 'system']:
                    check(b, f'{k}-einst-{tab}', {**base, 'signedIn': True}, [OPEN('settings'), TAB(tab)], lang, size, scale)
                check(b, f'{k}-einst-erweitert', {**base, 'signedIn': True}, [OPEN('settings'), TAB('system'), "document.getElementById('modelBox').open = true"], lang, size, scale)
                check(b, f'{k}-einst-store', {**base, 'signedIn': True, 'settings': {'storeBuild': True, 'canUpdate': False, 'autostart': True, 'storeAutostart': {'state': 'DisabledByUser', 'blocked': True}, 'updateState': {'state': 'idle'}}}, [OPEN('settings'), TAB('system')], lang, size, scale, shot=(tag == '' and theme == 'dark'))
    b.close()

print(f'{count} Ansichten geprüft')
for k, v in problems.items():
    print(f'\n[{k}]')
    for x in v:
        print('  ' + x)
print(f'\nScreenshots: {OUT}')
sys.exit(1 if problems else 0)
