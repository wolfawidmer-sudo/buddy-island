-- Buddy Island Cloud: Konten, Guthaben (Buddy Credits), Käufe, Nutzung, Preise.
--
-- Grundsätze
-- * Geldbeträge und Credits nur als numeric (exakt), nie als float.
-- * Nutzer dürfen ihre Daten lesen, aber nie Guthaben oder Buchungen schreiben.
--   Alle Geldvorgänge laufen über die Funktionen in der nächsten Migration, die nur
--   die Rolle service_role (Backend) ausführen darf.
-- * Buchungen (wallet_transactions) sind unveränderlich: UPDATE/DELETE wird per Trigger abgelehnt.

-- ---------------------------------------------------------------------------
-- Hilfsfunktion: updated_at pflegen
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  avatar_url text check (avatar_url is null or (char_length(avatar_url) <= 500 and avatar_url ~* '^https://')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- wallets (genau eine pro Nutzer)
-- ---------------------------------------------------------------------------
create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  available_credits numeric(20, 6) not null default 0 check (available_credits >= 0),
  reserved_credits numeric(20, 6) not null default 0 check (reserved_credits >= 0),
  lifetime_purchased numeric(20, 6) not null default 0 check (lifetime_purchased >= 0),
  lifetime_consumed numeric(20, 6) not null default 0 check (lifetime_consumed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger wallets_updated_at before update on public.wallets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- wallet_transactions (unveränderliches Journal)
-- amount: Veränderung von available_credits (negativ = Abbuchung/Reservierung)
-- ---------------------------------------------------------------------------
create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  transaction_type text not null check (transaction_type in (
    'purchase', 'reservation', 'reservation_release', 'usage', 'refund', 'adjustment'
  )),
  amount numeric(20, 6) not null,
  balance_after numeric(20, 6) not null check (balance_after >= 0),
  reference_id text not null check (char_length(reference_id) between 1 and 200),
  description text check (description is null or char_length(description) <= 500),
  created_at timestamptz not null default now(),
  -- Idempotenz: dieselbe Buchung (Art + Referenz) kann es nur einmal geben
  constraint wallet_transactions_idempotent unique (transaction_type, reference_id)
);
create index wallet_transactions_user_created_idx on public.wallet_transactions (user_id, created_at desc);
create index wallet_transactions_wallet_idx on public.wallet_transactions (wallet_id);

create or replace function public.reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'immutable_record' using errcode = 'P0001',
    detail = format('%s darf nicht geändert oder gelöscht werden', tg_table_name);
end;
$$;
create trigger wallet_transactions_immutable before update or delete on public.wallet_transactions
  for each row execute function public.reject_change();

-- ---------------------------------------------------------------------------
-- credit_packages (öffentlich lesbar, wenn aktiv)
-- ---------------------------------------------------------------------------
create table public.credit_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  price_chf numeric(10, 2) not null check (price_chf > 0),
  credits numeric(20, 6) not null check (credits > 0),
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index credit_packages_active_idx on public.credit_packages (active, display_order);

-- ---------------------------------------------------------------------------
-- purchases
-- ---------------------------------------------------------------------------
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  package_id uuid references public.credit_packages (id) on delete set null,
  provider_checkout_id text unique,
  provider_payment_id text unique,
  amount_chf numeric(10, 2) not null check (amount_chf > 0),
  credits_purchased numeric(20, 6) not null check (credits_purchased > 0),
  refunded_chf numeric(10, 2) not null default 0 check (refunded_chf >= 0),
  credits_refunded numeric(20, 6) not null default 0 check (credits_refunded >= 0),
  status text not null default 'pending' check (status in (
    'pending', 'completed', 'failed', 'expired', 'refunded', 'partially_refunded'
  )),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint purchases_refund_le_amount check (refunded_chf <= amount_chf)
);
create index purchases_user_created_idx on public.purchases (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- model_pricing (Anbieterpreise; nur Backend liest sie)
-- Preise je 1 Million Tokens in pricing_currency.
-- audio_pricing: {"input_per_1m": n, "output_per_1m": n, "transcription_per_minute": n}
-- ---------------------------------------------------------------------------
create table public.model_pricing (
  id uuid primary key default gen_random_uuid(),
  model_id text not null check (char_length(model_id) between 1 and 100),
  input_price numeric(14, 6) not null check (input_price >= 0),
  output_price numeric(14, 6) not null check (output_price >= 0),
  cached_input_price numeric(14, 6) check (cached_input_price is null or cached_input_price >= 0),
  audio_pricing jsonb,
  pricing_currency text not null default 'USD' check (pricing_currency = 'USD'),
  effective_from timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint model_pricing_unique unique (model_id, effective_from)
);
create index model_pricing_lookup_idx on public.model_pricing (model_id, active, effective_from desc);

-- ---------------------------------------------------------------------------
-- billing_settings (genau eine Zeile; zentrale Umrechnung)
-- usd_to_chf und credits_per_chf sind absichtlich NULL: Wolf entscheidet.
-- Solange sie fehlen, lehnen die Abrechnungsfunktionen ab (billing_not_configured).
-- ---------------------------------------------------------------------------
create table public.billing_settings (
  id boolean primary key default true check (id),
  markup_rate numeric(6, 4) not null default 0.10 check (markup_rate >= 0 and markup_rate < 5),
  usd_to_chf numeric(12, 6) check (usd_to_chf is null or usd_to_chf > 0),
  credits_per_chf numeric(14, 6) check (credits_per_chf is null or credits_per_chf > 0),
  reservation_ttl_seconds integer not null default 900 check (reservation_ttl_seconds between 30 and 86400),
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id) values (true);
create trigger billing_settings_updated_at before update on public.billing_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- credit_reservations (offene Reservierungen je Cloud-Anfrage)
-- ---------------------------------------------------------------------------
create table public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  request_id text not null unique check (char_length(request_id) between 8 and 100),
  model text not null,
  amount numeric(20, 6) not null check (amount > 0),
  status text not null default 'active' check (status in ('active', 'settled', 'released')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index credit_reservations_active_idx on public.credit_reservations (status, expires_at) where status = 'active';
create index credit_reservations_user_idx on public.credit_reservations (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- usage_events (eine Zeile je abgerechneter oder abgebrochener Cloud-Anfrage)
-- Kosten in USD (Anbieter), Credits in BC.
-- ---------------------------------------------------------------------------
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id text not null unique,
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cached_tokens integer not null default 0 check (cached_tokens >= 0),
  audio_usage jsonb,
  provider_cost numeric(18, 8) not null default 0 check (provider_cost >= 0),
  markup_amount numeric(18, 8) not null default 0 check (markup_amount >= 0),
  total_cost numeric(18, 8) not null default 0 check (total_cost >= 0),
  credits_charged numeric(20, 6) not null default 0 check (credits_charged >= 0),
  status text not null check (status in ('settled', 'partial', 'released', 'failed')),
  created_at timestamptz not null default now()
);
create index usage_events_user_created_idx on public.usage_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.credit_packages enable row level security;
alter table public.purchases enable row level security;
alter table public.model_pricing enable row level security;
alter table public.billing_settings enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.usage_events enable row level security;

-- Grundrechte: Clients (anon/authenticated) dürfen nichts schreiben ausser zwei Profilfeldern.
revoke all on public.profiles, public.wallets, public.wallet_transactions, public.credit_packages,
  public.purchases, public.model_pricing, public.billing_settings, public.credit_reservations,
  public.usage_events from anon, authenticated;

grant select on public.profiles, public.wallets, public.wallet_transactions, public.purchases,
  public.usage_events to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
grant select on public.credit_packages to anon, authenticated;
-- model_pricing, billing_settings, credit_reservations: kein Zugriff für Clients

create policy "profiles: eigenes lesen" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles: eigenes ändern" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "wallets: eigenes lesen" on public.wallets
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "wallet_transactions: eigene lesen" on public.wallet_transactions
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "purchases: eigene lesen" on public.purchases
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "usage_events: eigene lesen" on public.usage_events
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "credit_packages: aktive lesen" on public.credit_packages
  for select to anon, authenticated using (active);
