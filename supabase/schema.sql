-- Identification de tournée : schéma Supabase.
-- À exécuter une fois dans « SQL Editor ». Peut être relancé sans dommage (idempotent).
-- Sécurité : la clé `anon` est publique ; TOUT repose sur les politiques RLS ci-dessous.

------------------------------------------------------------------------------
-- Profils et rôles ('contributor' par défaut, 'admin' à promouvoir via SQL)
------------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'contributor' check (role in ('contributor', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Comptes créés avant l'exécution de ce script.
insert into public.profiles (id, email) select id, email from auth.users on conflict (id) do nothing;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;

alter table public.profiles enable row level security;
drop policy if exists "profil : lecture" on public.profiles;
create policy "profil : lecture" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());
-- Aucune politique insert/update/delete : un utilisateur ne peut pas se promouvoir lui-même.
revoke insert, update, delete on public.profiles from anon, authenticated;

------------------------------------------------------------------------------
-- Plages d'adresses par tournée
------------------------------------------------------------------------------
create table if not exists public.ranges (
  id         uuid primary key default gen_random_uuid(),
  cp         text not null check (cp ~ '^[0-9]{4,5}$'),
  city       text not null default '' check (length(city) <= 80),
  street     text not null check (length(street) between 1 and 120),
  from_n     integer not null check (from_n >= 0),
  to_n       integer not null,
  tournee    text not null check (length(tournee) between 1 and 20),
  source     text not null check (source in ('table', 'learned')),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (to_n >= from_n)
);
create index if not exists ranges_cp_idx on public.ranges (cp);
create unique index if not exists ranges_unique_idx on public.ranges (source, cp, lower(street), from_n, to_n, tournee);

alter table public.ranges enable row level security;

drop policy if exists "ranges : lecture" on public.ranges;
create policy "ranges : lecture" on public.ranges for select to authenticated using (true);

-- Tout facteur connecté peut ajouter une plage « learned » à son nom ; seul un admin ajoute au tableau de base.
drop policy if exists "ranges : ajout" on public.ranges;
create policy "ranges : ajout" on public.ranges for insert to authenticated
  with check (
    public.is_admin()
    or (source = 'learned' and created_by = (select auth.uid()))
  );

drop policy if exists "ranges : modification" on public.ranges;
create policy "ranges : modification" on public.ranges for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Suppression : admin partout ; un facteur ne supprime que ses propres ajouts « learned ».
drop policy if exists "ranges : suppression" on public.ranges;
create policy "ranges : suppression" on public.ranges for delete to authenticated
  using (public.is_admin() or (source = 'learned' and created_by = (select auth.uid())));

------------------------------------------------------------------------------
-- Localités (code postal + nom)
------------------------------------------------------------------------------
create table if not exists public.localities (
  cp   text not null check (cp ~ '^[0-9]{4,5}$'),
  city text not null check (length(city) between 1 and 80),
  primary key (cp, city)
);
alter table public.localities enable row level security;
drop policy if exists "localities : lecture" on public.localities;
create policy "localities : lecture" on public.localities for select to authenticated using (true);
drop policy if exists "localities : admin" on public.localities;
create policy "localities : admin" on public.localities for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

------------------------------------------------------------------------------
-- Historique des scans (optionnel, privé, SANS photo). L'application ne l'alimente pas par défaut.
------------------------------------------------------------------------------
create table if not exists public.scans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  cp         text, city text, street text, num integer,
  tournee    text, score real,
  created_at timestamptz not null default now()
);
alter table public.scans enable row level security;
drop policy if exists "scans : propriétaire" on public.scans;
create policy "scans : propriétaire" on public.scans for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

------------------------------------------------------------------------------
-- Remplacement atomique du tableau de base (administrateurs uniquement)
------------------------------------------------------------------------------
create or replace function public.replace_table(p_ranges jsonb, p_localities jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs' using errcode = '42501';
  end if;

  delete from public.ranges where source = 'table';
  insert into public.ranges (cp, city, street, from_n, to_n, tournee, source, created_by)
    select r.cp, coalesce(r.city, ''), r.street, r.from_n, r.to_n, r.tournee, 'table', (select auth.uid())
    from jsonb_to_recordset(coalesce(p_ranges, '[]'::jsonb))
      as r(cp text, city text, street text, from_n int, to_n int, tournee text)
    on conflict do nothing;

  delete from public.localities where true;
  insert into public.localities (cp, city)
    select l.cp, l.city from jsonb_to_recordset(coalesce(p_localities, '[]'::jsonb)) as l(cp text, city text)
    on conflict do nothing;
end $$;
revoke all on function public.replace_table(jsonb, jsonb) from public, anon;
grant execute on function public.replace_table(jsonb, jsonb) to authenticated;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

------------------------------------------------------------------------------
-- Temps réel
------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ranges') then
    alter publication supabase_realtime add table public.ranges;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'localities') then
    alter publication supabase_realtime add table public.localities;
  end if;
end $$;

------------------------------------------------------------------------------
-- Premier administrateur (à lancer APRÈS la première connexion de la personne) :
--   update public.profiles set role = 'admin' where email = 'vous@exemple.be';
------------------------------------------------------------------------------
