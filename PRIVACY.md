# Datenschutz bei Buddy Island

Stand: November 2026

Buddy Island ist ein privates Testprojekt von Wolf Widmer. Die App läuft vollständig auf deinem Windows-PC. Es gibt keine Server von Buddy Island, kein Konto, keine Werbung und keine Statistiken.

## Was an Claude (Anthropic) geht

Buddy benutzt die Claude-API mit **deinem eigenen API-Key**. An Anthropic gehen nur:

- was du Buddy schreibst oder sagst, und seine Antworten,
- Ergebnisse der Werkzeuge, die Buddy für deine Anfrage benutzt (zum Beispiel «Timer gestellt», deine Termine oder Mitteilungen, aber nur wenn du danach fragst),
- bei der **PC-Steuerung** Bildschirmfotos deines Bildschirms. Buddy fragt vorher um Erlaubnis. Lass ihn nicht steuern, während Passwörter oder Privates offen sind.

Wie Anthropic diese Daten behandelt, steht in der Datenschutzerklärung von Anthropic für die API.

## Was nur auf deinem PC bleibt

- Dein **API-Key** und dein **Kalender-Link**: mit der Windows-Verschlüsselung (DPAPI) gespeichert.
- **Chatverlauf**, **Einstellungen** und ein kurzes **Protokoll** für die Fehlersuche (ohne Chat-Inhalte) im Ordner `%APPDATA%\Buddy Island`.
- **Windows-Mitteilungen**, **«Läuft gerade»** (Musik) und **Termine**: Buddy liest sie nur, um sie im Island zu zeigen. Sie werden nicht dauerhaft gespeichert.
- **Spielmodus**: Buddy schaut nur, welches Programm im Vordergrund ist und ob Windows «Vollbild» meldet.

## Sprache

- «Hey Buddy» wird mit der eingebauten Windows-Spracherkennung **auf dem PC** erkannt.
- Für das Diktat nutzt Buddy die Spracherkennung von Windows. Ist in Windows die **Online-Spracherkennung** eingeschaltet, verarbeitet Microsoft das Gesprochene. Sonst bleibt alles auf dem PC.
- Vorlesen läuft mit den Windows-Stimmen auf dem PC.

## Kalender

Buddy lädt deinen privaten iCal-Link direkt bei deinem Kalenderanbieter (z. B. Google oder Microsoft), etwa alle 15 Minuten.

## Updates

Buddy fragt bei GitHub nach neuen Versionen, sobald das Repository öffentlich ist. Dabei wird nur die Versionsdatei abgerufen.

## Löschen

Deinstalliere Buddy über die Windows-Einstellungen und lösche den Ordner `%APPDATA%\Buddy Island`. Danach ist nichts mehr von Buddy auf deinem PC.
