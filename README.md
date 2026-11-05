# Buddy Island

Ein kleiner Assistent, der wie die Dynamic Island oben in der Mitte deines Windows-Bildschirms wohnt. Buddy läuft gratis mit einer lokalen KI auf deinem PC oder mit deinem eigenen API-Key von Claude, OpenAI, Grok oder Gemini: Er beantwortet Fragen, stellt Timer, zeigt Musik, Termine und Windows-Mitteilungen, hört auf «Hey Buddy» und kann auf Wunsch den ganzen PC mit Maus und Tastatur bedienen.

**Website:** https://wolfawidmer-sudo.github.io/buddy-island-website/ ([Quellcode der Website](https://github.com/wolfawidmer-sudo/buddy-island-website))

> **Status:** Testversion (0.6). Getestet mit einer simulierten Claude-API unter Linux. Auf echten Windows-PCs bitte den Selbsttest in den Einstellungen laufen lassen.

<p align="center"><img src="docs/island-states.png" alt="Buddy Island geschlossen: Ruhe, Timer, Musik und Notch" width="600"></p>

| Plan und Modellwahl | Freigabe bei hohem Risiko | KI-Nutzung |
| --- | --- | --- |
| ![Mehrstufige Aufgabe mit Plan, Sonnet → Haiku](docs/chat.png) | ![Buddy fragt vor dem Löschen](docs/confirm.png) | ![Dashboard der KI-Nutzung](docs/usage.png) |

## Was Buddy kann

