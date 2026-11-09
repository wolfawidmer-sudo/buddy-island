# Buddy Island Cloud

Buddy hat zwei unabhängige Betriebsarten:

| | Buddy Island Local | Buddy Island Cloud |
|---|---|---|
| KI | Ollama / Colibrì auf dem eigenen PC | OpenAI über das Buddy-Backend |
| Konto | keins | Buddy-Konto (E-Mail oder Google) |
| Kosten | gratis | Buddy Credits (BC), Prepaid |
| Offline | ja | nein |

Die lokale KI und eigene API-Keys funktionieren unverändert, auch ohne Konto und wenn das Backend nicht erreichbar ist.

## Architektur

```
Electron-App ──HTTPS──▶ Backend (Railway, Node, ohne Fremdpakete) ──▶ OpenAI Responses API
   │  Hauptprozess: Tokens (safeStorage)      │
   │  Renderer: nur Status, nie Tokens        ├──▶ Supabase Auth (GoTrue) + Postgres (RPC)
   │                                          └──▶ Stripe (Checkout, Webhooks)
   └── System-Browser ─▶ Google (Loopback 127.0.0.1, PKCE)
```

- **App:** `src/cloud/account.js` (Konto, Sitzung, Erneuern), `src/cloud/google-oauth.js` (Loopback-Login), `src/cloud/config.js` (Backend-Adresse). Anbieter «Buddy Cloud» (`buddy`) in `src/models.js` nutzt den bestehenden OpenAI-Responses-Adapter; nur Adresse und Anmeldung sind anders. Agent, Router und Werkzeuge bleiben gleich.
- **Backend:** `backend/` – siehe Endpunkte unten.
- **Datenbank:** `supabase/migrations/` (Tabellen, RLS, atomare Wallet-Funktionen).

## Google-Anmeldung (Desktop-Client)

Der vorhandene Client vom Typ **Desktop app** wird weiterverwendet. Kein neuer Client nötig.

1. App erzeugt `state`, PKCE-Verifier und `nonce`, startet einen Loopback-Server auf `127.0.0.1:<zufälliger Port>` und öffnet den System-Browser.
2. Google leitet auf `http://127.0.0.1:<Port>/callback` zurück. Die App prüft `state` (konstante Zeit), nimmt genau einen Rückruf an und schliesst den Server.
3. Die App schickt `code`, `code_verifier`, `redirect_uri`, `nonce` ans Backend.
4. Das Backend tauscht den Code bei Google (mit dem Client-Secret, das nur auf Railway liegt) und prüft `aud`, `iss`, `nonce`.
5. Das Backend gibt das ID-Token an Supabase (`grant_type=id_token`). Supabase prüft Signatur, Audience und nonce und stellt die Sitzung aus. Kein selbstgebautes Token.

**Warum nicht der Standard-Google-Login von Supabase:** Der leitet über `https://ifbpbsbgdpnxmwtycjqr.supabase.co/auth/v1/callback` zurück. Diese Adresse muss bei Google als «Authorized redirect URI» eingetragen sein – das geht nur bei Clients vom Typ «Web application», nicht bei Desktop-Clients. Für den gewählten Weg wird diese Supabase-Callback-Adresse **nicht** gebraucht.

**Zwei verschiedene Rückkehr-Adressen:**
- Google → App: `http://127.0.0.1:<Port>/callback` (Loopback, bei Desktop-Clients automatisch erlaubt, nichts einzutragen).
- Supabase-Callback `…/auth/v1/callback`: nur für den Standard-Weg, hier ungenutzt.

## Buddy Credits

- Preis je Anfrage = echte OpenAI-Kosten (USD) + 10 % → in CHF → in BC. Gerechnet wird nur in Postgres (`numeric`), nie mit JavaScript-Fliesskommazahlen.
- Ablauf: reservieren (Schätzung, gesperrte Wallet-Zeile) → OpenAI → mit echter Nutzung abrechnen → Rest freigeben.
- Anbieterkosten, Aufschlag und Gesamtkosten werden getrennt gespeichert (`usage_events`).
- Kein negatives Guthaben (Check-Constraint + Begrenzung beim Abrechnen). Buchungen sind unveränderlich (Trigger).
- Gutschrift nur nach signiertem Stripe-Webhook **und** Nachprüfung des Zahlungsstatus bei Stripe.
- Abgebrochene Streams ohne Nutzungsangabe werden geschätzt abgerechnet (Eingabe-Schätzung + Ausgabezeichen / 3). Ohne jede Ausgabe wird freigegeben.

### Entscheide, die noch fehlen (bewusst nicht erfunden)

| Wert | Wo | Wirkung, solange leer |
|---|---|---|
| `credits_per_chf` (BC je CHF) | `public.billing_settings` | Cloud-Anfragen werden abgelehnt |
| `usd_to_chf` (Kurs) | `public.billing_settings` | Cloud-Anfragen werden abgelehnt |
| Modellpreise | `public.model_pricing` | Modell nicht verfügbar |
| Credit-Pakete (CHF, BC) | `public.credit_packages` | keine Pakete zum Kaufen |

Vorlage: `supabase/seed/pricing-and-packages.template.sql`. Preise nur von https://developers.openai.com/api/docs/pricing übernehmen.

## Endpunkte

