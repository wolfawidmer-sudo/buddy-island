# Buddy Island

Ein kleiner Assistent, der wie die Dynamic Island oben in der Mitte deines Windows-Bildschirms wohnt. Buddy läuft mit deinem eigenen Claude-API-Key: Er beantwortet Fragen, stellt Timer, zeigt deine Windows-Mitteilungen an und kann auf Wunsch den ganzen PC mit Maus und Tastatur bedienen.

<p align="center"><img src="docs/island-states.png" alt="Buddy Island im Ruhezustand, fertig und mit einer Mitteilung" width="420"></p>

| Chat | PC-Steuerung | Einstellungen |
| --- | --- | --- |
| ![Chat mit Timer und Mitteilungen](docs/chat.png) | ![Buddy fragt, ob er den PC steuern darf](docs/confirm.png) | ![Einstellungen](docs/settings.png) |

## Was Buddy kann

- **Chat mit Claude**: Antworten erscheinen live, mit Code-Blöcken und Kopieren-Knopf.
- **Timer**: «Stell einen Timer auf 10 Minuten». Der Countdown läuft im Island, am Ende wackelt Buddy und macht einen Ton.
- **Apps, Websites, Musik**: Rechner, Editor, Spotify öffnen; Musik pausieren, lauter oder leiser machen.
- **PC-Steuerung**: «Öffne den Editor und schreib eine Einkaufsliste». Buddy macht Bildschirmfotos und bedient Maus und Tastatur, bis die Aufgabe erledigt ist. Vorher fragt er um Erlaubnis.
- **Leuchtender Rand**: Solange Buddy nachdenkt, leuchtet der Bildschirmrand dezent weiss-grau, beim Steuern deutlich stärker. Wo Buddy klickt, erscheint eine kleine Welle.
- **Mitteilungen im Island**: Neue Windows-Mitteilungen (WhatsApp, Mail, Discord …) erscheinen kurz als Vorschau im Island.

![Leuchtender Rand während der PC-Steuerung](docs/glow.png)

## Installation (einfach)

1. **ZIP herunterladen**: Lade unter [Releases](../../releases) die Datei `BuddyIsland-…-win-x64.zip` herunter.
2. **Entpacken**: Rechtsklick → «Alle extrahieren …», zum Beispiel nach `C:\Users\<du>\AppData\Local\Programs\Buddy Island`.
3. **Starten**: Doppelklick auf `Buddy Island.exe`. Falls Windows «Der Computer wurde durch Windows geschützt» anzeigt: «Weitere Informationen» → «Trotzdem ausführen». Das erscheint, weil die App nicht kostenpflichtig signiert ist.
4. **Verknüpfungen**: Beim ersten Start legt Buddy selbst eine Verknüpfung im Startmenü und auf dem Desktop an.
5. **API-Key verbinden**:
   - Öffne die [Claude Console](https://platform.claude.com/settings/keys), melde dich an und klicke auf «Create key».
   - Kopiere den Key (er beginnt mit `sk-ant-`).
   - Klicke oben auf das Island → «API-Key verbinden» → Key einfügen → «Verbinden».
6. **Fertig**: Mit <kbd>Strg</kbd> + <kbd>Umschalt</kbd> + <kbd>Leertaste</kbd> öffnest du Buddy von überall.

### Optional: Mitteilungen nur noch im Island

Damit unten rechts nichts mehr aufpoppt, schalte in Windows **«Nicht stören»** ein (Einstellungen → System → Benachrichtigungen). Die Mitteilungen landen trotzdem bei Buddy. In Buddys Einstellungen gibt es dafür einen Knopf, der dich direkt dorthin bringt. Falls der Status «Zugriff verweigert» zeigt, erlaube unter Einstellungen → Datenschutz → Benachrichtigungen den Zugriff für Desktop-Apps.

## Selbst bauen

Voraussetzung: [Node.js](https://nodejs.org) 20 oder neuer.

```bash
git clone https://github.com/<dein-name>/buddy-island.git
cd buddy-island
npm install
npm start          # startet Buddy direkt aus dem Code
npm test           # Tests für die Claude-Anbindung und die Werkzeuge
npm run pack:win   # baut die Windows-App nach dist/
```

## Bedienung

| Was | Wie |
| --- | --- |
| Buddy öffnen / schliessen | <kbd>Strg</kbd> + <kbd>Umschalt</kbd> + <kbd>Leertaste</kbd> oder Klick aufs Island |
| PC-Steuerung stoppen | Gleiches Tastenkürzel oder der Stopp-Knopf im Island |
| Neuer Chat | <kbd>Strg</kbd> + <kbd>N</kbd> |
| Einstellungen | <kbd>Strg</kbd> + <kbd>,</kbd> |
| Schliessen | <kbd>Esc</kbd> |

## Sicherheit und Datenschutz

- **Dein API-Key** wird mit der Windows-Verschlüsselung (DPAPI, über Electrons `safeStorage`) nur auf deinem PC gespeichert und ausschliesslich an `api.anthropic.com` geschickt. Er steht nie im Code oder in diesem Repository.
- **Keine Telemetrie**: Buddy schickt nichts an andere Server.
- **PC-Steuerung** fragt vor jeder Aufgabe um Erlaubnis (abschaltbar). Buddy ist angewiesen, keine Passwörter oder Zahlungsdaten einzugeben, nichts zu kaufen und vor dem Verschicken von Nachrichten nachzufragen. Bildschirmfotos gehen dabei an Claude. Lass Buddy deshalb nicht steuern, während sensible Dinge offen sind.
- **Mitteilungen** bleiben auf deinem PC. Claude sieht sie nur, wenn du Buddy fragst, was du verpasst hast.
- Das Island und der leuchtende Rand werden aus Buddys Bildschirmfotos ausgeblendet (ab Windows 10, Version 2004).

## Ressourcen

Im Leerlauf läuft keine einzige Endlos-Animation: Das Fenster ist dann nur so gross wie das Island, und der leuchtende Rand ist ganz geschlossen. Der Steuerungs-Helfer startet erst, wenn Buddy steuern darf, und beendet sich nach zwei Minuten ohne Aktion. CPU und GPU sind im Leerlauf praktisch bei 0 %. Der RAM-Grundbedarf liegt bei etwa 80–120 MB, weil Buddy auf Electron (Chromium) läuft.

## Wie es funktioniert

| Datei | Aufgabe |
| --- | --- |
| `src/main.js` | Fenster, Tastenkürzel, Ablauf der Aufgaben mit Claude |
| `src/claude.js` | Anbindung an die Claude Messages API (Streaming, Prompt-Caching) |
| `src/tools.js` | Timer, Apps, Websites, Medientasten, Mitteilungen lesen |
| `src/computer.js` | Bildschirmfotos und Maus/Tastatur über Windows `SendInput` (kleiner PowerShell-Helfer) |
| `src/notifications.js` | Liest Windows-Mitteilungen über `UserNotificationListener` |
| `src/renderer/` | Das Island selbst (HTML, CSS, JS) |
| `src/glow/` | Der leuchtende Bildschirmrand |

## Bekannte Grenzen

- Nur Windows 10/11, nur der Hauptbildschirm.
- Fenster mit Administratorrechten (z. B. der Task-Manager) kann Windows für Buddy sperren.
- Die PC-Steuerung braucht ein aktuelles Claude-Modell (z. B. Claude Sonnet 5.5) und kostet mehr API-Guthaben als ein normaler Chat, weil Bildschirmfotos mitgeschickt werden.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Gebaut von Wolf Widmer.