- **Ruhiges Island**: Geschlossen zeigt Buddy nur seine Augen, genau in der Mitte. Kein Text, keine Symbole. Öffnen und Schliessen laufen ohne springende Texte.
- **Notch-Modus**: Island anklicken, gedrückt halten und schon 1 Pixel nach oben ziehen: Es wird sofort zu einem tiefschwarzen Notch am Bildschirmrand. 1 Pixel nach unten oder ein Klick holt es zurück.
- **Passende Grösse**: Offen ist das Island höchstens 75 % der Bildschirmhöhe hoch (richtig umgerechnet bei Windows-Skalierung); Listen scrollen, das Eingabefeld bleibt sichtbar.
- **Gedächtnis**: «Merk dir, dass …» speichert kurze Notizen lokal. Gespeichert wird nur auf ausdrücklichen Wunsch, nie Passwörter, Karten- oder Kontonummern; an die KI geht nur, was zur Frage passt. In den Einstellungen einzeln löschbar.
- **Mehrere KI-Anbieter**: Anthropic Claude, OpenAI, xAI Grok, Google Gemini oder ein lokales Modell über Ollama (ältere Einrichtungen mit Hugging Face Transformers laufen weiter). Alle hängen an einer gemeinsamen Schnittstelle (`LlmClient`), jeder Anbieter hat eine Fähigkeitsmatrix (Bilder, Werkzeuge, PC-Steuerung, strukturierte Ausgabe). Kann ein Modell etwas nicht, sagt Buddy das im Island, statt abzustürzen.
- **Lokal zuerst**: Ohne API-Key bietet Buddy eine lokale KI an. Er erkennt Prozessor, Arbeitsspeicher, Grafikkarte (NVIDIA, AMD, Intel, integriert) und freien Platz, empfiehlt «Empfohlen», «Am schnellsten» und «Beste Qualität», zeigt die Download-Grösse und fragt vorher. Dann installiert er Ollama (offizielles Installationsprogramm, Signatur wird geprüft, ohne Administratorrechte), lädt das Modell mit Fortschritt, Tempo und Restzeit, lädt es, testet es kurz und öffnet den Chat. Siehe [Lokale KI](#lokale-ki).
- **Verbindungstest**: Einstellungen → «Provider & API-Keys» → «Verbindung testen» prüft jeden verbundenen Anbieter Schritt für Schritt (Key und Modellliste, einfache Antwort ohne Streaming, Streaming, Verlauf, Werkzeug mit Fortsetzung, parallele Werkzeuge, Router). Jeder Schritt läuft unabhängig und bekommt einen Status: Funktioniert, Eingeschränkt, Temporär nicht verfügbar, Nicht unterstützt, Konfigurationsfehler oder Fehler in der Integration. Ist das Hauptmodell gerade überlastet, prüft der Test die übrigen Funktionen mit einem Modell, das geantwortet hat. Fehler nennen Anbieter, Modell, API-Version, HTTP-Status, Stufe und Wiederholungen; der kopierbare Bericht enthält keine Keys.
- **Ausweichmodell bei Überlastung**: Meldet ein Anbieter eine vorübergehende Störung (HTTP 429, 500, 502, 503, 504, Zeitüberschreitung), wiederholt Buddy kurz mit wachsender Pause und Jitter und weicht dann für diese eine Anfrage auf ein anderes Modell aus der Modellliste deines Keys aus (z. B. Gemini Flash → Flash-Lite). Das steht offen im Chat, deine Modellwahl bleibt unverändert. Nie bei falschem Key, fehlender Berechtigung oder leerem Guthaben. Abschaltbar unter «Modell und Denktiefe».
- **Spricht deine Sprache**: Oberfläche, Meldungen und Anweisungen an die KI folgen beim Start der Windows-Sprache (Deutsch, Englisch, Französisch; sonst englische Oberfläche, Antworten trotzdem in deiner Sprache).
- **Erkennt deine Tools**: Claude Code, Codex, Gemini CLI, Grok CLI, ChatGPT, Hugging Face und mehr werden im Hintergrund erkannt. Was nicht installiert ist, erscheint nirgends.
- **Musik-Visualizer**: Island-Balken und Bildschirmrand reagieren auf den echten Ton (WASAPI-Loopback mit Frequenzanalyse: Bass, Mitten, Höhen). Ist Spotify nur offen oder pausiert, bleibt alles ruhig. Ausgewertet wird nur auf dem PC, nichts wird aufgenommen.
- **Automatische Modellwahl**: Claude Haiku prüft jede Anfrage und wählt das günstigste passende Modell (Haiku, Sonnet oder Opus) und die Denktiefe. Einzelne Schritte einer Aufgabe können verschiedene Modelle übernehmen. Hakt es, wechselt Buddy selbst auf ein stärkeres Modell.
- **Agent mit Plan**: Mehrstufige Aufgaben plant Buddy in Schritten, prüft jedes Ergebnis und meldet nichts als erledigt, was er nicht geprüft hat.
- **Dateien ordnen**: Dateien auflisten, Duplikate finden (per SHA-256), Ordner anlegen, verschieben, in den Papierkorb legen. Nur in deinen Benutzerordnern.
- **Berechtigungen**: Niedriges Risiko läuft direkt, mittleres fragt einmal pro Aufgabe, hohes (Löschen, Admin, System, Sicherheit) jedes Mal.
- **Kosten im Griff**: Tokens, Kosten pro Anfrage, Monatshochrechnung und ein Ausgabenlimit.
- **KI-Nutzung**: Ein Dashboard, getrennt nach Abo-Nutzung (Claude Code, Codex, ChatGPT, Grok), API-Nutzung (Buddy pro Anbieter, Claude-/OpenAI-Organisation, Gemini) und lokaler Nutzung (Modell, Arbeitsspeicher). Was ein Anbieter nicht herausgibt, steht als «nicht verfügbar»; die Kopfzeile zeigt, ob die Daten live oder zwischengespeichert sind. Frag einfach «Wie viel Codex habe ich noch?».
- **Chat**: Antworten erscheinen live, mit Code-Blöcken und Kopieren-Knopf.
- **Timer**: «Stell einen Timer auf 10 Minuten». Der Countdown läuft im Island, am Ende wackelt Buddy und macht einen Ton.
- **Apps, Websites, Musik**: Rechner, Editor, Spotify öffnen; Musik pausieren, lauter oder leiser machen.
- **PC-Steuerung**: «Öffne den Editor und schreib eine Einkaufsliste». Buddy macht Bildschirmfotos und bedient Maus und Tastatur, bis die Aufgabe erledigt ist. Vorher fragt er um Erlaubnis.
- **Leuchtender Rand**: Solange Buddy nachdenkt, leuchtet der Bildschirmrand dezent weiss-grau, beim Steuern deutlich stärker. Wo Buddy klickt, erscheint eine kleine Welle.
- **Mitteilungen im Island**: Neue Windows-Mitteilungen (WhatsApp, Mail, Discord …) erscheinen kurz als Vorschau im Island.
- **Läuft gerade**: Musik aus Spotify, YouTube im Browser und anderen Apps erscheint im Island, mit Cover und Zurück / Pause / Weiter.
- **Kalender**: Über einen privaten iCal-Link (Google, Outlook, iCloud) zeigt Buddy die nächsten Termine und erinnert kurz vorher im Island. «Was steht heute an?» funktioniert auch.
- **Sprache**: Mikrofon-Knopf, eigenes Tastenkürzel oder «Hey Buddy». Buddy liest Antworten auf Wunsch vor.
- **Spielmodus**: Läuft ein Spiel oder eine Vollbild-App, versteckt sich Buddy komplett: keine Pop-ups, kein Ton, keine Steuerung. Verpasstes zeigt er danach.
- **Eigene Tastenkürzel und Kurzbefehle**: Jede Aktion bekommt ihr Kürzel, und feste Aufträge wie «Pausier die Musik» liegen auf einer Taste.
- **Mehrere Bildschirme**: Du wählst, auf welchem Bildschirm Buddy wohnt und arbeitet.
- **Selbsttest**: Ein Klick prüft API, Bildschirmfoto, Steuerung, Mitteilungen, Musik, Kalender, Sprache und Updates.

![Leuchtender Rand während der PC-Steuerung](docs/glow.png)

## Installation (einfach)

1. **Installer herunterladen**: Lade unter [Releases](../../releases) die Datei `BuddyIsland-Setup-….exe` herunter.
2. **Installieren**: Doppelklick auf die Datei. Falls Windows «Der Computer wurde durch Windows geschützt» anzeigt: «Weitere Informationen» → «Trotzdem ausführen». Das erscheint, weil die App (noch) nicht mit einem kostenpflichtigen Zertifikat signiert ist. Buddy installiert sich nur für deinen Benutzer, ohne Administratorrechte, und legt Verknüpfungen im Startmenü und auf dem Desktop an.
3. **KI einrichten**:
   - Ohne Key: Klicke oben auf das Island → «Einrichten». Buddy zeigt das empfohlene Modell und die Grösse, fragt nach und richtet Ollama und das Modell selbst ein (je nach PC etwa 2 bis 10 GB).
   - Mit Key (optional, klügere Antworten, PC-Steuerung nur mit Claude): Einstellungen → «Provider & API-Keys» → Anbieter wählen → Key einfügen → «Verbinden». Keys gibt es in der [Claude Console](https://platform.claude.com/settings/keys), bei [OpenAI](https://platform.openai.com/api-keys), in der [xAI Console](https://console.x.ai) oder im [Google AI Studio](https://aistudio.google.com/apikey). Ein Abo (Claude Pro/Max, ChatGPT Plus/Pro, Grok, Google One) enthält keinen API-Zugang. Buddy prüft einen Key beim Anbieter (kostenlose Modellliste), nicht an seinem Präfix.
   - **Gemini**: Buddy nutzt die Gemini API aus Google AI Studio, nicht Vertex AI. Google nimmt ältere Standard-Keys (meist «AIza…») seit September 2026 nicht mehr an; neue Keys aus AI Studio sind Auth Keys (meist «AQ.…»). Ein gespeicherter alter Key bleibt erhalten, Buddy zeigt aber einen Hinweis und bittet um einen neuen.
4. **Fertig**: Mit <kbd>Strg</kbd> + <kbd>Umschalt</kbd> + <kbd>Leertaste</kbd> öffnest du Buddy von überall.
5. **Selbsttest**: Einstellungen → «Über Buddy» → «Selbsttest starten» zeigt dir, ob alles funktioniert.

**Updates** lädt Buddy automatisch im Hintergrund und installiert sie beim nächsten Beenden, aber nur, wenn die Ed25519-Signatur des Releases stimmt, die SHA-512-Prüfsumme der heruntergeladenen Datei passt und die Version neuer und kompatibel ist. Startet eine neue Version mehrmals nicht sauber, kehrt Buddy automatisch zur vorherigen signierten Version zurück. In den Einstellungen unter «Über Buddy» geht das auch von Hand.

**Deinstallieren**: Windows-Einstellungen → Apps → Buddy Island → Deinstallieren.

### Optional: Kalender verbinden

- **Google Kalender**: calendar.google.com → Zahnrad → Einstellungen → links deinen Kalender wählen → ganz unten «Privatadresse im iCal-Format» kopieren.
- **Outlook**: outlook.com → Einstellungen → Kalender → Freigegebene Kalender → «Kalender veröffentlichen» → ICS-Link kopieren.
- In Buddy: Einstellungen → Kalender → Link einfügen → «Verbinden».

### Optional: Mitteilungen nur noch im Island

Damit unten rechts nichts mehr aufpoppt, schalte in Windows **«Nicht stören»** ein oder bei einzelnen Apps «Benachrichtigungsbanner anzeigen» aus. Die Mitteilungen landen trotzdem bei Buddy. Der Knopf **«Windows-Banner unten rechts ausschalten»** (Einstellungen → Mitteilungen, und beim ersten Mal direkt im Island) bringt dich genau dorthin. Du kannst Buddy auch fragen: «Bring mich zu den Banner-Einstellungen». Falls der Status «Zugriff verweigert» zeigt, erlaube unter Einstellungen → Datenschutz → Benachrichtigungen den Zugriff für Desktop-Apps.

## Selbst bauen

Voraussetzung: [Node.js](https://nodejs.org) 20 oder neuer. Für den Installer unter Linux oder macOS zusätzlich [Wine](https://www.winehq.org).

```bash
git clone https://github.com/<dein-name>/buddy-island.git
cd buddy-island
npm install
npm start          # startet Buddy direkt aus dem Code
npm test           # Tests für die Claude-Anbindung und die Werkzeuge
npm run dist:win   # baut den Installer nach dist/
npm run pack:win   # nur die entpackte Windows-App (ohne Installer)
```

### Neue Version veröffentlichen

1. Einmalig: Den privaten Signierschlüssel als Repository-Secret `BUDDY_UPDATE_SIGNING_KEY` hinterlegen (GitHub → Settings → Secrets and variables → Actions → New repository secret). Der passende öffentliche Schlüssel steht in `src/update-security.js`.
2. `version` in `package.json` erhöhen (z. B. `0.4.0`) und committen.
3. `git tag v0.4.0 && git push --tags` oder den Workflow «Release» von Hand starten.
4. GitHub Actions baut den Installer auf Windows, signiert das Update (`update-signature.json`) und hängt alles ans Release. Installierte Buddys prüfen die Signatur und aktualisieren sich dann selbst.

Fehlt das Secret, wird das Release ohne Signatur veröffentlicht, und Buddys ab 0.3 installieren es nicht automatisch. Mit dem Workflow «Release signieren» lässt sich die Signatur nachreichen.

## Bedienung

| Was | Wie |
| --- | --- |
| Buddy öffnen / schliessen | <kbd>Strg</kbd> + <kbd>Umschalt</kbd> + <kbd>Leertaste</kbd> oder Klick aufs Island |
| PC-Steuerung stoppen | Gleiches Tastenkürzel oder der Stopp-Knopf im Island |
| Neuer Chat | <kbd>Strg</kbd> + <kbd>N</kbd> |
| Einstellungen | <kbd>Strg</kbd> + <kbd>,</kbd> |
| Schliessen | <kbd>Esc</kbd> |

Alles läuft über das Island selbst: Klick drauf, oben rechts sind «Neuer Chat», «Einstellungen» und «Schliessen». Dazu gibt es ein Symbol im Infobereich der Taskleiste (Rechtsklick: Öffnen, Einstellungen, Beenden).

### Eigene Tastenkürzel

In den Einstellungen unter **Tastenkürzel** legst du fest, welche Tasten Buddy öffnen, einen neuen Chat starten, die Einstellungen öffnen oder eine laufende Aufgabe stoppen. Die Kürzel funktionieren überall in Windows.

Unter **Eigene Kurzbefehle** verbindest du ein Kürzel mit einem festen Auftrag, zum Beispiel <kbd>Strg</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd> → «Stell einen Timer auf 5 Minuten» oder <kbd>F9</kbd> → «Pausier die Musik». Buddy erledigt das im Hintergrund, auch wenn das Island geschlossen ist.

## Sicherheit und Datenschutz

Ausführlich in [PRIVACY.md](PRIVACY.md). Kurz:

- **Dein API-Key** wird mit der Windows-Verschlüsselung (DPAPI, über Electrons `safeStorage`) nur auf deinem PC gespeichert und ausschliesslich an die API des jeweiligen Anbieters geschickt (`api.anthropic.com`, `api.openai.com`, `api.x.ai`, `generativelanguage.googleapis.com`), immer im Header, nie in der Adresse. Er steht nie im Code oder in diesem Repository.
- **Keine Telemetrie**: Buddy schickt nichts an andere Server.
- **PC-Steuerung** fragt vor jeder Aufgabe um Erlaubnis (abschaltbar). Buddy ist angewiesen, keine Passwörter oder Zahlungsdaten einzugeben, nichts zu kaufen und vor dem Verschicken von Nachrichten nachzufragen. Bildschirmfotos gehen dabei an Claude. Lass Buddy deshalb nicht steuern, während sensible Dinge offen sind.
- **Mitteilungen** bleiben auf deinem PC. Claude sieht sie nur, wenn du Buddy fragst, was du verpasst hast.
- Das Island und der leuchtende Rand werden aus Buddys Bildschirmfotos ausgeblendet (ab Windows 10, Version 2004).

## Ressourcen

Im Leerlauf läuft keine einzige Endlos-Animation: Das Fenster ist dann nur so gross wie das Island, und der leuchtende Rand ist ganz geschlossen. Der Steuerungs-Helfer startet erst, wenn Buddy steuern darf, und beendet sich nach zwei Minuten ohne Aktion. CPU und GPU sind im Leerlauf praktisch bei 0 %. Der RAM-Grundbedarf liegt bei etwa 80–120 MB, weil Buddy auf Electron (Chromium) läuft.


## Lokale KI

Buddy nutzt **[Ollama](https://ollama.com)** als Laufzeit für lokale Modelle. Gründe: offizielles Windows-Programm ohne Administratorrechte, rechnet mit NVIDIA (CUDA), AMD (ROCm oder Vulkan), Intel (Vulkan) oder nur dem Prozessor, lädt quantisierte Modelle mit Prüfsumme und fortsetzbarem Download, verteilt grosse Modelle selbst auf Grafikkarte und Prozessor und bietet eine lokale Schnittstelle mit Streaming und Werkzeugaufrufen. llama.cpp direkt einzubinden hätte feinere Kontrolle gebracht, aber eigene Builds pro Grafikkarte, eigene Downloads und eigene Updates verlangt. Die Anbindung liegt hinter einer kleinen Schnittstelle (`src/local/runtime.js`), weitere Laufzeiten lassen sich dort ergänzen.

**Ablauf beim ersten Start**: Hardware erkennen → Ollama suchen (läuft es schon, z. B. als App, benutzt Buddy es mit und beendet es nie) → Empfehlung zeigen → nach Bestätigung Ollama installieren und das Modell laden → kurz testen → Chat.

**Empfehlung**: Der Katalog (`src/local/models.json`) nennt Kandidaten (Qwen, Gemma, Ministral, Llama, gpt-oss, DeepSeek-R1, Mistral Small). Ob es ein Modell wirklich gibt und wie gross es ist, fragt Buddy direkt bei der Ollama-Registry; nicht bestätigte Modelle erscheinen nicht. Der Katalog wird zusätzlich aus diesem Repo nachgeladen (höchstens einmal pro Tag, streng geprüft), damit Empfehlungen ohne neue Version aktuell bleiben. Der Speicherbedarf rechnet Modellgewichte + Kontextspeicher + Laufzeit-Puffer und lässt Reserve für Windows; die Kontextlänge richtet sich nach dem freien Speicher. Tempo nur als grobe Stufe.

**Ehrlichkeit**: Ob die Grafikkarte wirklich rechnet, liest Buddy nach dem Laden aus Ollama (`/api/ps`, Anteil im Grafikspeicher) und zeigt «Grafikkarte», «teils Grafikkarte» oder «Prozessor». Wird ein Gespräch zu lang, fasst das Modell den älteren Teil zusammen und Buddy sagt das im Chat.

**Tests**: `test/local.test.js` (nachgebauter Ollama-Server, Hardware-Profile für NVIDIA, AMD, Intel, integriert, nur Prozessor, mehrere Grafikkarten, wenig Speicher). Der echte Durchlauf mit Ollama läuft auf Windows in GitHub Actions (`.github/workflows/local-ai.yml`, Ergebnisse als Artefakt) oder lokal mit `npm run test:ollama`.

## Wie es funktioniert

| Datei | Aufgabe |
| --- | --- |
| `src/main.js` | Fenster, Tastenkürzel, Updates, Verbindung der Teile |
| `src/llm/` | Anbieter-Schnittstelle (`types.d.ts`), Adapter mit dem jeweils eigenen Protokoll: Claude (Messages API, Version 2026-10-21, `Authorization: Bearer`), OpenAI (Responses API mit verschlüsselten Denk-Items), xAI (Chat Completions), Gemini (nativ `generateContent` mit `thoughtSignature`, Key im Header `x-goog-api-key`), lokal (Ollama, Colibrì, Transformers); Anmeldung pro Anbieter (`auth.js`: Anleitung, Formatprüfung ohne Präfix-Zwang, Fehlerdeutung); gemeinsame Fehlerklassen mit Backoff (`errors.js`), Ausweichmodelle (`fallback.js`) und Verbindungstest (`health.js`) |
| `src/claude.js` | Claude Messages API (Streaming, Prompt-Caching, Wiederholungen, Zeitlimits) |
| `src/discovery.js` | Erkennt installierte KI-Tools und Laufzeiten |
| `src/local/` | Lokale KI: Hardware-Erkennung (`hardware.js`), Modellkatalog, Speicherabschätzung und Empfehlung (`catalog.js`, `models.json`), Ollama-Anbindung (`ollama.js`), Laufzeit-Schnittstelle (`runtime.js`), Ablauf und Zustand (`manager.js`) |
| `src/llm/local.js` | Chat-Adapter für lokale Modelle: Streaming, Werkzeuge nur bei fähigen Modellen, Kontext-Zusammenfassung |
| `src/system-specs.js` | Hardware und Empfehlung der älteren Hugging-Face-Laufzeit |
| `src/audio-meter.js` | Audio-Analyse (Loopback, FFT, Bänder) für Visualizer und Rand |
| `src/i18n/` | Sprachen (Deutsch als Quelle, Englisch, Französisch) |
| `src/models.js` | Anbieter, Modelle, Preise, Denktiefe |
| `src/router.js` | Modellwahl: Regeln für Einfaches, sonst Haiku als Dispatcher, Budget |
| `src/agent.js` | Ausführung: Plan, Modell pro Schritt, Eskalation, Prüfung, Freigaben |
| `src/permissions.js` | Risikostufen und Freigaben |
| `src/files.js` | Datei-Werkzeuge (nur Benutzerordner, Löschen in den Papierkorb) |
| `src/usage.js`, `src/history.js` | Kostenstatistik und Ausführungsverlauf |
| `src/ai-usage.js` | KI-Nutzung: Buddy, Claude API, Claude Code, Codex, ChatGPT, Grok |
| `src/update-security.js` | Signatur- und Kompatibilitätsprüfung für Updates |
| `src/tools.js` | Timer, Apps, Websites, Medientasten, Mitteilungen lesen |
| `src/computer.js` | Bildschirmfotos und Maus/Tastatur über Windows `SendInput` (kleiner PowerShell-Helfer) |
| `src/notifications.js` | System-Helfer: Windows-Mitteilungen, «Läuft gerade» und Spielmodus |
| `src/calendar.js` | Liest iCal-Kalender inkl. Wiederholungen und Zeitzonen |
| `src/voice.js` | «Hey Buddy» und Diktat über die Windows-Spracherkennung |
| `src/renderer/` | Das Island selbst (HTML, CSS, JS) |
| `src/glow/` | Der leuchtende Bildschirmrand |

## Bekannte Grenzen

- Nur Windows 10/11.
- Der Installer ist nicht signiert, deshalb die SmartScreen-Warnung beim ersten Start.
- Spiele mit Anti-Cheat (z. B. Valorant) blockieren simulierte Eingaben, solange sie im Vordergrund laufen.
- «Hey Buddy» braucht eine installierte Windows-Spracherkennung (Einstellungen → Zeit und Sprache → Sprache).
- Fenster mit Administratorrechten (z. B. der Task-Manager) kann Windows für Buddy sperren.
- Die PC-Steuerung kostet mehr API-Guthaben als ein normaler Chat, weil Bildschirmfotos mitgeschickt werden. Buddy entfernt ältere Bildschirmfotos aus dem Verlauf, um zu sparen.
- Abo-Limits von Claude (Pro/Max), ChatGPT und Grok geben die Anbieter über keine offizielle Schnittstelle heraus. Buddy zeigt sie darum als «nicht verfügbar». Codex schreibt seine Limits in die eigenen Protokolle, die zeigt Buddy (Stand der letzten Codex-Nutzung).
- Claude Code und Codex in WSL legen ihre Protokolle im Linux-Teil ab, dort liest Buddy nicht.
- Kosten sind Schätzungen aus Token-Zahlen und Listenpreisen. Massgebend ist die Abrechnung beim Anbieter. Die Preise von OpenAI, xAI und Google sind Schätzungen (Stand Oktober 2026).
- PC-Steuerung gibt es nur mit Claude. Lokale Modelle können Buddys einfache Werkzeuge (Timer, Apps, Musik …) nutzen, wenn Ollama das für das Modell meldet; riskante Aktionen sind für lokale Modelle standardmässig gesperrt.
- Lokale Modelle auf dem Prozessor sind deutlich langsamer als auf einer Grafikkarte. Tempo-Angaben sind grobe Stufen, unter «Diagnose» lässt es sich messen.
- Die automatische Installation von Ollama gibt es nur unter Windows; auf anderen Systemen bitte selbst installieren.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Gebaut von Wolf Widmer.
