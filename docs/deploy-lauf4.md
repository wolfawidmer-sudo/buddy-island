# Buddy Live (Lauf 4): Backend deployen und echt testen

Stand 20.11.2026. Branch `buddy-live`. Nichts davon ist live.

## Was im Backend neu ist

- `POST /v1/cloud/realtime/sessions` (Anmeldung wie beim Chat): prüft Preis, Guthaben und laufende Gespräche, reserviert den ersten Abschnitt Credits und gibt ein Ticket zurück (60 s, einmalig).
- `GET /v1/cloud/realtime` als WebSocket (Subprotokolle `buddy-live.v1` und `ticket.<Ticket>`): Relay zur OpenAI Realtime API. Der OpenAI-Key bleibt im Backend.
- Abrechnung laufend aus `response.done.usage` in Abschnitten (`bl_<Gespräch>_<n>`), Eintrag «Buddy Live» im Verlauf.
- Keine Schema-Migration. Neue Preiszeile als Vorlage: `supabase/seed/realtime-pricing.template.sql`.
- Kein neues npm-Paket (eigener kleiner WebSocket-Server in `backend/src/lib/websocket.js`, Verbindung zu OpenAI über den eingebauten WebSocket von Node 22).

## Schritte

1. **Preise prüfen:** https://developers.openai.com/api/docs/pricing öffnen, Abschnitt Realtime. Die Zahlen in `supabase/seed/realtime-pricing.template.sql` vergleichen und bei Abweichung anpassen.
2. **Preiszeile eintragen:** Supabase → Projekt «buddy-island» → SQL Editor → Inhalt der Vorlage einfügen → Run. Ohne diese Zeile antwortet das Backend mit «nicht eingerichtet» und die App nimmt wie bisher das Diktat.
3. **Railway-Variablen** (alle optional, Standard in Klammern), Service «buddy-island» → Variables:
   - `REALTIME_MODEL` (gpt-realtime-2.1). Günstiger: `gpt-realtime-2.1-mini`, dann auch dafür eine Preiszeile.
   - `REALTIME_MAX_SECONDS` (900), `REALTIME_IDLE_SECONDS` (90), `REALTIME_MAX_SESSIONS` (40), `REALTIME_MAX_OUTPUT_TOKENS` (1024).
4. **Deployen:** PR `buddy-live` → `main` mergen, danach `main` → `buddy-cloud` wie bei PR #9 (Merge auf buddy-cloud = Live-Deploy).
5. **Prüfen:** https://api.buddy-island.top/health muss `ok: true` zeigen.

Hinweis Railway: WebSockets laufen über die normale Domain (kein Extra-Schalter). Railway trennt Verbindungen nach längerer Zeit ohne Daten; die App schickt laufend Ton, das Backend alle 5 s ein Ping.

## Echter Test (kostet wenig echtes Geld)

1. Testversion bauen: Tag `test-live-1` auf den Branch `buddy-live` setzen, dann GitHub → Actions → «Testversion» → Run workflow (Branch `buddy-live`).
2. Installieren, anmelden (Konto mit ein paar Credits).
3. Einstellungen → Funktionen → «Wakeword» an, darunter «Buddy Live nach dem Wakeword» an, Stimme wählen.
4. «Hey Buddy» sagen. Das Island zeigt aufmerksame Augen und Balken.
5. Ausprobieren:
   - «Wie spät ist es?» und Buddy mitten im Satz unterbrechen.
   - «Stell einen Timer auf zwei Minuten.»
   - «Mach Spotify leiser.» (Freigabe im Island klicken, falls gefragt)
   - «Danke Buddy, tschüss.» → Gespräch endet.
   - Nochmals starten und 8 s nichts sagen → endet von selbst.
   - Stopp-Knopf im Island und Tastenkürzel (Esc oder das Buddy-Kürzel) beenden ebenfalls.
6. Konto → Verlauf: Eintrag «Buddy Live» mit den Kosten des Gesprächs.
7. Bei Problemen: Einstellungen → System → Logs (Zeilen mit «Live:»).

Kosten grob (gpt-realtime-2.1 + 25 %): etwa 5–15 Credits pro Minute Gespräch, je nachdem wie viel Buddy spricht. Echt nicht gemessen.
