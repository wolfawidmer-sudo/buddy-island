-- Buddy Cloud v2: Bezahlung in USD, frei wählbarer Betrag (ab $5), Abo mit Monats-Credits,
-- 25 % Kommission.
--
-- Zwei Guthaben-Töpfe pro Wallet:
--   available_credits     gekauft (Pay as you go), verfällt nicht
--   subscription_credits  aus dem Abo, verfällt am Ende der Abo-Periode (subscription_expires_at)
-- Verbraucht wird immer zuerst das Abo-Guthaben, dann das gekaufte.
-- Die alten CHF-Funktionen complete_purchase/refund_purchase werden stillgelegt
-- (ersetzt durch confirm_purchase/refund_payment) und können später entfernt werden.

-- ---------------------------------------------------------------------------
-- Währung USD
-- ---------------------------------------------------------------------------
alter table public.credit_packages rename column price_chf to price;
alter table public.credit_packages add column currency text not null default 'usd' check (currency = 'usd');

alter table public.purchases rename column amount_chf to amount;
alter table public.purchases rename column refunded_chf to refunded_amount;
alter table public.purchases add column currency text not null default 'usd' check (currency = 'usd');
alter table public.purchases add column kind text not null default 'package' check (kind in ('package', 'custom'));

alter table public.billing_settings add column credits_per_usd numeric(14, 6) check (credits_per_usd is null or credits_per_usd > 0);
alter table public.billing_settings add column min_purchase numeric(10, 2) not null default 5 check (min_purchase >= 1);
alter table public.billing_settings add column max_purchase numeric(10, 2) not null default 500;
alter table public.billing_settings add constraint billing_settings_purchase_range check (max_purchase >= min_purchase);
alter table public.billing_settings alter column markup_rate set default 0.25;
update public.billing_settings set markup_rate = 0.25;
comment on column public.billing_settings.usd_to_chf is 'veraltet seit USD-Umstellung (9.11.2026), ungenutzt';
comment on column public.billing_settings.credits_per_chf is 'veraltet seit USD-Umstellung (9.11.2026), ungenutzt';

-- ---------------------------------------------------------------------------
-- Abo-Guthaben in der Wallet
-- ---------------------------------------------------------------------------
alter table public.wallets add column subscription_credits numeric(20, 6) not null default 0 check (subscription_credits >= 0);
alter table public.wallets add column subscription_expires_at timestamptz;
alter table public.credit_reservations add column amount_subscription numeric(20, 6) not null default 0 check (amount_subscription >= 0);
alter table public.credit_reservations add constraint credit_reservations_parts check (amount_subscription <= amount);

-- Neue Buchungsarten (balance_after = Gesamtguthaben: gekauft + Abo)
alter table public.wallet_transactions drop constraint wallet_transactions_transaction_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_transaction_type_check check (transaction_type in (
  'purchase', 'reservation', 'reservation_release', 'usage', 'refund', 'adjustment',
  'subscription_grant', 'subscription_expiry'
));

-- ---------------------------------------------------------------------------
-- Abo-Pläne und Abos
-- ---------------------------------------------------------------------------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  price numeric(10, 2) not null check (price > 0),
  currency text not null default 'usd' check (currency = 'usd'),
  monthly_credits numeric(20, 6) not null check (monthly_credits > 0),
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  plan_id uuid references public.subscription_plans (id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_customer_idx on public.subscriptions (stripe_customer_id);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscription_plans enable row level security;
alter table public.subscriptions enable row level security;
revoke all on public.subscription_plans, public.subscriptions from anon, authenticated;
grant select on public.subscription_plans to anon, authenticated;
grant select on public.subscriptions to authenticated;
create policy "subscription_plans: aktive lesen" on public.subscription_plans
  for select to anon, authenticated using (active);
create policy "subscriptions: eigenes lesen" on public.subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);
grant select, insert, update on public.subscription_plans, public.subscriptions to service_role;

-- ---------------------------------------------------------------------------
-- Hilfsfunktion: abgelaufenes Abo-Guthaben verfallen lassen (Wallet muss gesperrt sein)
-- ---------------------------------------------------------------------------
create or replace function public.expire_subscription_credits(p_wallet_id uuid, p_reference text, p_force boolean default false)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
  v_amount numeric;
