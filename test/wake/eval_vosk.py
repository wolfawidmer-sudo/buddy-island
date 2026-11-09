# Messung der Wakeword-Erkennung mit Vosk und synthetischer Sprache (Piper, Stimme thorsten). Nicht im CI.
# Braucht: pip install vosk piper-tts numpy; in /tmp/vosk: vosk-model-small-de-0.15/ und de_DE-thorsten-medium.onnx(.json).
# Ergebnis 10.11.2026: 20/23 richtig (verpasst: «Hey Jarvis»; Fehlalarme: «Hey, kiwi oder Banane?», «Kompott …»).
import json, wave, io, subprocess, sys, vosk, numpy as np
vosk.SetLogLevel(-1)
from piper import PiperVoice
voice = PiperVoice.load('/tmp/vosk/de_DE-thorsten-medium.onnx')
def speak(text):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w: voice.synthesize_wav(text, w)
    buf.seek(0); w = wave.open(buf); sr = w.getframerate(); a = np.frombuffer(w.readframes(w.getnframes()), np.int16)
    # auf 16 kHz
    idx = np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr)).astype(int)
    return np.concatenate([np.zeros(8000, np.int16), a[idx], np.zeros(16000, np.int16)]).tobytes()
GREET = ['hey', 'hallo', 'hi', 'he', 'okay', 'ok']
def phrases(w):
    w = w.lower(); p = w.split(' '); out = [w]
    if len(p) == 1: out += [f'{g} {w}' for g in GREET]
    elif p[0] in GREET: out += [f'{g} {" ".join(p[1:])}' for g in GREET]
    return list(dict.fromkeys(out))

model = vosk.Model('/tmp/vosk/vosk-model-small-de-0.15')
import os
FILL = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'wake-fillers', 'de.txt')).read().split()
SETS = {
 'Hey Buddy': (['Hey Buddy, stell einen Wecker.', 'Hey Buddy, was läuft heute?', 'Okay Buddy'],
               ['Mein bester Buddy kommt heute vorbei.', 'Hey, hast du den Schlüssel gesehen?', 'Wir treffen uns um acht beim Bahnhof.', 'Der Buddha steht im Garten.', 'Hey Leute, das Essen ist fertig!']),
 'Hey Kiwi': (['Hey Kiwi, wie wird das Wetter?', 'Hallo Kiwi'],
              ['Kiwis haben viel Vitamin C.', 'Hey, kiwi oder Banane?', 'Die Kirschen sind reif.', 'Heute Abend gibt es Pizza.']),
 'Jarvis': (['Jarvis, öffne den Browser.', 'Hey Jarvis'],
            ['Wir fahren nach Paris.', 'Das ist ein Service von uns.', 'Jahresabschluss ist im Dezember.']),
 'Computer': (['Computer, wie spät ist es?'],
              ['Der Computer ist kaputt.', 'Kompott mit Vanillesauce.', 'Kommst du heute später?']),
}
tot=ok=0; fp=fn=0
for word,(pos,neg) in SETS.items():
    ph=phrases(word)
    words=sorted(set(FILL)|set(' '.join(ph).split()))
    for kind,sents in (('soll',pos),('nicht',neg)):
        for s in sents:
            rec=vosk.KaldiRecognizer(model,16000,json.dumps(words+['[unk]'],ensure_ascii=False)); rec.SetWords(True)
            audio=speak(s); texts=[]
            for i in range(0,len(audio),3200):
                if rec.AcceptWaveform(audio[i:i+3200]): texts.append(json.loads(rec.Result()).get('text'))
            texts.append(json.loads(rec.FinalResult()).get('text'))
            got=any((' '+(t or '')+' ').startswith(' '+p+' ') for t in texts for p in ph)
            good=got==(kind=='soll'); tot+=1; ok+=good
            if not good: fp+= kind=='nicht'; fn+= kind=='soll'
            print(f'  {"✓" if good else "✗"} [{kind}] «{s}» → {got} {[t for t in texts if t]}')
print(f'== {ok}/{tot} richtig, {fn} verpasst, {fp} Fehlalarme')
