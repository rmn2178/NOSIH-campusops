-- NOSIH Supabase foundation: extensions, native columns, clock, helpers.
-- Schema keeps the existing integer primary keys so the seeded campus and the
-- operational engines stay compatible.

create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- Auth linkage ---------------------------------------------------------------
alter table public.users add column if not exists auth_user_id uuid;
create unique index if not exists users_auth_user_id_key
  on public.users (auth_user_id) where auth_user_id is not null;

-- Complaint intelligence -----------------------------------------------------
alter table public.complaints add column if not exists embedding extensions.vector(384);
alter table public.complaints add column if not exists suggested_rewrite text;
alter table public.complaints add column if not exists required_risk_clearance varchar(30) not null default 'STANDARD';

create index if not exists complaints_embedding_hnsw
  on public.complaints using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;
create index if not exists complaints_description_trgm
  on public.complaints using gin (description extensions.gin_trgm_ops);
create index if not exists complaints_title_trgm
  on public.complaints using gin (title extensions.gin_trgm_ops);

-- Locks ----------------------------------------------------------------------
alter table public.resource_locks add column if not exists holder_email varchar(200);
create index if not exists resource_locks_expires_idx on public.resource_locks (expires_at);

-- Identity vault -------------------------------------------------------------
alter table public.identity_vault add column if not exists encrypted_identity_bytea bytea;
alter table public.identity_vault add column if not exists unsealed_by_email varchar(200);
alter table public.identity_vault add column if not exists unseal_reason text;

-- Campus clock ---------------------------------------------------------------
create table if not exists public.campus_clock_state (
  id integer primary key default 1 check (id = 1),
  active_day varchar(3) not null default 'MON',
  active_period integer not null default 3,
  period_elapsed_mins integer not null default 18,
  period_duration_mins integer not null default 50,
  clock_mode varchar(20) not null default 'LIVE',
  speed_multiplier integer not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.campus_clock_state (id) values (1) on conflict (id) do nothing;

-- Helpers --------------------------------------------------------------------
-- Matches Python datetime.isoformat(): microseconds are omitted when zero.
create or replace function public.nosih_timestamp_text(ts timestamptz)
returns text
language sql
immutable
as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')
    || case
         when (extract(microseconds from ts at time zone 'UTC')::bigint % 1000000) <> 0
         then '.' || lpad((extract(microseconds from ts at time zone 'UTC')::bigint % 1000000)::text, 6, '0')
         else ''
       end
    || '+00:00'
$$;

create or replace function public.current_app_user_id()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('MAINTENANCE', 'INCIDENT_MANAGER', 'FACILITIES_ADMIN', 'PROCUREMENT_APPROVER', 'SYSTEM_ADMIN')
       from public.users where auth_user_id = auth.uid() limit 1),
    false
  )
$$;

-- Resolve the authoritative role of an actor by email. Never trust a role
-- string supplied by a browser.
create or replace function public.nosih_actor_role(p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users
  where lower(email) = lower(coalesce(p_email, '')) and is_active
  limit 1
$$;

create or replace function public.nosih_actor_id(p_email text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users
  where lower(email) = lower(coalesce(p_email, '')) and is_active
  limit 1
$$;
