-- Minimaler Nachbau der Supabase-Umgebung für lokale Datenbank-Tests (nur Testzwecke).
-- Rollen anon/authenticated/service_role, Schema auth mit users und auth.uid().
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end;
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Wie bei Supabase: neue Funktionen in public sind standardmässig für alle ausführbar.
-- So prüfen die Tests, dass die Migration die Rechte wirklich entzieht.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
