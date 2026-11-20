-- Buddy Live (OpenAI Realtime): Preis für das Realtime-Modell (nur Vorlage, NICHT automatisch ausgeführt).
-- Keine Schema-Änderung nötig: model_pricing.audio_pricing (input_per_1m, output_per_1m) und billing_quote(p_audio)
-- gibt es seit 20261109080000. Die Kommission (25 %) kommt wie beim Chat aus billing_settings.markup_rate.
--
-- !!! VOR DEM AUSFÜHREN PREISE PRÜFEN !!!
-- Quelle: https://developers.openai.com/api/docs/pricing (Abschnitt Realtime / Audio)
-- Am 20.11.2026 in der automatischen Sitzung NICHT direkt auf der OpenAI-Preisseite gelesen. Zahlen von
-- https://www.forasoft.com/blog/article/openai-realtime-api-pricing (Stand 8.11.2026, laut Artikel gegen
-- die OpenAI-Preisseite geprüft). USD je 1 Mio. Tokens:
--   gpt-realtime-2.1       Text ein 4.00 · Text zwischengesp. 0.40 · Text aus 24.00 · Ton ein 32.00 · Ton zwischengesp. 0.40 · Ton aus 64.00
--   gpt-realtime-2.1-mini  Text ein 0.60 · Text zwischengesp. 0.06 · Text aus  2.40 · Ton ein 10.00 · Ton zwischengesp. 0.30 · Ton aus 20.00
--
-- Abrechnung im Backend (backend/src/services/realtime.js, realtimeUsage):
--   Text- und Bild-Tokens          → input_price / output_price
--   Zwischengespeichert (Text+Ton) → cached_input_price  (bei 2.1 gleich teuer wie zwischengespeicherter Ton)
--   Ton nicht zwischengespeichert  → audio_pricing.input_per_1m / output_per_1m
--   Bei «mini» ist zwischengespeicherter Ton (0.30) teurer als Text (0.06): dort cached_input_price auf 0.30 setzen
--   (Kunde zahlt bei zwischengespeichertem Text etwas zu viel, nie zu wenig).
--
-- Anderes Modell: auch REALTIME_MODEL in Railway setzen.
-- Ausführen: Supabase → Projekt «buddy-island» → SQL Editor → diesen Text einfügen → Run.

insert into public.model_pricing (model_id, input_price, cached_input_price, output_price, audio_pricing, effective_from)
values (
  'gpt-realtime-2.1',
  4.00,      -- Text-Eingabe, USD je 1 Mio. Tokens
  0.40,      -- zwischengespeichert (Text und Ton)
  24.00,     -- Text-Ausgabe
  '{"input_per_1m": 32.00, "output_per_1m": 64.00}'::jsonb,
  now()
);

-- Kontrolle: 1 Minute Gespräch, je die Hälfte Du/Buddy (≈ 300 Ton-Tokens ein, 600 aus, 2000 Text, 1500 davon zwischengesp.):
-- select * from public.billing_quote('gpt-realtime-2.1', 2000, 1500, 50, '{"input_tokens": 300, "output_tokens": 600}'::jsonb);
