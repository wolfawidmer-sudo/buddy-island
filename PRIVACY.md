# Datenschutz bei Buddy Island

Stand: November 2026

Buddy Island ist ein privates Testprojekt von Wolf Widmer. Die App läuft vollständig auf deinem Windows-PC. Es gibt keine Server von Buddy Island, kein Konto, keine Werbung und keine Statistiken.

## Lokale KI

Ohne API-Key läuft Buddy mit einem **lokalen Modell** (Hugging Face Transformers) auf deinem PC. Dann verlässt nichts von deinen Eingaben den PC. Nur beim Einrichten lädt Buddy Python (python.org bzw. Microsoft Store), Pakete (PyPI) und das Modell (Hugging Face) herunter. Für die Empfehlung liest Buddy Arbeitsspeicher, Prozessor und Grafikkarte aus, nur lokal.

## Was an den gewählten KI-Anbieter geht

Mit Claude (Anthropic), OpenAI, Grok (xAI) oder Gemini (Google) benutzt Buddy dessen API mit **deinem eigenen API-Key**. Jeder Key geht nur an seinen Anbieter. An ihn gehen nur:

- was du Buddy schreibst oder sagst, und seine Antworten,
- Ergebnisse der Werkzeuge, die Buddy für deine Anfrage benutzt (zum Beispiel «Timer gestellt», deine Termine oder Mitteilungen, aber nur wenn du danach fragst),
- bei der **PC-Steuerung** (nur mit Claude) Bildschirmfotos deines Bildschirms. Buddy fragt vorher um Erlaubnis. Lass ihn nicht steuern, während Passwörter oder Privates offen sind.

Wie der Anbieter diese Daten behandelt, steht in seiner Datenschutzerklärung für die API.

## Was nur auf deinem PC bleibt

- Deine **API-Keys**, ein optionaler **Hugging-Face-Token**, optionale **Admin-Keys** (Anthropic, OpenAI) und dein **Kalender-Link**: mit der Windows-Verschlüsselung (DPAPI) gespeichert, nie im Protokoll. Jeder Key geht nur an den eigenen Anbieter.
- **Kostenstatistik** (`usage.json`): nur Zahlen (Tokens, Kosten, Modell, Zeit), keine Inhalte.
- **Ausführungsverlauf** (`history.json`): kurzer Titel der Aufgabe, Schritte, Modelle und Kosten, keine Antworten. Abschaltbar und löschbar in den Einstellungen.
- **Chatverlauf**, **Einstellungen** und ein kurzes **Protokoll** für die Fehlersuche (ohne Chat-Inhalte) im Ordner `%APPDATA%\Buddy Island`.
- **Windows-Mitteilungen**, **«Läuft gerade»** (Musik) und **Termine**: Buddy liest sie nur, um sie im Island zu zeigen. Sie werden nicht dauerhaft gespeichert.
- **Spielmodus**: Buddy schaut nur, welches Programm im Vordergrund ist und ob Windows «Vollbild» meldet.

## KI-Nutzung

- Die Nutzungs-Ansicht liest auf Wunsch die **Protokolldateien von Claude Code und Codex** auf deinem PC (`.claude\projects`, `.codex\sessions`). Buddy zählt daraus Tokens, Werkzeuge und Fehler und zeigt den ersten Auftrag einer Sitzung als Titel. Die Dateien werden nur gelesen, nie verändert oder verschickt. Abschaltbar unter «Lokale Protokolle lesen».
- Für «Was läuft gerade?» schaut Buddy kurz in die **Liste der laufenden Programme**, um bekannte KI-Programme zu erkennen. Davon wird nichts gespeichert.
- Fragst du Buddy im Chat nach deiner Nutzung, geht die Zusammenfassung (inkl. der Sitzungstitel) an Claude, damit er antworten kann.
- Mit einem Admin-Key fragt Buddy die offiziellen Usage- und Cost-Schnittstellen von Anthropic bzw. OpenAI ab.

## Erkennung und Visualizer

- Buddy prüft, ob Programme wie Claude Code, Codex oder Python installiert sind (Pfade und Versionen, keine Inhalte).
- Für den Musik-Visualizer und den Bildschirmrand wertet Buddy den Ton aus, den Windows gerade abspielt (Lautstärke in Bass, Mitten und Höhen), und zwar nur, solange Windows eine Wiedergabe meldet. Das passiert ausschliesslich auf dem PC: Es wird nichts aufgenommen, gespeichert oder verschickt.

## Sprache

- «Hey Buddy» wird mit der eingebauten Windows-Spracherkennung **auf dem PC** erkannt.
- Für das Diktat nutzt Buddy die Spracherkennung von Windows. Ist in Windows die **Online-Spracherkennung** eingeschaltet, verarbeitet Microsoft das Gesprochene. Sonst bleibt alles auf dem PC.
- Vorlesen läuft mit den Windows-Stimmen auf dem PC.

## Kalender

Buddy lädt deinen privaten iCal-Link direkt bei deinem Kalenderanbieter (z. B. Google oder Microsoft), etwa alle 15 Minuten.

## Updates

Buddy fragt bei GitHub nach neuen Versionen und lädt sie über HTTPS. Installiert wird nur, wenn die Signatur und die Prüfsumme stimmen. Dabei werden keine Daten über dich verschickt.

## Löschen

Deinstalliere Buddy über die Windows-Einstellungen und lösche den Ordner `%APPDATA%\Buddy Island`. Danach ist nichts mehr von Buddy auf deinem PC.
