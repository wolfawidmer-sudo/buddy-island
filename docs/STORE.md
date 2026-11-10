# Buddy Island im Microsoft Store

## Was die Store-Version anders macht
| Thema | Installer von der Website | Store-Paket (MSIX/AppX) |
|---|---|---|
| Signatur | nicht code-signiert (SmartScreen-Warnung) | signiert Partner Center beim Einreichen |
| Updates | eigener Updater mit Ed25519-Signatur und Rollback | nur über den Store; eigener Updater und Rollback aus |
| Autostart | Registry (`setLoginItemSettings`) | StartupTask `BuddyIslandStartup` im Manifest, aus bis der Nutzer ihn einschaltet |
| Verknüpfungen | legt der Installer an | legt Windows an |
| Vosk-Laufzeit (libvosk.dll) | wird beim Einschalten geladen | liegt im Paket; geladen werden nur Sprachmodelle (Daten) |
| «Melden» unter KI-Antworten | ja | ja (Richtlinie 11.16) |

Erkennung im Code: `process.windowsStore` (src/store.js). Paket-Konfiguration: `electron-builder.store.js`,
Manifest-Zusatz: `build/appx-extensions.xml`, Kachelbilder: `assets/appx/`.

## Paket bauen
1. Partner Center › Apps and games › Buddy Island › **Product management › Product identity**: drei Werte abschreiben.
2. GitHub › buddy-island › Settings › Secrets and variables › Actions › **Variables**: anlegen
   `STORE_IDENTITY_NAME`, `STORE_PUBLISHER` (beginnt mit `CN=`), `STORE_PUBLISHER_NAME`.
3. Actions › **Store-Paket** › Run workflow (Branch wählen). Ergebnis: `BuddyIsland-Store-<version>.appx` unter Artifacts.
4. Partner Center › Submission › **Packages**: die .appx hochladen.

Der Workflow veröffentlicht nichts und löst kein Auto-Update bei bestehenden Nutzern aus.

## Angaben in Partner Center
- **Pricing:** Free. Bezahlt wird Buddy Cloud in der App über Stripe → bei «In-app purchases» die Nutzung einer Drittanbieter-Bezahlung ankreuzen (Richtlinie 10.8.1/10.8.2).
- **Live generative AI:** ankreuzen und in der Beschreibung erwähnen (Richtlinie 11.16), z. B.
  «Buddy antwortet mit KI (OpenAI über Buddy Cloud). Unpassende Antworten kannst du direkt im Chat melden.»
- **Privacy policy URL:** https://buddy-island.top/privacy.html
- **Support:** contact@buddy-island.top
- **Altersfreigabe:** IARC-Fragebogen; Chat mit KI und Kauf digitaler Güter wahrheitsgemäss angeben.
- **Capabilities, die Microsoft erklärt haben will:** `runFullTrust` (Electron-Desktop-App), `microphone`
  (Sprache und Wakeword, nur wenn eingeschaltet), `userNotificationListener` (Windows-Mitteilungen im Island, nur wenn eingeschaltet).
- **Screenshots:** mindestens einer, 1366×768 oder grösser.

## Nicht auf echtem Windows geprüft
- Autostart über die StartupTask (PowerShell-Kindprozess mit Paket-Identität).
- Windows-Mitteilungen und Medien-Steuerung im Paket.
- Vosk aus dem Paketordner (WindowsApps ist schreibgeschützt; libvosk wird nur gelesen).
- Google-Anmeldung (lokaler Rückruf auf 127.0.0.1) im Paket.
- Windows App Certification Kit (WACK) wurde noch nicht laufen gelassen.
