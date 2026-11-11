# Datenschutz bei Buddy Island

Stand: 9. November 2026 (ab Version 0.13)

Buddy Island ist ein Projekt von Wolf Widmer, Grabenpromenade 1, 3011 Bern (contact@buddy-island.top). Die vollständige Datenschutzerklärung steht auf https://buddy-island.top/privacy.html. Kurz:

Die App läuft auf deinem Windows-PC. Die Antworten kommen über **Buddy Cloud**, dafür brauchst du ein Konto. Werbung und Statistiken gibt es nie.

## Buddy Cloud

- **Konto:** E-Mail-Adresse, Passwort (nur verschlüsselt gespeichert), optional Name. Bei «Mit Google anmelden» zusätzlich Name, E-Mail und Profilbild-Adresse von Google.
- **Guthaben und Käufe:** Buddy Credits, Käufe, Abo-Status. Kartendaten verarbeitet nur Stripe.
- **Nutzung:** pro Anfrage Zeitpunkt, Modell, Tokens und Credits. Keine Inhalte.
- **Inhalte:** Was du Buddy schreibst oder sagst, und Ergebnisse der Werkzeuge (z. B. Termine oder Mitteilungen, nur wenn du danach fragst), gehen über den Buddy-Cloud-Server an OpenAI und die Antwort zurück. Der Server speichert die Inhalte nicht; OpenAI wird gebeten, sie nicht zu speichern (`store: false`).
- **Dienstleister:** Supabase (Zürich), Railway (Niederlande), OpenAI (USA), Stripe (Bezahlung, als Wiederverkäufer), Resend (E-Mails), Google (nur bei Google-Anmeldung).
- Deine Anmeldung speichert Buddy auf dem PC mit der Windows-Verschlüsselung (DPAPI). Die Oberfläche sieht nie Tokens.

## Was nur auf deinem PC bleibt

- **Kalender-Link** (verschlüsselt mit DPAPI), **Chatverlauf**, **Gedächtnis**, **Einstellungen** und ein kurzes **Protokoll** ohne Chat-Inhalte im Ordner `%APPDATA%\Buddy Island`.
- **Ausführungsverlauf** (`history.json`): Titel, Schritte, Modelle, keine Antworten. Abschaltbar und löschbar.
- **Windows-Mitteilungen**, **«Läuft gerade»** und **Termine** werden nur angezeigt, nicht dauerhaft gespeichert.
- **Spielmodus** und **Musik-Visualizer** werten nur lokal aus (Vordergrund-Programm, Lautstärke des Systemtons). Nichts wird aufgenommen oder verschickt.
- Mit früheren Versionen gespeicherte API-Keys, Admin-Keys und der Hugging-Face-Token werden ab 0.13 beim Start gelöscht.

## Sprache

Das Wakeword («Hey Buddy» oder ein eigenes) wird nur auf dem PC erkannt, mit Vosk (Apache 2.0). Dafür lädt Buddy beim ersten Einschalten einmal die Vosk-Laufzeit von files.pythonhosted.org und ein Sprachmodell von alphacephei.com (beide mit fester Prüfsumme); diese Server sehen dabei nur deine IP-Adresse. Beim Wakeword geht kein Ton aus dem PC. Das Sprachmodell richtet sich nach der Sprache, in der Buddy antwortet (Deutsch, Englisch, Französisch, Spanisch, Italienisch, Portugiesisch oder Niederländisch).

**Diktat über Buddy Cloud** (Einstellung «Diktat über Buddy Cloud», an, wenn du angemeldet bist): Nach dem Wakeword oder dem Mikrofon-Knopf nimmt Buddy auf, bis du eine Pause machst (höchstens 30 Sekunden), und schickt die Aufnahme verschlüsselt über buddy-island.top an OpenAI zur Umwandlung in Text. Die Aufnahme wird weder bei Buddy Cloud noch in der App gespeichert; gespeichert wird nur der Verbrauch (Länge, Kosten) für die Abrechnung in Buddy Credits. OpenAI verarbeitet die Daten nach den Bedingungen der OpenAI-API. Ist die Einstellung aus, bist du nicht angemeldet, ohne Guthaben oder offline, nutzt Buddy wie bisher die Spracherkennung auf dem PC: Vosk oder die Spracherkennung von Windows (ist dort die Online-Erkennung an, verarbeitet Microsoft das Gesprochene). Vorlesen läuft mit den Windows-Stimmen.

## Kalender

Buddy lädt deinen privaten iCal-Link direkt beim Kalenderanbieter, etwa alle 15 Minuten.

## Updates

Buddy fragt bei GitHub nach neuen Versionen und installiert sie nur mit gültiger Signatur und Prüfsumme. Dabei werden keine Daten über dich verschickt.

## Löschen

Konto löschen: E-Mail an contact@buddy-island.top. Auf dem PC: Buddy deinstallieren und `%APPDATA%\Buddy Island` löschen. Früher eingerichtete Programme wie Ollama oder Colibrì sind eigene Programme und bleiben, bis du sie entfernst.
