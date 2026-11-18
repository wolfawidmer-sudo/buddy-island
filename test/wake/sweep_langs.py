# Wakeword pro Sprache messen (synthetische Sprache, Piper-Stimmen von huggingface.co/rhasspy/piper-voices). Nicht im CI.
# Braucht: pip install vosk piper-tts numpy; in /tmp/vosk: vosk-model-small-<lang>/ und <stimme>.onnx(.json).
# Gleiche Logik wie im Sprach-Helfer: Wortliste = Füllwörter + Wakeword-Varianten, Treffer am Anfang
# (1. oder 2. Wort), Zwischenstände für Wakewords aus 2+ Wörtern, Schwelle minconf - 0.15.
# Aufruf: python3 -I test/wake/sweep_langs.py [de es it pt nl ...]
import json, io, os, sys, wave
# Ergebnis 11.11.2026 (nah / weit + Lüfter, Treffer und Fehlalarme): de 3/3 0/4 · 2/3 0/4 | en 3/3 0/4 · 3/3 0/4 | fr 3/3 0/4 · 3/3 0/4 |
# es 3/3 0/4 · 2/3 0/4 | it 3/3 0/4 · 2/3 0/4 | nl 3/3 0/4 · 3/3 0/4 | pt («Oi Robô», pt kennt «buddy» nicht) 0/3 0/4 · 0/3 0/4.
import numpy as np, vosk
from piper import PiperVoice
vosk.SetLogLevel(-1)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'wake-fillers')
GREET = json.load(open(os.path.join(ROOT, 'greetings.json'), encoding='utf8'))
ALLG = set(sum([v for k, v in GREET.items() if k != '_'], [])) | {'he', 'ok'}
MODEL = {'de': 'de-0.15', 'en': 'en-us-0.15', 'fr': 'fr-0.22', 'es': 'es-0.42', 'it': 'it-0.22', 'pt': 'pt-0.3', 'nl': 'nl-0.22'}
VOICE = {'de': 'de_DE-thorsten-medium', 'en': 'en_US-lessac-medium', 'fr': 'fr_FR-siwis-medium', 'es': 'es_ES-davefx-medium',
         'it': 'it_IT-paola-medium', 'pt': 'pt_BR-faber-medium', 'nl': 'nl_BE-nathalie-medium'}
# (Wakeword, soll erkannt werden, soll nicht erkannt werden). pt kennt «buddy» nicht: dort «Oi Robô».
SETS = {
 'de': ('Hey Buddy', ['Hey Buddy, stell einen Wecker.', 'Hallo Buddy, was läuft heute?', 'Okay Buddy'],
        ['Mein bester Buddy kommt heute vorbei.', 'Hey, hast du den Schlüssel gesehen?', 'Wir treffen uns um acht beim Bahnhof.', 'Hallo zusammen, das Essen ist fertig.']),
 'en': ('Hey Buddy', ['Hey Buddy, set a timer.', 'Hi Buddy, what is on today?', 'Okay Buddy'],
        ['My best buddy is coming over.', 'Hey, have you seen my keys?', 'We meet at eight at the station.', 'Hello everyone, dinner is ready.']),
 'fr': ('Hey Buddy', ['Hey Buddy, mets un minuteur.', 'Salut Buddy, quoi de neuf?', 'Ok Buddy'],
        ['Mon buddy arrive ce soir.', 'Salut, tu as vu mes clés?', 'On se voit à huit heures à la gare.', 'Bonjour à tous, le repas est prêt.']),
 'es': ('Hey Buddy', ['Hola Buddy, pon un temporizador.', 'Oye Buddy, ¿qué tiempo hace?', 'Hey Buddy'],
        ['Mi buddy viene esta tarde.', 'Hola, ¿has visto las llaves?', 'Nos vemos a las ocho en la estación.', 'Oye, la comida está lista.']),
 'it': ('Hey Buddy', ['Ciao Buddy, metti un timer.', 'Ehi Buddy, che tempo fa?', 'Hey Buddy'],
        ['Il mio buddy arriva stasera.', 'Ciao, hai visto le chiavi?', 'Ci vediamo alle otto in stazione.', 'Ehi, la cena è pronta.']),
 'pt': ('Oi Robô', ['Oi robô, coloca um alarme.', 'Olá robô, como está o tempo?', 'Ei robô'],
        ['O robô da fábrica parou.', 'Oi, você viu as chaves?', 'A gente se vê às oito na estação.', 'Olá a todos, o jantar está pronto.']),
 'nl': ('Hey Buddy', ['Hoi Buddy, zet een timer.', 'Hallo Buddy, wat staat er vandaag?', 'Hey Buddy'],
        ['Mijn buddy komt vanavond langs.', 'Hoi, heb je mijn sleutels gezien?', 'We zien elkaar om acht uur op het station.', 'Hallo allemaal, het eten is klaar.']),
}

