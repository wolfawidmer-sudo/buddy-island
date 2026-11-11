"""Screenshots für den Microsoft Store (1920×1080) aus der echten Oberfläche (src/renderer), mit Attrappen-Daten.
Aufruf: python3 test/ui/store_shots.py  → /tmp/store-shots/*.png
Vorher /tmp/i18n-en.json und /tmp/i18n-fr.json erzeugen (siehe screens.py)."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
MOCK_JS = (ROOT / 'test/ui/mock-api.js').read_text()
URL = (ROOT / 'src/renderer/index.html').as_uri()
OUT = Path('/tmp/store-shots'); OUT.mkdir(exist_ok=True)

# Ruhiger Desktop-Hintergrund statt transparentem Fenster
DESKTOP_CSS = """
html, body { background: #23262c !important; }
"""

QUESTIONS = {
    'de': ('Schreib Lisa kurz, dass ich 15 Minuten später komme.',
           'Klar, zum Beispiel so:\n\n**Hoi Lisa, ich bin leider etwa 15 Minuten später da. Tut mir leid, bis gleich!**\n\nSoll ich es lockerer oder förmlicher formulieren?'),
    'en': ('Write Lisa a short note that I\'ll be 15 minutes late.',
           'Sure, for example:\n\n**Hi Lisa, I\'m running about 15 minutes late. Sorry, see you soon!**\n\nWant it more casual or more formal?'),
    'fr': ('Écris vite à Lisa que j\'aurai 15 minutes de retard.',
           'Bien sûr, par exemple :\n\n**Salut Lisa, j\'aurai environ 15 minutes de retard. Désolé, à tout de suite !**\n\nTu veux un ton plus détendu ou plus formel ?'),
}

def i18n(lang):
    return {'lang': 'de', 'dict': {}, 'locale': 'de-CH'} if lang == 'de' else json.loads(Path(f'/tmp/i18n-{lang}.json').read_text())

def shot(b, name, lang, mock, steps, theme='dark'):
    ctx = b.new_context(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    page = ctx.new_page()
    page.add_init_script(f'window.__MOCK = {json.dumps({**mock, "theme": theme})}; window.__I18N = {json.dumps(i18n(lang))};\n' + MOCK_JS)
    page.goto(URL)
    page.add_style_tag(content=DESKTOP_CSS)
    page.wait_for_timeout(500)
    for st in steps:
        page.evaluate(st)
        page.wait_for_timeout(400)
    page.wait_for_timeout(900)
    page.screenshot(path=str(OUT / f'{lang}-{name}.png'))
    ctx.close()

OPEN = lambda v: f"window.__emit('onOpen', {json.dumps(v)})"
TAB = lambda t: f"document.querySelector('[data-tab={t}]').click()"

def send(q):
    return f"(() => {{ const i = document.getElementById('input'); i.value = {json.dumps(q)}; i.dispatchEvent(new Event('input')); document.getElementById('sendBtn').click(); }})()"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for lang in ['de', 'en', 'fr']:
        q, a = QUESTIONS[lang]
        base = {'signedIn': True, 'balance': 482.5}
        shot(b, '1-chat', lang, {**base, 'reply': a}, [OPEN('chat'), send(q)])
        shot(b, '2-konto', lang, base, [OPEN('account')])
        shot(b, '3-einstellungen', lang, base, [OPEN('settings'), TAB('general')])
        shot(b, '4-chat-hell', lang, {**base, 'reply': a}, [OPEN('chat'), send(q)], theme='light')
        shot(b, '5-geschlossen', lang, base, [])
    b.close()
print('ok', len(list(OUT.glob('*.png'))))