begin
  select * into w from public.wallets where id = p_wallet_id for update;
  if w.subscription_credits <= 0 then
    return w;
  end if;
  if not p_force and (w.subscription_expires_at is null or w.subscription_expires_at > now()) then
    return w;
  end if;
  v_amount := w.subscription_credits;
  update public.wallets set subscription_credits = 0 where id = w.id returning * into w;
  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (w.user_id, w.id, 'subscription_expiry', -v_amount, w.available_credits + w.subscription_credits, p_reference,
          'Abo-Guthaben verfallen')
  on conflict (transaction_type, reference_id) do nothing;
  return w;
end;
$$;

-- ---------------------------------------------------------------------------
-- Preis einer Anfrage: Anbieterkosten (USD) + Kommission → Buddy Credits (BC je USD)
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
  if s.credits_per_usd is null then
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
  credits := (ceil(total_cost * s.credits_per_usd * 1000000) / 1000000)::numeric(20, 6);
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reservieren: zuerst Abo-Guthaben, dann gekauftes
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
  v_sub numeric;
  v_paid numeric;
begin
  if v_amount <= 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;

  w := public.lock_wallet(p_user_id);

  select * into r from public.credit_reservations where request_id = p_request_id;
  if found then
    if r.user_id <> p_user_id then
      raise exception 'request_id_conflict' using errcode = 'P0001';
    end if;
    select * into w from public.wallets where id = w.id;
    return query select r.id, r.amount, w.available_credits + w.subscription_credits, w.reserved_credits, r.status;
    return;
  end if;

  perform public.release_expired_reservations(p_user_id);
  w := public.expire_subscription_credits(w.id, 'expiry:' || w.id::text || ':' || extract(epoch from clock_timestamp())::text);

  if w.available_credits + w.subscription_credits < v_amount then
    raise exception 'insufficient_credits' using errcode = 'P0001',
      detail = format('available=%s required=%s', w.available_credits + w.subscription_credits, v_amount);
  end if;
  v_sub := least(w.subscription_credits, v_amount);
  v_paid := v_amount - v_sub;

  select * into s from public.billing_settings where id;

  update public.wallets
     set subscription_credits = subscription_credits - v_sub,
         available_credits = available_credits - v_paid,
         reserved_credits = reserved_credits + v_amount
   where id = w.id
   returning * into w;

  insert into public.credit_reservations (user_id, wallet_id, request_id, model, amount, amount_subscription, expires_at)
  values (p_user_id, w.id, p_request_id, p_model, v_amount, v_sub, now() + make_interval(secs => s.reservation_ttl_seconds))
  returning * into r;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p_user_id, w.id, 'reservation', -v_amount, w.available_credits + w.subscription_credits, p_request_id, 'Reserviert für Cloud-Anfrage');

  return query select r.id, r.amount, w.available_credits + w.subscription_credits, w.reserved_credits, r.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Freigeben: jeder Teil zurück in seinen Topf
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
  w := public.lock_wallet(r.user_id);
  select * into r from public.credit_reservations where id = r.id for update;

  if r.status <> 'active' then
    return query select w.available_credits + w.subscription_credits, w.reserved_credits, r.status;
    return;
  end if;

  update public.wallets
     set available_credits = available_credits + (r.amount - r.amount_subscription),
         subscription_credits = subscription_credits + r.amount_subscription,
         reserved_credits = reserved_credits - r.amount
   where id = w.id
   returning * into w;

  update public.credit_reservations set status = 'released', closed_at = now() where id = r.id;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (r.user_id, w.id, 'reservation_release', r.amount, w.available_credits + w.subscription_credits, p_request_id,
          left(coalesce(p_reason, 'Reservierung freigegeben'), 500));

  insert into public.usage_events (user_id, request_id, model, status)
  values (r.user_id, p_request_id, r.model, p_status)
  on conflict (request_id) do nothing;

  return query select w.available_credits + w.subscription_credits, w.reserved_credits, 'released'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Abrechnen: Reservierung zurück, dann echte Kosten abziehen (Abo zuerst), nie negativ
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
  v_reserved_sub numeric;
  v_charge numeric;
  v_from_sub numeric;
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
  v_reserved_sub := case when r.status = 'active' then r.amount_subscription else 0 end;

  if v_reserved > 0 then
    update public.wallets
       set available_credits = available_credits + (v_reserved - v_reserved_sub),
           subscription_credits = subscription_credits + v_reserved_sub,
           reserved_credits = reserved_credits - v_reserved
     where id = w.id
     returning * into w;
    insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
    values (r.user_id, w.id, 'reservation_release', v_reserved, w.available_credits + w.subscription_credits, p_request_id, 'Reservierung abgerechnet');
  end if;

  v_charge := least(q.credits, w.available_credits + w.subscription_credits);
  v_from_sub := least(v_charge, w.subscription_credits);
  v_status := case when v_charge < q.credits then 'partial' else 'settled' end;

  update public.wallets
     set subscription_credits = subscription_credits - v_from_sub,
         available_credits = available_credits - (v_charge - v_from_sub),
         lifetime_consumed = lifetime_consumed + v_charge
   where id = w.id
   returning * into w;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (r.user_id, w.id, 'usage', -v_charge, w.available_credits + w.subscription_credits, p_request_id,
          case when v_status = 'partial' then 'Cloud-Nutzung (Guthaben reichte nicht ganz)' else 'Cloud-Nutzung' end);

  update public.credit_reservations set status = 'settled', closed_at = now() where id = r.id;

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
-- Kauf: Paket oder eigener Betrag (USD)
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
  insert into public.purchases (user_id, package_id, amount, currency, credits_purchased, kind)
  values (p_user_id, k.id, k.price, 'usd', k.credits, 'package')
  returning * into p;
  return p;