| Methode | Pfad | Schutz |
|---|---|---|
| GET | `/health` | öffentlich (nur «eingerichtet ja/nein») |
| POST | `/v1/auth/signup`, `/login`, `/verify-email`, `/resend-confirmation`, `/password-reset`, `/password-reset/confirm`, `/refresh` | Rate-Limit je IP |
| GET | `/v1/auth/google/config` | öffentlich (nur Client-ID) |
| POST | `/v1/auth/google` | Rate-Limit, Loopback-Prüfung, Replay-Schutz |
| POST | `/v1/auth/logout` | Token |
| GET/PATCH | `/v1/me` | Token |
| GET | `/v1/wallet`, `/v1/wallet/transactions`, `/v1/usage`, `/v1/purchases` | Token |
| GET | `/v1/credit-packages` | öffentlich |
| POST | `/v1/purchases/checkout` | Token, Rate-Limit |
| GET | `/v1/cloud/models` | Token |
| POST | `/v1/cloud/responses` | Token, Rate-Limit, Credits |
| POST | `/v1/cloud/audio/transcriptions`, `/v1/cloud/realtime/sessions` | 501 (noch nicht umgesetzt) |
| POST | `/webhooks/stripe` | Stripe-Signatur |

## Wo welches Geheimnis liegt

| Geheimnis | Ort | Nie in |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Railway Variables | App, Repo |
| `SUPABASE_PUBLISHABLE_KEY` | Railway Variables (öffentlich, aber nur das Backend braucht ihn) | – |
| `GOOGLE_CLIENT_SECRET` | Railway Variables | App, Repo, Supabase (nicht nötig) |
| `OPENAI_API_KEY` | Railway Variables | App, Repo |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Railway Variables | App, Repo |
| Sitzung des Nutzers | Wolfs/Nutzers PC, `settings.json`, verschlüsselt mit Windows DPAPI | Renderer, Logs |

Die App enthält nur die Backend-Adresse (`package.json` → `buddyCloud.apiUrl`). Die Google-Client-ID holt sie sich vom Backend.

## Einrichtung (Reihenfolge)

### 1. Supabase (Projekt `buddy-island`, Zürich) – Migrationen sind angewendet
1. https://supabase.com/dashboard/project/ifbpbsbgdpnxmwtycjqr/auth/providers → **Google** einschalten.
   - Unter **Client IDs** die Desktop-Client-ID eintragen: `500970603959-a5cf0i68ibc91j932pn9ooeqb7l4bmn0.apps.googleusercontent.com`.
   - Verlangt das Formular auch «Client ID» und «Client Secret», die Desktop-Werte eintragen (der Standard-Weg wird nicht benutzt). «Skip nonce check» **aus** lassen.
2. **Authentication → Email Templates:** In «Confirm signup» und «Reset password» den Code einbauen (`{{ .Token }}`), damit Nutzer ihn in Buddy eintippen können.
3. **Authentication → SMTP:** Eigenen Mailversand einrichten (der eingebaute Versand von Supabase ist stark begrenzt).
4. **Project Settings → API Keys:** Publishable Key und Secret Key für Railway kopieren.
5. Entscheide aus der Tabelle oben eintragen (SQL Editor, Vorlage im Repo).

### 2. Google Cloud Console
Nichts zu ändern für den Login selbst. Empfohlen vor dem Start: Client-Secret rotieren (es lag in einem Chat), OAuth-Zustimmungsbildschirm auf «In production» mit Datenschutz-Link https://buddy-island.top.

### 3. OpenAI
Eigenes Projekt «Buddy Cloud» mit Projekt-Key und Ausgabenlimit. Key nur in Railway.

### 4. Railway
1. Neues Projekt → «Deploy from GitHub repo» → `buddy-island`, **Root Directory** `backend`.
2. Variablen aus `backend/.env.example` setzen.
3. Eigene Domain, z. B. `api.buddy-island.top` (CNAME bei GoDaddy).
4. `/health` muss `configured` überall `true` zeigen.

### 5. Stripe
1. Erst im Testmodus: Webhook-Endpunkt `https://<backend>/webhooks/stripe` mit den Ereignissen `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
2. Signing Secret als `STRIPE_WEBHOOK_SECRET` in Railway.
3. Testkauf mit Testkarte, danach Live-Keys.

### 6. App
`package.json` → `"buddyCloud": { "apiUrl": "https://api.buddy-island.top" }` setzen. Erst dann erscheint «Buddy Cloud» als Anbieter. Das geht mit dem nächsten Release an alle.

## Tests

- `npm test` (App): u. a. `test/cloud.test.js` – Google-Loopback, Sitzung, Anbieter.
- `cd backend && npm test`: Backend mit Attrappen. Mit `BUDDY_TEST_PG="-h … -p … -U …"` zusätzlich gegen echtes PostgreSQL (Migrationen, RLS, Wallet, 20 parallele Anfragen, Ende-zu-Ende Gateway → Datenbank).
- CI führt beides aus (PostgreSQL 17 als Dienst).

## Grenzen (ehrlich)

- Rate-Limits liegen im Speicher: gilt pro Railway-Instanz. Mehr als eine Instanz braucht einen gemeinsamen Speicher.
- Spracherkennung und Echtzeit-Sprache: vorbereitet (Preisspalten, Endpunkte), aber nicht umgesetzt.
- OpenAI «cache writes» und Langkontext-Preise sind nicht modelliert; Anfragen über ~250k geschätzte Tokens werden abgelehnt, Buddy setzt kein explizites Caching.
- Kein Live-Test gegen Google, OpenAI, Stripe oder den Supabase-Auth-Server: Keys fehlen in dieser Umgebung.
