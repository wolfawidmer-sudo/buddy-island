-- Startguthaben für neue Konten (einmalig).
-- Pro Person und PC nur einmal: gesperrt wird über Konto, normalisierte E-Mail und PC-Kennung.
-- Gespeichert werden nur HMAC-Werte (keine E-Mail, keine PC-Kennung, keine IP im Klartext).
-- Die Einträge bleiben, auch wenn das Konto gelöscht wird (user_id wird dann leer),
-- sonst könnte man das Konto löschen und neu anlegen.

create table public.welcome_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  email_hash text not null unique check (char_length(email_hash) = 64),
  device_hash text not null unique check (char_length(device_hash) = 64),
  ip_hash text check (ip_hash is null or char_length(ip_hash) = 64),
  amount numeric(20, 6) not null check (amount > 0),
  created_at timestamptz not null default now()
);
create index welcome_grants_ip_created_idx on public.welcome_grants (ip_hash, created_at desc);

alter table public.welcome_grants enable row level security;
revoke all on public.welcome_grants from anon, authenticated;

-- Ergebnis: { granted: bool, reason: 'granted'|'account'|'email'|'device'|'ip', amount }
create or replace function public.grant_welcome_credits(
  p_user_id uuid,
  p_email_hash text,
  p_device_hash text,
  p_ip_hash text,
  p_amount numeric,
  p_ip_daily_limit integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.wallets;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  -- Gleichzeitige Anfragen derselben Person nacheinander abarbeiten
  w := public.lock_wallet(p_user_id);
  perform pg_advisory_xact_lock(hashtext('welcome:' || p_email_hash));
  perform pg_advisory_xact_lock(hashtext('welcome:' || p_device_hash));

  if exists (select 1 from public.welcome_grants where user_id = p_user_id) then
    return jsonb_build_object('granted', false, 'reason', 'account');
  end if;
  if exists (select 1 from public.welcome_grants where email_hash = p_email_hash) then
    return jsonb_build_object('granted', false, 'reason', 'email');
  end if;
  if exists (select 1 from public.welcome_grants where device_hash = p_device_hash) then
    return jsonb_build_object('granted', false, 'reason', 'device');
  end if;
  if p_ip_hash is not null and (
    select count(*) from public.welcome_grants where ip_hash = p_ip_hash and created_at > now() - interval '1 day'
  ) >= p_ip_daily_limit then
    return jsonb_build_object('granted', false, 'reason', 'ip');
  end if;

  insert into public.welcome_grants (user_id, email_hash, device_hash, ip_hash, amount)
  values (p_user_id, p_email_hash, p_device_hash, p_ip_hash, p_amount);
  update public.wallets set available_credits = available_credits + p_amount where id = w.id returning * into w;
  insert into public.wallet_transactions (user_id, wallet_id, transaction_type, amount, balance_after, reference_id, description)
  values (p_user_id, w.id, 'adjustment', p_amount, w.available_credits + w.subscription_credits, 'welcome:' || p_user_id::text, 'Startguthaben');
  return jsonb_build_object('granted', true, 'reason', 'granted', 'amount', p_amount);
end;
$$;

revoke all on function public.grant_welcome_credits(uuid, text, text, text, numeric, integer) from public, anon, authenticated;
grant execute on function public.grant_welcome_credits(uuid, text, text, text, numeric, integer) to service_role;
