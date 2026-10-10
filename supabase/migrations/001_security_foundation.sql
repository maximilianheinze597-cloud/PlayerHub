-- PlayerHub – Migration 001: Sicherheitsgrundlage
-- ============================================================================
-- WICHTIG: Diese Migration wurde OHNE Zugriff auf die echte Datenbank geschrieben
-- und ist NICHT gegen deine Supabase-Instanz getestet. Die Tabellenspalten wurden
-- aus dem Frontend-Code abgeleitet (profiles, players, news, votes).
--
-- Vorgehen:
--   1. Supabase Dashboard -> Database -> Backups prüfen (oder Schema-Export machen).
--   2. Dieses Skript im SQL-Editor ausführen. Es läuft in einer Transaktion:
--      schlägt etwas fehl, wird nichts verändert.
--   3. Deinen Admin-Account danach prüfen (Abschnitt "Admin setzen" unten).
--
-- Was die Migration tut:
--   * entfernt claim_admin() (der Admin-Code stand öffentlich im Frontend)
--   * Rollen können nur noch serverseitig vergeben werden
--   * ersetzt ALLE bestehenden RLS-Policies auf profiles/players/news/votes
--   * schreibt cast_vote() neu (atomar, eine Stimme pro Nutzer, gültige Option)
--   * Wertebereiche für Spielerstatistiken (CHECK, NOT VALID: alte Daten bleiben)
--   * push_subscriptions (Gerät <-> Nutzer) und push_log (Versandprotokoll)
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Hilfsfunktion: ist der aktuelle Nutzer Admin? (liest die Rolle aus der DB)
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Admin-Code-Mechanismus entfernen
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_admin'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Profile: automatisch anlegen, Rolle schützen
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Profil entsteht serverseitig bei der Registrierung. Rolle ist immer 'user'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)),
    'user'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Fehlende Profile für bereits vorhandene Accounts nachziehen (überschreibt nichts).
insert into public.profiles (id, display_name, role)
select u.id,
       coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), split_part(u.email, '@', 1)),
       'user'
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- Die Rolle darf von Clients NIE geändert werden. Nur der SQL-Editor / service_role
-- (auth.uid() ist dort NULL) darf Rollen setzen.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.role := 'user';
    end if;
  elsif new.role is distinct from old.role and auth.uid() is not null then
    raise exception 'Rollen können nur serverseitig geändert werden.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_role on public.profiles;
create trigger protect_profile_role
  before insert or update on public.profiles
  for each row execute function public.protect_profile_role();

-- ---------------------------------------------------------------------------
-- 4. Alle bisherigen Policies der vier Tabellen entfernen und neu setzen
--    (Policies sind additiv: eine alte, zu großzügige Policy würde sonst weiter gelten.)
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public' and tablename in ('profiles','players','news','votes')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.players enable row level security;
alter table public.news    enable row level security;
alter table public.votes   enable row level security;

-- profiles: angemeldete Nutzer sehen Name/Rolle aller, ändern nur das eigene Profil
create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- players / news: lesen alle Angemeldeten, schreiben nur Admins
create policy players_select on public.players for select to authenticated using (true);
create policy players_admin_write on public.players
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy news_select on public.news for select to authenticated using (true);
create policy news_admin_write on public.news
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- votes: lesen alle Angemeldeten, Abstimmungen anlegen/ändern/löschen nur Admins.
-- Stimmen werden ausschließlich über cast_vote() abgegeben (security definer).
create policy votes_select on public.votes for select to authenticated using (true);
create policy votes_admin_write on public.votes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 5. cast_vote(): atomar, genau eine Stimme pro Nutzer, nur gültige Optionen
--    Annahme (aus dem Frontend): votes.votes = jsonb-Map { "<user_id>": "<option>" },
--    votes.options = Liste der Optionen (jsonb oder text[]).
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cast_vote'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create function public.cast_vote(p_vote_id text, p_option text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid text := auth.uid()::text;
  affected int;
