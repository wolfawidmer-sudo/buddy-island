-- Diktat über Buddy Cloud: Preis für das Transkriptionsmodell (nur Vorlage, NICHT automatisch ausgeführt).
-- Keine Schema-Änderung nötig: model_pricing.audio_pricing, billing_quote(p_audio) und usage_events.audio_usage
-- gibt es seit 20261109080000. Die Kommission (25 %) kommt wie beim Chat aus billing_settings.markup_rate.
--
-- !!! VOR DEM AUSFÜHREN PREISE PRÜFEN !!!
-- Quelle: https://developers.openai.com/api/docs/pricing (Abschnitt Transcription / Audio) und
--         https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
-- Am 11.11.2026 konnte die Preisseite in der automatischen Sitzung nicht vollständig gelesen werden.
-- Die Zahlen unten sind der zuletzt bekannte Stand (gpt-4o-mini-transcribe, USD je 1 Mio. Tokens):
--   Text-Eingabe 1.25 · Text-Ausgabe 5.00 · Audio-Eingabe 3.00 · geschätzt 0.003 USD pro Minute.
-- Weichen die Werte auf der Preisseite ab: die Zahlen hier anpassen. Anderes Modell: auch TRANSCRIBE_MODEL in Railway.
--
-- Abrechnung im Backend (backend/src/services/transcribe.js):
--   OpenAI meldet Tokens  → input_price (Text), output_price (Text), audio_pricing.input_per_1m (Audio)
--   OpenAI meldet Sekunden oder nichts → nur audio_pricing.transcription_per_minute
--   Nie beides zugleich.
--
-- Ausführen: Supabase → Projekt «buddy-island» → SQL Editor → diesen Text einfügen → Run.

insert into public.model_pricing (model_id, input_price, cached_input_price, output_price, audio_pricing, effective_from)
values (
  'gpt-4o-mini-transcribe',
  1.25,      -- Text-Eingabe (Prompt), USD je 1 Mio. Tokens
  null,
  5.00,      -- Text-Ausgabe (Transkript), USD je 1 Mio. Tokens
  '{"input_per_1m": 3.00, "transcription_per_minute": 0.003}'::jsonb,
  now()
);

-- Kontrolle: Was kostet 1 Minute Diktat (≈ 600 Audio-Tokens, 150 Text-Tokens) in Buddy Credits?
-- select * from public.billing_quote('gpt-4o-mini-transcribe', 0, 0, 150, '{"input_tokens": 600}'::jsonb);