end;
$$;

create or replace function public.create_custom_purchase(p_user_id uuid, p_amount numeric)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.billing_settings;
  p public.purchases;
begin
  select * into s from public.billing_settings where id;
  if s.credits_per_usd is null then
    raise exception 'billing_not_configured' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <> round(p_amount, 2) or p_amount < s.min_purchase or p_amount > s.max_purchase then
    raise exception 'invalid_amount' using errcode = 'P0001',
      detail = format('min=%s max=%s', s.min_purchase, s.max_purchase);
  end if;
  perform public.ensure_wallet(p_user_id);
  insert into public.purchases (user_id, package_id, amount, currency, credits_purchased, kind)
  values (p_user_id, null, p_amount, 'usd', (p_amount * s.credits_per_usd)::numeric(20, 6), 'custom')
  returning * into p;
  return p;
end;
$$;

-- Nur aus einem verifizierten Stripe-Webhook aufrufen (nach Nachprüfung bei Stripe).
create or replace function public.confirm_purchase(
  p_purchase_id uuid,
  p_checkout_id text,
  p_payment_id text,
  p_amount numeric,
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
    return p;
  end if;
  if lower(coalesce(p_currency, '')) <> p.currency or p_amount is distinct from p.amount then
    raise exception 'amount_mismatch' using errcode = 'P0001',
      detail = format('expected=%s %s got=%s %s', p.amount, p.currency, p_amount, p_currency);
  end if;

  update public.wallets
     set available_credits = available_credits + p.credits_purchased,
         lifetime_purchased = lifetime_purchased + p.credits_purchased
   where id = w.id
   returning * into w;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p.user_id, w.id, 'purchase', p.credits_purchased, w.available_credits + w.subscription_credits, p.id::text,
          format('Kauf: %s BC für $%s', p.credits_purchased, p.amount));

  update public.purchases
     set status = 'completed', provider_payment_id = p_payment_id, completed_at = now()
   where id = p.id
   returning * into p;
  return p;
end;
$$;

-- Rückerstattung. p_refunded_total = gesamter bisher erstatteter Betrag in USD (Stripe amount_refunded).
create or replace function public.refund_payment(p_payment_id text, p_refunded_total numeric)
returns public.purchases
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.purchases;
  w public.wallets;
  v_total numeric := round(coalesce(p_refunded_total, 0), 2);
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

  if v_total <= p.refunded_amount then
    return p;
  end if;
  if v_total > p.amount then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;

  v_credits_target := round(p.credits_purchased * v_total / p.amount, 6);
  v_remove := greatest(v_credits_target - p.credits_refunded, 0);
  v_deduct := least(v_remove, w.available_credits);

  update public.wallets
     set available_credits = available_credits - v_deduct
   where id = w.id
   returning * into w;

  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p.user_id, w.id, 'refund', -v_deduct, w.available_credits + w.subscription_credits, p.id::text || ':' || v_total::text,
          format('Rückerstattung $%s (%s BC abgezogen%s)', v_total - p.refunded_amount, v_deduct,
                 case when v_deduct < v_remove then format(', %s BC waren schon verbraucht', v_remove - v_deduct) else '' end));

  update public.purchases
     set refunded_amount = v_total,
         credits_refunded = credits_refunded + v_remove,
         status = case when v_total >= amount then 'refunded' else 'partially_refunded' end
   where id = p.id
   returning * into p;
  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- Abo