def phrases(word, lang):
    w = word.lower(); p = w.split(' '); out = [w]; g = GREET.get(lang, GREET['en'])
    if len(p) == 1: out += [f'{x} {w}' for x in g]
    elif p[0] in ALLG: out += [f'{x} {" ".join(p[1:])}' for x in g]
    return list(dict.fromkeys(out))

def degrade(pcm, gain, noise, seed=1):
    a = np.frombuffer(pcm, np.int16).astype(np.float32) * gain
    if noise:
        rng = np.random.default_rng(seed)
        n = rng.normal(0, noise, len(a)).astype(np.float32)
        n = np.convolve(n, np.ones(8) / 8, mode='same') * 2.5  # tiefes Rauschen wie ein Lüfter
        a = a + n
    return np.clip(a, -32768, 32767).astype(np.int16).tobytes()

def run(lang):
    voice = PiperVoice.load(f'/tmp/vosk/{VOICE[lang]}.onnx')
    model = vosk.Model(f'/tmp/vosk/vosk-model-small-{MODEL[lang]}')
    fill = open(os.path.join(ROOT, f'{lang}.txt'), encoding='utf8').read().split()
    def speak(text):
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w: voice.synthesize_wav(text, w)
        buf.seek(0); w = wave.open(buf); sr = w.getframerate(); a = np.frombuffer(w.readframes(w.getnframes()), np.int16)
        idx = np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr)).astype(int)
        return np.concatenate([np.zeros(8000, np.int16), a[idx], np.zeros(32000, np.int16)]).tobytes()
    word, pos, neg = SETS[lang]
    ph = phrases(word, lang); minconf = 0.6 if ' ' in word else 0.75
    words = sorted(set(fill) | set(' '.join(ph).split()))
    cache = {s: speak(s) for s in pos + neg}
    def hit(text, p):
        w = text.split(); pw = p.split()
        return any(w[i:i + len(pw)] == pw for i in range(0, min(2, len(w))))
    def detect(sent, gain, noise):
        rec = vosk.KaldiRecognizer(model, 16000, json.dumps(words + ['[unk]'], ensure_ascii=False)); rec.SetWords(True)
        audio = degrade(cache[sent], gain, noise)
        for i in range(0, len(audio), 3200):
            if rec.AcceptWaveform(audio[i:i + 3200]):
                r = json.loads(rec.Result()); t = r.get('text', '')
                for p in ph:
                    if hit(t, p):
                        ws = [x for x in r.get('result', []) if x['word'] in p.split()]
                        if not ws or sum(x['conf'] for x in ws) / len(ws) >= minconf - 0.15: return True
            else:
                t = json.loads(rec.PartialResult()).get('partial', '')
                if any(' ' in p and hit(t, p) for p in ph): return True
        t = json.loads(rec.FinalResult()).get('text', '')
        return any(hit(t, p) for p in ph)
    out = []
    for gain, noise in [(1.0, 0), (0.15, 150)]:
        tp = sum(detect(s, gain, noise) for s in pos); fa = sum(detect(s, gain, noise) for s in neg)
        out.append((tp, len(pos), fa, len(neg)))
    return word, out

if __name__ == '__main__':
    print('| Sprache | Wakeword | nah: Treffer | nah: Fehlalarme | weit + Lüfter: Treffer | weit + Lüfter: Fehlalarme |')
    print('|---|---|---|---|---|---|')
    for lang in (sys.argv[1:] or list(SETS)):
        word, ((a, b, c, d), (e, f, g, h)) = run(lang)
        print(f'| {lang} | {word} | {a}/{b} | {c}/{d} | {e}/{f} | {g}/{h} |', flush=True)