begin
  if uid is null then
    raise exception 'Nicht angemeldet.' using errcode = '28000';
  end if;

  update public.votes v
     set votes = coalesce(v.votes, '{}'::jsonb) || jsonb_build_object(uid, p_option)
   where v.id::text = p_vote_id
     and to_jsonb(v.options) ? p_option
     and not (coalesce(v.votes, '{}'::jsonb) ? uid);

  get diagnostics affected = row_count;

  if affected = 0 then
    if not exists (select 1 from public.votes where id::text = p_vote_id) then
      raise exception 'Abstimmung nicht gefunden.';
    elsif exists (select 1 from public.votes where id::text = p_vote_id
                  and coalesce(votes, '{}'::jsonb) ? uid) then
      raise exception 'Du hast bereits abgestimmt.';
    else
      raise exception 'Ungültige Antwortoption.';
    end if;
  end if;
end $$;

revoke all on function public.cast_vote(text, text) from public;
grant execute on function public.cast_vote(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Wertebereiche für Spielerdaten (NOT VALID: bestehende Zeilen bleiben unberührt,
--    neue und geänderte Zeilen werden geprüft)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_stats_nonneg') then
    alter table public.players add constraint players_stats_nonneg check (
      coalesce(games,0) >= 0 and coalesce(goals,0) >= 0 and coalesce(assists,0) >= 0
      and coalesce(shots,0) >= 0 and coalesce(shots_on_target,0) >= 0
      and coalesce(yellow,0) >= 0 and coalesce(red,0) >= 0
      and coalesce(saves,0) >= 0 and coalesce(clean_sheets,0) >= 0
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'players_misc_range') then
    alter table public.players add constraint players_misc_range check (
      coalesce(number,0) between 0 and 99 and coalesce(age,0) between 0 and 99
    ) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Push: Geräte-Tokens und Versandprotokoll
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  token      text primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  platform   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Falls die Tabelle schon existierte: fehlende Spalten ergänzen.
alter table public.push_subscriptions add column if not exists user_id    uuid references auth.users(id) on delete cascade;
alter table public.push_subscriptions add column if not exists platform   text;
alter table public.push_subscriptions add column if not exists created_at timestamptz not null default now();
alter table public.push_subscriptions add column if not exists updated_at timestamptz not null default now();

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'push_subscriptions'
  loop
    execute format('drop policy %I on public.push_subscriptions', r.policyname);
  end loop;
end $$;

-- Nutzer sehen/löschen nur ihre eigenen Geräte. Schreiben läuft über die RPC unten.
create policy push_sub_select_own on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy push_sub_delete_own on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'save_push_subscription'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

-- Ein Token gehört immer genau einem Nutzer (z. B. nach Logout/Login auf demselben Gerät).
create function public.save_push_subscription(p_token text, p_platform text default 'web')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet.' using errcode = '28000';
  end if;
  if p_token is null or length(p_token) < 20 then
    raise exception 'Ungültiges Push-Token.';
  end if;
  insert into public.push_subscriptions (token, user_id, platform)
  values (p_token, auth.uid(), coalesce(p_platform, 'web'))
  on conflict (token) do update
    set user_id = auth.uid(), platform = excluded.platform, updated_at = now();
end $$;

revoke all on function public.save_push_subscription(text, text) from public;
grant execute on function public.save_push_subscription(text, text) to authenticated;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'remove_push_subscription'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create function public.remove_push_subscription(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_subscriptions where token = p_token and user_id = auth.uid();
$$;

revoke all on function public.remove_push_subscription(text) from public;
grant execute on function public.remove_push_subscription(text) to authenticated;

-- Protokoll: ein Eintrag pro Versandvorgang. Schreiben nur die Edge Function (service_role).
create table if not exists public.push_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  sent_by     uuid references auth.users(id) on delete set null,
  type        text,
  title       text,
  target      text,            -- 'all' oder 'self'
  attempted   int not null default 0,
  accepted    int not null default 0,   -- vom Push-Dienst (FCM) angenommen
  failed      int not null default 0,
  removed     int not null default 0,   -- ungültige Tokens entfernt
  error_codes jsonb
);

alter table public.push_log enable row level security;

do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'push_log'
  loop
    execute format('drop policy %I on public.push_log', r.policyname);
  end loop;
end $$;

create policy push_log_admin_select on public.push_log
  for select to authenticated using (public.is_admin());

commit;

-- ============================================================================
-- Admin setzen (nur im SQL-Editor ausführen, NICHT Teil der Transaktion oben):
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'DEINE-ADMIN-MAIL');
-- Prüfen:
--   select p.display_name, p.role, u.email
--   from public.profiles p join auth.users u on u.id = p.id order by p.role;
-- ============================================================================