-- ---------------------------------------------------------------------------
-- Abo-Zustand von Stripe übernehmen (nach Nachprüfung bei Stripe). Idempotent.
create or replace function public.upsert_subscription(
  p_user_id uuid,
  p_plan_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns public.subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.subscriptions;
begin
  if p_subscription_id is null or p_user_id is null then
    raise exception 'invalid_subscription' using errcode = 'P0001';
  end if;
  -- Ein Stripe-Abo gehört immer genau einem Nutzer
  select * into s from public.subscriptions where stripe_subscription_id = p_subscription_id;
  if found and s.user_id <> p_user_id then
    raise exception 'invalid_subscription' using errcode = 'P0001', detail = 'user mismatch';
  end if;
  perform public.ensure_wallet(p_user_id);
  insert into public.subscriptions (user_id, plan_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end)
  values (p_user_id, p_plan_id, p_customer_id, p_subscription_id, p_status, p_period_end, coalesce(p_cancel_at_period_end, false))
  on conflict (user_id) do update set
    plan_id = coalesce(excluded.plan_id, public.subscriptions.plan_id),
    stripe_customer_id = coalesce(excluded.stripe_customer_id, public.subscriptions.stripe_customer_id),
    stripe_subscription_id = excluded.stripe_subscription_id,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end
  returning * into s;
  return s;
end;
$$;

-- Monats-Credits gutschreiben (bei jeder bezahlten Abo-Rechnung). Rest der Vorperiode verfällt.
-- Idempotent über die Rechnungs-ID.
create or replace function public.grant_subscription_credits(
  p_user_id uuid,
  p_invoice_id text,
  p_credits numeric,
  p_period_end timestamptz
)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
begin
  if p_credits is null or p_credits <= 0 or p_invoice_id is null or p_period_end is null then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  w := public.lock_wallet(p_user_id);
  if exists (select 1 from public.wallet_transactions where transaction_type = 'subscription_grant' and reference_id = p_invoice_id) then
    return w;
  end if;
  w := public.expire_subscription_credits(w.id, 'renew:' || p_invoice_id, true);
  update public.wallets
     set subscription_credits = p_credits,
         subscription_expires_at = p_period_end,
         lifetime_purchased = lifetime_purchased + p_credits
   where id = w.id
   returning * into w;
  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p_user_id, w.id, 'subscription_grant', p_credits, w.available_credits + w.subscription_credits, p_invoice_id,
          format('Abo: %s BC bis %s', p_credits, to_char(p_period_end at time zone 'Europe/Zurich', 'DD.MM.YYYY')));
  return w;
end;
$$;

-- Abo beendet: Rest-Guthaben aus dem Abo verfällt sofort.
create or replace function public.end_subscription_credits(p_user_id uuid, p_reference text)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
begin
  w := public.lock_wallet(p_user_id);
  w := public.expire_subscription_credits(w.id, p_reference, true);
  update public.wallets set subscription_expires_at = null where id = w.id returning * into w;
  return w;
end;
$$;

-- Wallet lesen: abgelaufenes Abo-Guthaben vorher verfallen lassen, damit die Anzeige stimmt
create or replace function public.get_wallet(p_user_id uuid)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
begin
  w := public.lock_wallet(p_user_id);
  if w.subscription_credits > 0 and w.subscription_expires_at is not null and w.subscription_expires_at <= now() then
    w := public.expire_subscription_credits(w.id, 'expiry:' || w.id::text || ':' || extract(epoch from clock_timestamp())::text);
  end if;
  return w;
end;
$$;

-- Support-Korrektur: Saldo jetzt als Gesamtguthaben buchen
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
  values (p_user_id, w.id, 'adjustment', p_amount, w.available_credits + w.subscription_credits, p_reference, left(p_description, 500));
  return w;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rechte: nur service_role. Alte CHF-Funktionen stilllegen.
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.expire_subscription_credits(uuid, text, boolean)',
    'public.billing_quote(text, integer, integer, integer, jsonb)',
    'public.reserve_credits(uuid, text, text, numeric)',
    'public.release_reservation(text, text, text)',
    'public.settle_reservation(text, integer, integer, integer, jsonb)',
    'public.create_purchase(uuid, uuid)',
    'public.create_custom_purchase(uuid, numeric)',
    'public.confirm_purchase(uuid, text, text, numeric, text)',
    'public.refund_payment(text, numeric)',
    'public.upsert_subscription(uuid, uuid, text, text, text, timestamptz, boolean)',
    'public.grant_subscription_credits(uuid, text, numeric, timestamptz)',
    'public.end_subscription_credits(uuid, text)',
    'public.adjust_credits(uuid, numeric, text, text)',
    'public.get_wallet(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.complete_purchase(uuid, text, text, numeric, text)',
    'public.refund_purchase(text, numeric)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end;
$$;
