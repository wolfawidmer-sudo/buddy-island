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

## Auf Windows geprüft (Workflow «Store-Paket», windows-latest)
- Paket baut, Manifest gültig, installiert (mit Wegwerf-Zertifikat signierte Testkopie), Buddy startet im Paket.
- Autostart: Buddy schaltet die StartupTask beim Start selbst ein; Ein/Aus im Paket-Kontext funktioniert.
- Windows App Certification Kit: Gesamtergebnis PASS. «Blocked executables» meldet FAIL, weil WACK in allen
  Dateien nach Wörtern wie «cmd», «reg», «bash» sucht (auch in Chromiums Sprachdateien). Das trifft jede
  Electron-App und blockiert die Einreichung nicht; Buddy startet PowerShell für seine Helfer (Lautstärke,
  Mitteilungen, Sprache) – das in den Prüfer-Hinweisen erwähnen, falls Microsoft nachfragt.

## Nicht auf echtem Windows geprüft
- Windows-Mitteilungen und Medien-Steuerung im Paket.
- Vosk aus dem Paketordner (WindowsApps ist schreibgeschützt; libvosk wird nur gelesen).
- Google-Anmeldung (lokaler Rückruf auf 127.0.0.1) im Paket.

## Texte für den Store-Eintrag (Partner Center › Store listings)

### Deutsch
**Beschreibung**
Buddy Island ist dein Assistent oben in der Mitte des Bildschirms. Ein kleines schwarzes Island, das sich öffnet, wenn du es brauchst, und sonst ruhig bleibt.

Frag Buddy etwas, stell einen Timer, öffne Apps und Websites, steuere deine Musik oder lass dir sagen, was heute im Kalender steht. Windows-Mitteilungen erscheinen kurz im Island. Läuft ein Spiel oder ein Vollbild, hält Buddy sich zurück.

Buddy antwortet mit KI über Buddy Cloud. Du meldest dich mit Google oder E-Mail an und lädst Guthaben auf (ab 5 USD) oder nimmst Buddy Plus. Bezahlt wird über Stripe.

Diese App verwendet generative KI. Antworten können falsch oder unpassend sein. Unter jeder Antwort kannst du sie mit «Melden» an uns schicken.

**Funktionen (je eine Zeile)**
- Chat mit KI direkt oben am Bildschirm
- Timer mit Countdown im Island
- Apps und Websites per Befehl öffnen
- Musik steuern mit Cover
- Kalender mit Erinnerungen vor Terminen
- Windows-Mitteilungen im Island
- Eigenes Wakeword und Vorlesen
- Spielmodus: zurückhaltend bei Spielen und Vollbild
- Hell und Dunkel, eigene Akzentfarbe, eigene Tastenkürzel

### English
**Description**
Buddy Island is your assistant at the top center of your screen. A small black island that opens when you need it and stays out of the way otherwise.

Ask Buddy anything, set a timer, open apps and websites, control your music or check what's on your calendar today. Windows notifications show up briefly in the island. When a game or full-screen app is running, Buddy holds back.

Buddy answers with AI through Buddy Cloud. Sign in with Google or email and top up credits (from USD 5) or get Buddy Plus. Payments are handled by Stripe.

This app uses generative AI. Responses can be wrong or inappropriate. You can report any response with «Report» below it.

### Français
**Description**
Buddy Island est ton assistant en haut au centre de l'écran. Une petite île noire qui s'ouvre quand tu en as besoin et reste discrète le reste du temps.

Pose une question à Buddy, lance un minuteur, ouvre des applis et des sites, contrôle ta musique ou regarde ce qui t'attend aujourd'hui dans ton agenda. Les notifications Windows apparaissent brièvement dans l'île. Pendant un jeu ou en plein écran, Buddy se fait discret.

Buddy répond grâce à l'IA via Buddy Cloud. Connecte-toi avec Google ou un e-mail et recharge des crédits (dès 5 USD) ou prends Buddy Plus. Le paiement passe par Stripe.

Cette app utilise l'IA générative. Les réponses peuvent être fausses ou inappropriées. Tu peux signaler une réponse avec «Signaler» en dessous.

## Hinweise für die Prüfer (Submission › Notes for certification)
Englisch, weil die Prüfer international sind. Vorher ein Testkonto mit Guthaben anlegen (z. B. 500 BC von Hand gutschreiben), Zugangsdaten nur hier eintragen, nie ins Repo.

> Buddy Island is an AI assistant that lives at the top center of the screen. After install it starts in the tray and shows a small black "island" at the top of the primary display; click it or press Ctrl+Shift+Space to open it.
> AI responses need a Buddy Cloud account with credits. Test account: <E-MAIL> / <PASSWORT> (credits are preloaded, no purchase needed). Sign in under the person icon → "Sign in with email".
> Purchases of credits and the Buddy Plus subscription use Stripe Checkout in the browser (third-party payment for a non-game app, policy 10.8.1). No card data is entered inside the app.
> Optional features that are off by default: wake word (microphone, on-device recognition with Vosk), Windows notifications in the island (requires the user to allow notification access).
> The app starts PowerShell helper scripts bundled in the package for volume, media and notification display and on-device speech; it does not download or run other code.
> Every AI response has a "Report" button that opens an e-mail draft to contact@buddy-island.top (policy 11.16).

## Bevor du einreichst
- [ ] Repo-Variablen STORE_* gesetzt, Workflow «Store-Paket» grün, .appx aus «BuddyIsland-Store» genommen (nicht die Testkopie)
- [ ] Datenschutz-Ergänzung live (Website-Branch `microsoft-store` → main)
- [ ] Testkonto mit Guthaben für die Prüfer
- [ ] Screenshots (mindestens 1366×768): Chat, Einstellungen, Island geschlossen
- [ ] Bei «Live generative AI» und «Third-party payment» das Häkchen gesetzt
