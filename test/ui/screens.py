"""Vorschau der Oberfläche im Browser (ohne Electron) mit nachgebauter Brücke.
Macht Screenshots und meldet Konsolenfehler. Aufruf: python3 test/ui/screens.py [Ausgabeordner]
Braucht Python-Playwright und Chrome (google-chrome)."""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/buddy-shots')
OUT.mkdir(parents=True, exist_ok=True)
MOCK_JS = (ROOT / 'test/ui/mock-api.js').read_text()
URL = (ROOT / 'src/renderer/index.html').as_uri()

def i18n(lang):
    if lang == 'de':
        return {'lang': 'de', 'dict': {}, 'locale': 'de-CH'}
    p = Path(f'/tmp/i18n-{lang}.json')
    return json.loads(p.read_text())

errors = []

def shot(browser, name, mock, steps, lang='de', size=(1000, 720), scale=1):
    ctx = browser.new_context(viewport={'width': size[0], 'height': size[1]}, device_scale_factor=scale)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    page.on('console', lambda m: errors.append(f'{name}: console {m.type}: {m.text}') if m.type == 'error' else None)
    page.add_init_script(f'window.__MOCK = {json.dumps(mock)}; window.__I18N = {json.dumps(i18n(lang))};\n' + MOCK_JS)
    page.goto(URL)
    page.wait_for_timeout(400)
    if mock.get('theme') == 'light':
        page.evaluate("document.body.style.background = '#c9ced6'")
    else:
        page.evaluate("document.body.style.background = '#5a6577'")
    for st in steps:
        if isinstance(st, str):
            page.evaluate(st)
        else:
            st(page)
        page.wait_for_timeout(250)
    page.wait_for_timeout(700)
    box = page.evaluate("(() => { const r = document.getElementById('island').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
    x, y, w, h = box
    page.screenshot(path=str(OUT / f'{name}.png'), clip={'x': max(0, x - 12), 'y': 0, 'width': min(size[0], w + 24), 'height': min(size[1], y + h + 12)})
    ctx.close()

OPEN = lambda view: f"window.__emit('onOpen', {json.dumps(view)})"
TAB = lambda tab: f"document.querySelector('[data-tab={tab}]').click()"
OB = lambda n: f"for (let i = 0; i < {n}; i++) document.getElementById('obNext').click()"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    dark, light = {'theme': 'dark'}, {'theme': 'light'}
    new_user = {'onboarded': False}
    # Einführung (neuer Nutzer): Start öffnet sie selbst
    for i in range(5):
        shot(b, f'onboarding-{i+1}-dark', {**new_user, 'theme': 'dark'}, [OB(i)])
    shot(b, 'onboarding-2-light', {**new_user, 'theme': 'light'}, [OB(1)])
    shot(b, 'onboarding-1-en', {**new_user}, [], lang='en')
    shot(b, 'onboarding-2-fr', {**new_user}, [OB(1)], lang='fr')
    # Konto
    shot(b, 'account-signedout-dark', dark, [OPEN('account')])
    shot(b, 'account-signedout-light', light, [OPEN('account')])
    shot(b, 'account-signedin-dark', {**dark, 'signedIn': True}, [OPEN('account')])
    shot(b, 'account-signedin-light', {**light, 'signedIn': True, 'sub': True}, [OPEN('account')])
    # Chat
    shot(b, 'chat-signedout-dark', dark, [OPEN('chat')])
    shot(b, 'chat-existing-user-hint-dark', {**dark, 'cloudNotice': 'keys-removed'}, [OPEN('chat')])
    shot(b, 'chat-ready-light', {**light, 'signedIn': True}, [OPEN('chat')])
    # Einstellungen
    for tab in ['general', 'features', 'safety', 'keys', 'system']:
        shot(b, f'settings-{tab}-dark', {**dark, 'signedIn': True}, [OPEN('settings'), TAB(tab)])
    shot(b, 'settings-general-light', {**light, 'signedIn': True}, [OPEN('settings')])
    shot(b, 'settings-system-advanced-light', {**light, 'signedIn': True}, [OPEN('settings'), TAB('system'), "document.getElementById('modelBox').open = true"])
    # Wenig Platz: kleiner Bildschirm und 200 %
    shot(b, 'small-settings-dark', {**dark, 'signedIn': True}, [OPEN('settings')], size=(700, 480))
    shot(b, 'scale200-onboarding-dark', {**new_user, 'theme': 'dark'}, [OB(1)], size=(683, 384), scale=2)
    shot(b, 'scale200-account-light', {**light, 'signedIn': True}, [OPEN('account')], size=(683, 384), scale=2)
    b.close()

print('\n'.join(errors) if errors else 'keine Konsolenfehler')
print(f'Screenshots: {OUT}')
