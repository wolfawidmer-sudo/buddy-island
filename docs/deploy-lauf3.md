# Deploy Lauf 3: PC-Steuerung und Befehle (Branch `steuerung-pc-terminal`)

Die App braucht für die PC-Steuerung **keine** neue Backend-Funktion: Bildschirmfotos und das Werkzeug «computer» laufen über den bestehenden Weg `POST /v1/cloud/responses` und werden wie jede Anfrage in Buddy Credits abgerechnet (OpenAI-Kosten + 25 %, Preise aus `model_pricing`). Das Backend wird in diesem Branch nur **strenger**:

- Nur Werkzeuge vom Typ `function` (eingebaute OpenAI-Werkzeuge wie `web_search` oder `computer` kosten ausserhalb der Token-Nutzung und würden an der Abrechnung vorbeilaufen).
- Höchstens 12 Bilder pro Anfrage (Variable `CLOUD_MAX_INPUT_IMAGES`, Standard 12).

Keine Supabase-Migration, keine Stripe-Änderung.

## Schritte (wenn Du bereit bist)

1. Prüfen, dass PR #4 (`sicherheit-backend`) und die Diktat-Änderungen aus Lauf 1 schon auf `buddy-cloud` sind oder zusammen mitkommen.
2. Auf GitHub: **Pull requests › New pull request**, base `buddy-cloud`, compare `steuerung-pc-terminal`. Nur die Dateien unter `backend/` sind fürs Backend wichtig.
3. Mergen. Railway deployt `buddy-cloud` automatisch (Service «buddy-island», Root `/backend`).
4. Optional in Railway › Service «buddy-island» › **Variables**: `CLOUD_MAX_INPUT_IMAGES` setzen (sonst 12).
5. Kontrolle: https://api.buddy-island.top/health zeigt «ok».

Achtung: Die App in diesem Branch funktioniert auch mit dem **alten** Backend (dort ist nur die neue Grenze noch nicht aktiv).

## Testversion der App

1. Tag `test-pc-terminal-1` auf den Branch setzen (GitHub › Releases › Draft a new release › Tag eintragen, Ziel `steuerung-pc-terminal`, **nicht veröffentlichen**) oder lokal `git tag test-pc-terminal-1 && git push origin test-pc-terminal-1`.
2. GitHub › Actions › Workflow **«Testversion»** › Run workflow, Branch `steuerung-pc-terminal`.
3. Installer aus dem Workflow-Lauf (Artifacts) laden und installieren.
