-- VORLAGE – NICHT AUSFÜHREN, BEVOR WOLF DIE WERTE BESTÄTIGT HAT.
-- Stand 9.11.2026: Bezahlung in USD, Kommission 25 % (bereits gesetzt), $5 bis $500.

-- 1) Umrechnung: wie viele Buddy Credits 1 USD ergibt (Entscheid von Wolf)
-- update public.billing_settings set credits_per_usd = <BC_PRO_USD>;

-- 2) Modellpreise in USD je 1 Million Tokens – NUR von der offiziellen Seite übernehmen:
--    https://developers.openai.com/api/docs/pricing  (Standard-Tarif, kurzer Kontext)
-- insert into public.model_pricing (model_id, input_price, cached_input_price, output_price, effective_from) values
--   ('<modell-id>', <input>, <cached_input>, <output>, now());
-- Preisänderung später: neue Zeile mit neuem effective_from (alte bleibt für die Historie).

-- 3) Abo (eine Stufe): Preis pro Monat in USD und Monats-Credits
-- insert into public.subscription_plans (name, price, monthly_credits, display_order) values
--   ('Buddy Plus', <USD_PRO_MONAT>, <BC_PRO_MONAT>, 1);

-- 4) Optional: feste Pakete als Schnellwahl (eigener Betrag geht immer)
-- insert into public.credit_packages (name, price, credits, display_order) values
--   ('<Name>', <USD>, <BC>, 1);
