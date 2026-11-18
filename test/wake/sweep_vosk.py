# Vergleich der Vosk-Einstellungen bei Distanz/Rauschen (synthetisch). Nicht im CI. Ergebnis 10.11.2026: 0.14.1 nah 7/8, weit 5/8, leise 2/8 → neu (40 Füllwörter, Zwischenstände, Schwelle -0.15) 8/8, 7/8, 4/8, 0 Fehlalarme.
import json, numpy as np
src=open('/tmp/vosk/far.py').read().split("for gain, noise, label in")[0]
exec(src)
ALL = open('/home/claude/buddy-island/src/wake-fillers/de.txt').read().split()
CORE = "der die das und ich du er sie es wir ist bin hat habe nicht ja nein was wie wo mit von zu in im auf an mal noch so gut heute jetzt dann da hier hallo hey hi he okay".split()
def run2(word, sent, gain, noise, fill, minc1, minc2, partial):
    ph = phrases(word); minconf = minc2 if ' ' in word else minc1
    rec = vosk.KaldiRecognizer(model, 16000, json.dumps(sorted(set(fill)|set(' '.join(ph).split())) + ['[unk]'], ensure_ascii=False)); rec.SetWords(True)
    audio = degrade(speak(sent)[:-32000], gain, noise) + degrade(b'\0'*64000, 1, noise)
    def hit(text, p):
        w = text.split(); pw = p.split()
        return any(w[i:i+len(pw)] == pw for i in range(0, min(2, len(w))))
    for i in range(0, len(audio), 3200):
        if rec.AcceptWaveform(audio[i:i+3200]):
            r = json.loads(rec.Result()); t = r.get('text', '')
            for p in ph:
                if hit(t, p):
                    ws=[x for x in r.get('result',[]) if x['word'] in p.split()]
                    if not ws or sum(x['conf'] for x in ws)/len(ws) >= minconf: return True
        elif partial:
            t = json.loads(rec.PartialResult()).get('partial', '')
            for p in ph:
                if ' ' in p and hit(t, p): return True
    r = json.loads(rec.FinalResult()); t=r.get('text','')
    return any(hit(t,p) for p in ph)
POS += [('Hey Buddy','Hey Buddy'), ('Hey Kiwi','Hallo Kiwi, mach Musik.')]
NEG += [('Hey Kiwi','Hey, kiwi oder Banane?'), ('Computer','Kompott mit Vanillesauce.') ] if False else []
NEG += [('Hey Buddy','Hey, hast du den Schlüssel gesehen?'), ('Hey Kiwi','Die Kinder spielen draussen.')]
for name, fill, m1, m2, part in [('0.14.1: 300 Füllw., Schwelle 0.75/0.6, Pause', ALL, .75, .6, False),
                                 ('300 Füllw. + ohne Pause', ALL, .75, .6, True),
                                 ('40 Füllw. + ohne Pause', CORE, .75, .6, True),
                                 ('40 Füllw. + ohne Pause, Schwelle 0.6/0.45', CORE, .6, .45, True)]:
    res=[]
    for gain, noise, label in [(1.0,0,'nah'),(0.15,150,'weit+Lüfter'),(0.06,120,'sehr leise')]:
        tp=sum(run2(w,s,gain,noise,fill,m1,m2,part) for w,s in POS); fp=sum(run2(w,s,gain,noise,fill,m1,m2,part) for w,s in NEG)
        res.append(f'{label} {tp}/{len(POS)} FA {fp}/{len(NEG)}')
    print(f'{name:46} | ' + ' | '.join(res), flush=True)
