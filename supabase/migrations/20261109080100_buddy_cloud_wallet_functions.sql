-- Buddy Credits: atomare Wallet-Funktionen.
--
-- Jede Funktion sperrt die Wallet-Zeile (SELECT … FOR UPDATE), bevor sie rechnet. Damit
-- laufen gleichzeitige Anfragen desselben Nutzers nacheinander und können nicht zu viel
-- ausgeben. Idempotenz über request_id / checkout_id / (Art, Referenz) im Journal.
-- Alle Funktionen sind SECURITY DEFINER mit leerem search_path und nur für service_role
-- (das Backend) ausführbar. Fehler kommen als P0001 mit festem Code in MESSAGE:
--   insufficient_credits, billing_not_configured, unknown_model_pricing, reservation_not_found,
--   request_id_conflict, purchase_not_found, amount_mismatch, invalid_amount, package_not_found

-- ---------------------------------------------------------------------------
-- Wallet anlegen (idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.ensure_wallet(p_user_id uuid)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
begin
  if p_user_id is null then
    raise exception 'invalid_user' using errcode = 'P0001';
  end if;
  insert into public.wallets (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into w from public.wallets where user_id = p_user_id;
  return w;
end;
$$;

-- Wallet gesperrt holen (legt sie bei Bedarf an)
create or replace function public.lock_wallet(p_user_id uuid)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
begin
  perform public.ensure_wallet(p_user_id);
  select * into w from public.wallets where user_id = p_user_id for update;
  return w;
end;
$$;

-- ---------------------------------------------------------------------------
-- Neuer Nutzer → Profil + Wallet
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 80);
  v_avatar text := new.raw_user_meta_data ->> 'avatar_url';
begin
  if v_avatar is not null and (v_avatar !~* '^https://' or char_length(v_avatar) > 500) then
    v_avatar := null;
  end if;
  insert into public.profiles (id, display_name, avatar_url) values (new.id, v_name, v_avatar)
    on conflict (id) do nothing;
  insert into public.wallets (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Preis einer Anfrage (exakt, numeric)
-- p_input_tokens enthält die gecachten Tokens (wie OpenAI usage.input_tokens).
-- p_audio: {"input_tokens": n, "output_tokens": n, "transcription_seconds": n}
-- ---------------------------------------------------------------------------
create or replace function public.billing_quote(
  p_model text,
  p_input_tokens integer,
  p_cached_tokens integer,
  p_output_tokens integer,
  p_audio jsonb default null
)
returns table (provider_cost numeric, markup_amount numeric, total_cost numeric, credits numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  s public.billing_settings;
  p public.model_pricing;
  v_in integer := greatest(coalesce(p_input_tokens, 0), 0);
  v_cached integer := least(greatest(coalesce(p_cached_tokens, 0), 0), greatest(coalesce(p_input_tokens, 0), 0));
  v_out integer := greatest(coalesce(p_output_tokens, 0), 0);
  v_cost numeric := 0;
begin
  select * into s from public.billing_settings where id;
  if s.usd_to_chf is null or s.credits_per_chf is null then
    raise exception 'billing_not_configured' using errcode = 'P0001';
  end if;
  select * into p from public.model_pricing
    where model_id = p_model and active and effective_from <= now()
    order by effective_from desc limit 1;
  if not found then
    raise exception 'unknown_model_pricing' using errcode = 'P0001', detail = p_model;
  end if;

  v_cost := ((v_in - v_cached)::numeric * p.input_price
           + v_cached::numeric * coalesce(p.cached_input_price, p.input_price)
           + v_out::numeric * p.output_price) / 1000000;

  if p_audio is not null and p.audio_pricing is not null then
    v_cost := v_cost
      + coalesce((p_audio ->> 'input_tokens')::numeric, 0) * coalesce((p.audio_pricing ->> 'input_per_1m')::numeric, 0) / 1000000
      + coalesce((p_audio ->> 'output_tokens')::numeric, 0) * coalesce((p.audio_pricing ->> 'output_per_1m')::numeric, 0) / 1000000
      + coalesce((p_audio ->> 'transcription_seconds')::numeric, 0) * coalesce((p.audio_pricing ->> 'transcription_per_minute')::numeric, 0) / 60;
  elsif p_audio is not null and p.audio_pricing is null then
    raise exception 'unknown_model_pricing' using errcode = 'P0001', detail = p_model || ' (audio)';
  end if;

  provider_cost := round(v_cost, 8);
  markup_amount := round(v_cost * s.markup_rate, 8);
  total_cost := provider_cost + markup_amount;
  -- Aufrunden auf 6 Stellen: Buddy rechnet nie zu wenig ab, höchstens 0.000001 BC zu viel
  credits := (ceil(total_cost * s.usd_to_chf * s.credits_per_chf * 1000000) / 1000000)::numeric(20, 6);
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Abgelaufene Reservierungen freigeben
-- ---------------------------------------------------------------------------
create or replace function public.release_expired_reservations(p_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select request_id from public.credit_reservations
     where status = 'active' and expires_at < now() and (p_user_id is null or user_id = p_user_id)
     order by created_at
  loop
    perform public.release_reservation(r.request_id, 'released', 'Reservierung abgelaufen');
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Credits reservieren (vor der Anfrage an OpenAI)
-- ---------------------------------------------------------------------------
create or replace function public.reserve_credits(
  p_user_id uuid,
  p_request_id text,
  p_model text,
  p_amount numeric
)
returns table (reservation_id uuid, amount numeric, available_credits numeric, reserved_credits numeric, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  w public.wallets;
  r public.credit_reservations;
  s public.billing_settings;
  v_amount numeric := ceil(coalesce(p_amount, 0) * 1000000) / 1000000;
begin
  if v_amount <= 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;

  w := public.lock_wallet(p_user_id);

  -- Idempotenz: gleiche request_id → gleiche Reservierung
  select * into r from public.credit_reservations where request_id = p_request_id;
  if found then
    if r.user_id <> p_user_id then
      raise exception 'request_id_conflict' using errcode = 'P0001';
    end if;
    select * into w from public.wallets where id = w.id;
    return query select r.id, r.amount, w.available_credits, w.reserved_credits, r.status;
    return;
  end if;

  -- Alte, hängende Reservierungen dieses Nutzers zuerst freigeben (Wallet ist schon gesperrt)
  perform public.release_expired_reservations(p_user_id);
  select * into w from public.wallets where id = w.id;

  if w.available_credits < v_amount then
    raise exception 'insufficient_credits' using errcode = 'P0001',
      detail = format('available=%s required=%s', w.available_credits, v_amount);
  end if;

  select * into s from public.billing_settings where id;

  update public.wallets
     set available_credits = available_credits - v_amount,
         reserved_credits = reserved_credits + v_amount
   where id = w.id
   returning * into w;

  insert into public.credit_reservations (user_id, wallet_id, request_id, model, amount, expires_at)
  values (p_user_id, w.id, p_request_id, p_model, v_amount, now() + make_interval(secs => s.reservation_ttl_seconds))
  returning * into r;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p_user_id, w.id, 'reservation', -v_amount, w.available_credits, p_request_id, 'Reserviert für Cloud-Anfrage');

  return query select r.id, r.amount, w.available_credits, w.reserved_credits, r.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reservierung freigeben (Anfrage abgebrochen oder fehlgeschlagen)
-- p_status: 'released' (abgebrochen/abgelaufen) oder 'failed' (Fehler beim Anbieter)
-- ---------------------------------------------------------------------------
create or replace function public.release_reservation(
  p_request_id text,
  p_status text default 'released',
  p_reason text default null
)
returns table (available_credits numeric, reserved_credits numeric, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r public.credit_reservations;
  w public.wallets;
begin
  if p_status not in ('released', 'failed') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;
  select * into r from public.credit_reservations where request_id = p_request_id;
  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;
  -- Erst Wallet, dann Reservierung sperren (gleiche Reihenfolge wie überall → keine Deadlocks)
  w := public.lock_wallet(r.user_id);
  select * into r from public.credit_reservations where id = r.id for update;

  if r.status <> 'active' then
    return query select w.available_credits, w.reserved_credits, r.status;
    return;
  end if;

  update public.wallets
     set available_credits = available_credits + r.amount,
         reserved_credits = reserved_credits - r.amount
   where id = w.id
   returning * into w;

  update public.credit_reservations set status = 'released', closed_at = now() where id = r.id;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (r.user_id, w.id, 'reservation_release', r.amount, w.available_credits, p_request_id,
          left(coalesce(p_reason, 'Reservierung freigegeben'), 500));

  insert into public.usage_events (user_id, request_id, model, status)
  values (r.user_id, p_request_id, r.model, p_status)
  on conflict (request_id) do nothing;

  return query select w.available_credits, w.reserved_credits, 'released'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reservierung abrechnen (nach der Antwort, mit echten Usage-Zahlen)
-- Kostet die Anfrage mehr als reserviert, wird der Rest vom verfügbaren Guthaben
-- genommen – aber nie mehr als vorhanden (kein negatives Guthaben). Dann status 'partial'.
-- ---------------------------------------------------------------------------
create or replace function public.settle_reservation(
  p_request_id text,
  p_input_tokens integer,
  p_cached_tokens integer,
  p_output_tokens integer,
  p_audio jsonb default null
)
returns public.usage_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.credit_reservations;
  w public.wallets;
  q record;
  e public.usage_events;
  v_reserved numeric;
  v_charge numeric;
  v_status text;
begin
  select * into r from public.credit_reservations where request_id = p_request_id;
  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;
  w := public.lock_wallet(r.user_id);
  select * into r from public.credit_reservations where id = r.id for update;

  if r.status = 'settled' then
    select * into e from public.usage_events where request_id = p_request_id;
    return e;
  end if;

  select * into q from public.billing_quote(r.model, p_input_tokens, p_cached_tokens, p_output_tokens, p_audio);

  v_reserved := case when r.status = 'active' then r.amount else 0 end;
  v_charge := least(q.credits, v_reserved + w.available_credits);
  v_status := case when v_charge < q.credits then 'partial' else 'settled' end;

  if v_reserved > 0 then
    update public.wallets
       set available_credits = available_credits + v_reserved,
           reserved_credits = reserved_credits - v_reserved
     where id = w.id
     returning * into w;
    insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
    values (r.user_id, w.id, 'reservation_release', v_reserved, w.available_credits, p_request_id, 'Reservierung abgerechnet');
  end if;

  update public.wallets
     set available_credits = available_credits - v_charge,
         lifetime_consumed = lifetime_consumed + v_charge
   where id = w.id
   returning * into w;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (r.user_id, w.id, 'usage', -v_charge, w.available_credits, p_request_id,
          case when v_status = 'partial' then 'Cloud-Nutzung (Guthaben reichte nicht ganz)' else 'Cloud-Nutzung' end);

  update public.credit_reservations set status = 'settled', closed_at = now() where id = r.id;

  -- Falls eine abgelaufene Reservierung schon als 'released' eingetragen wurde: überschreiben
  insert into public.usage_events (
    user_id, request_id, model, input_tokens, output_tokens, cached_tokens, audio_usage,
    provider_cost, markup_amount, total_cost, credits_charged, status
  ) values (
    r.user_id, p_request_id, r.model, greatest(coalesce(p_input_tokens, 0), 0), greatest(coalesce(p_output_tokens, 0), 0),
    greatest(coalesce(p_cached_tokens, 0), 0), p_audio,
    q.provider_cost, q.markup_amount, q.total_cost, v_charge, v_status
  )
  on conflict (request_id) do update set
    input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
    cached_tokens = excluded.cached_tokens, audio_usage = excluded.audio_usage,
    provider_cost = excluded.provider_cost, markup_amount = excluded.markup_amount,
    total_cost = excluded.total_cost, credits_charged = excluded.credits_charged, status = excluded.status
  returning * into e;

  return e;
end;
$$;

-- ---------------------------------------------------------------------------
-- Käufe
-- ---------------------------------------------------------------------------
create or replace function public.create_purchase(p_user_id uuid, p_package_id uuid)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.credit_packages;
  p public.purchases;
begin
  select * into k from public.credit_packages where id = p_package_id and active;
  if not found then
    raise exception 'package_not_found' using errcode = 'P0001';
  end if;
  perform public.ensure_wallet(p_user_id);
  insert into public.purchases (user_id, package_id, amount_chf, credits_purchased)
  values (p_user_id, k.id, k.price_chf, k.credits)
  returning * into p;
  return p;
end;
$$;

create or replace function public.attach_checkout(p_purchase_id uuid, p_checkout_id text)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.purchases;
begin
  update public.purchases set provider_checkout_id = p_checkout_id
   where id = p_purchase_id and status = 'pending' and provider_checkout_id is null
   returning * into p;
  if not found then
    raise exception 'purchase_not_found' using errcode = 'P0001';
  end if;
  return p;
end;
$$;

-- Nur aus einem verifizierten Stripe-Webhook aufrufen.
create or replace function public.complete_purchase(
  p_purchase_id uuid,
  p_checkout_id text,
  p_payment_id text,
  p_amount_chf numeric,
  p_currency text
)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.purchases;
  w public.wallets;
begin
  select * into p from public.purchases where id = p_purchase_id;
  if not found then
    raise exception 'purchase_not_found' using errcode = 'P0001';
  end if;
  w := public.lock_wallet(p.user_id);
  select * into p from public.purchases where id = p_purchase_id for update;

  if p.provider_checkout_id is distinct from p_checkout_id then
    raise exception 'purchase_not_found' using errcode = 'P0001', detail = 'checkout mismatch';
  end if;
  if p.status in ('completed', 'refunded', 'partially_refunded') then
    return p; -- schon gutgeschrieben (Webhook doppelt)
  end if;
  if lower(coalesce(p_currency, '')) <> 'chf' or p_amount_chf is distinct from p.amount_chf then
    raise exception 'amount_mismatch' using errcode = 'P0001',
      detail = format('expected=%s CHF got=%s %s', p.amount_chf, p_amount_chf, p_currency);
  end if;

  update public.wallets
     set available_credits = available_credits + p.credits_purchased,
         lifetime_purchased = lifetime_purchased + p.credits_purchased
   where id = w.id
   returning * into w;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p.user_id, w.id, 'purchase', p.credits_purchased, w.available_credits, p.id::text,
          format('Kauf: %s BC für CHF %s', p.credits_purchased, p.amount_chf));

  update public.purchases
     set status = 'completed', provider_payment_id = p_payment_id, completed_at = now()
   where id = p.id
   returning * into p;
  return p;
end;
$$;

create or replace function public.mark_purchase(p_checkout_id text, p_status text)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.purchases;
begin
  if p_status not in ('failed', 'expired') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;
  update public.purchases set status = p_status
   where provider_checkout_id = p_checkout_id and status = 'pending'
   returning * into p;
  if not found then
    select * into p from public.purchases where provider_checkout_id = p_checkout_id;
  end if;
  return p;
end;
$$;

-- Rückerstattung. p_refunded_total_chf = gesamter bisher erstatteter Betrag (Stripe amount_refunded).
-- Idempotent: nur die Differenz zur letzten Meldung wird verbucht.
-- Credits werden anteilig abgezogen, aber nie unter 0 (schon verbrauchte Credits bleiben verbraucht).
create or replace function public.refund_purchase(p_payment_id text, p_refunded_total_chf numeric)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.purchases;
  w public.wallets;
  v_total numeric := round(coalesce(p_refunded_total_chf, 0), 2);
  v_credits_target numeric;
  v_remove numeric;
  v_deduct numeric;
begin
  select * into p from public.purchases where provider_payment_id = p_payment_id;
  if not found then
    raise exception 'purchase_not_found' using errcode = 'P0001';
  end if;
  w := public.lock_wallet(p.user_id);
  select * into p from public.purchases where id = p.id for update;

  if v_total <= p.refunded_chf then
    return p;
  end if;
  if v_total > p.amount_chf then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;

  v_credits_target := round(p.credits_purchased * v_total / p.amount_chf, 6);
  v_remove := greatest(v_credits_target - p.credits_refunded, 0);
  v_deduct := least(v_remove, w.available_credits);

  update public.wallets
     set available_credits = available_credits - v_deduct
   where id = w.id
   returning * into w;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p.user_id, w.id, 'refund', -v_deduct, w.available_credits, p.id::text || ':' || v_total::text,
          format('Rückerstattung CHF %s (%s BC abgezogen%s)', v_total - p.refunded_chf, v_deduct,
                 case when v_deduct < v_remove then format(', %s BC waren schon verbraucht', v_remove - v_deduct) else '' end));

  update public.purchases
     set refunded_chf = v_total,
         credits_refunded = credits_refunded + v_remove,
         status = case when v_total >= amount_chf then 'refunded' else 'partially_refunded' end
   where id = p.id
   returning * into p;
  return p;
end;
$$;

-- Manuelle Korrektur durch Support (z. B. Gutschrift nach Fehler). Nie unter 0.
create or replace function public.adjust_credits(p_user_id uuid, p_amount numeric, p_reference text, p_description text)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  w := public.lock_wallet(p_user_id);
  if w.available_credits + p_amount < 0 then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;
  update public.wallets set available_credits = available_credits + p_amount where id = w.id returning * into w;
  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p_user_id, w.id, 'adjustment', p_amount, w.available_credits, p_reference, left(p_description, 500));
  return w;
end;
$$;

-- Wallet lesen (legt sie bei Bedarf an)
create or replace function public.get_wallet(p_user_id uuid)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.ensure_wallet(p_user_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Ausführungsrechte: nur service_role
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ensure_wallet(uuid)', 'public.lock_wallet(uuid)', 'public.handle_new_user()',
    'public.billing_quote(text, integer, integer, integer, jsonb)',
    'public.release_expired_reservations(uuid)',
    'public.reserve_credits(uuid, text, text, numeric)',
    'public.release_reservation(text, text, text)',
    'public.settle_reservation(text, integer, integer, integer, jsonb)',
    'public.create_purchase(uuid, uuid)', 'public.attach_checkout(uuid, text)',
    'public.complete_purchase(uuid, text, text, numeric, text)',
    'public.mark_purchase(text, text)', 'public.refund_purchase(text, numeric)',
    'public.adjust_credits(uuid, numeric, text, text)', 'public.get_wallet(uuid)',
    'public.set_updated_at()', 'public.reject_change()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

grant select, insert, update on public.profiles, public.wallets, public.purchases, public.usage_events,
  public.credit_reservations, public.credit_packages, public.model_pricing, public.billing_settings to service_role;
grant select, insert on public.wallet_transactions to service_role;
