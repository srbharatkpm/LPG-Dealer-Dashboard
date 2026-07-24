-- LPG Dealer Accounts (SR Bharat Gas, Kammapuram) — Supabase schema
-- Run this once, in full, in the Supabase SQL editor of a FRESH project
-- (not shared with any other app). Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE.

create extension if not exists pgcrypto;

-- =========================================================
-- 1. profiles — one row per signed-in user, carries their role
-- =========================================================
-- Role is self-declared at signup (see js/cloud.js). This is a small,
-- single-location business where the owner hands out the sign-up link/
-- credentials directly, so self-declared role is an acceptable trust
-- boundary for now. If this ever needs hardening (untrusted signups),
-- switch to an owner-only invite edge function instead of open signup.
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('accounts', 'godown', 'driver')),
  full_name   text not null,
  phone       text,
  vehicle_number text,   -- drivers: the vehicle they usually run
  line        text,      -- drivers: usual delivery line/route
  created_at  timestamptz not null default now()
);

alter table profiles enable row level security;

-- security definer helper so RLS policies can read the caller's own role
-- without recursing into profiles' own RLS.
create or replace function current_role_name()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from profiles where id = auth.uid();
$$;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select
  using (id = auth.uid() or current_role_name() = 'accounts');

drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles for insert
  with check (id = auth.uid());

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update
  using (id = auth.uid() or current_role_name() = 'accounts');

-- =========================================================
-- 2. delivery_trips / delivery_entries — Delivery Boy form
-- =========================================================
create table if not exists delivery_trips (
  id            uuid primary key default gen_random_uuid(),
  driver_id     uuid not null references profiles(id),
  driver_name   text not null,
  vehicle_number text not null,
  line          text,
  trip_date     date not null default current_date,
  starting_kms  numeric,
  ending_kms    numeric,
  created_at    timestamptz not null default now()
);

alter table delivery_trips enable row level security;

drop policy if exists delivery_trips_select on delivery_trips;
create policy delivery_trips_select on delivery_trips for select
  using (driver_id = auth.uid() or current_role_name() = 'accounts');

drop policy if exists delivery_trips_insert on delivery_trips;
create policy delivery_trips_insert on delivery_trips for insert
  with check (driver_id = auth.uid() and current_role_name() = 'driver');

drop policy if exists delivery_trips_update on delivery_trips;
create policy delivery_trips_update on delivery_trips for update
  using (driver_id = auth.uid() or current_role_name() = 'accounts');

create table if not exists delivery_entries (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references delivery_trips(id) on delete cascade,
  s_no          int,
  consumer_no   text,
  consumer_name text,
  phone_no      text,
  bio_metric    text,
  safety_check  text,
  otp           text,
  amount        numeric not null default 0,
  created_at    timestamptz not null default now()
);

alter table delivery_entries enable row level security;

drop policy if exists delivery_entries_select on delivery_entries;
create policy delivery_entries_select on delivery_entries for select
  using (
    current_role_name() = 'accounts'
    or exists (select 1 from delivery_trips t where t.id = trip_id and t.driver_id = auth.uid())
  );

drop policy if exists delivery_entries_insert on delivery_entries;
create policy delivery_entries_insert on delivery_entries for insert
  with check (
    exists (select 1 from delivery_trips t where t.id = trip_id and t.driver_id = auth.uid())
  );

drop policy if exists delivery_entries_update on delivery_entries;
create policy delivery_entries_update on delivery_entries for update
  using (
    current_role_name() = 'accounts'
    or exists (select 1 from delivery_trips t where t.id = trip_id and t.driver_id = auth.uid())
  );

drop policy if exists delivery_entries_delete on delivery_entries;
create policy delivery_entries_delete on delivery_entries for delete
  using (
    current_role_name() = 'accounts'
    or exists (select 1 from delivery_trips t where t.id = trip_id and t.driver_id = auth.uid())
  );

-- =========================================================
-- 3. godown_* — Godown Incharge form
-- =========================================================
create table if not exists godown_stock (
  id             uuid primary key default gen_random_uuid(),
  entry_date     date not null default current_date,
  product        text not null,
  total_upload   numeric not null default 0,
  sv_load        numeric not null default 0,
  sv_empty       numeric not null default 0,
  return_load    numeric not null default 0,
  return_empty   numeric not null default 0,
  delivered_load numeric not null default 0,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  unique (entry_date, product)
);

create table if not exists godown_vehicle_sales (
  id             uuid primary key default gen_random_uuid(),
  entry_date     date not null default current_date,
  vehicle_number text not null,
  product        text not null,
  qty            numeric not null default 0,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  unique (entry_date, vehicle_number, product)
);

create table if not exists godown_debits (
  id                uuid primary key default gen_random_uuid(),
  entry_date        date not null unique,
  diesel_expenses   numeric not null default 0,
  refill_commission numeric not null default 0,
  online_payment    numeric not null default 0,
  gpay_payment      numeric not null default 0,
  local_expenses    numeric not null default 0,
  vehicle_expenses  numeric not null default 0,
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now()
);

create table if not exists godown_cash_count (
  id                 uuid primary key default gen_random_uuid(),
  entry_date         date not null unique,
  note_500 int not null default 0, note_200 int not null default 0,
  note_100 int not null default 0, note_50  int not null default 0,
  note_20  int not null default 0, note_10  int not null default 0,
  coin_10  int not null default 0, coin_5   int not null default 0,
  coin_2   int not null default 0, coin_1   int not null default 0,
  godown_incharge_name text,
  cash_confirmed_by    text,
  driver_sign          text,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

alter table godown_stock enable row level security;
alter table godown_vehicle_sales enable row level security;
alter table godown_debits enable row level security;
alter table godown_cash_count enable row level security;

do $$
declare t text;
begin
  foreach t in array array['godown_stock','godown_vehicle_sales','godown_debits','godown_cash_count']
  loop
    execute format('drop policy if exists %I_select on %I', t, t);
    execute format($p$create policy %I_select on %I for select
      using (current_role_name() in ('godown','accounts'))$p$, t, t);

    execute format('drop policy if exists %I_insert on %I', t, t);
    execute format($p$create policy %I_insert on %I for insert
      with check (current_role_name() = 'godown')$p$, t, t);

    execute format('drop policy if exists %I_update on %I', t, t);
    execute format($p$create policy %I_update on %I for update
      using (current_role_name() in ('godown','accounts'))$p$, t, t);

    execute format('drop policy if exists %I_delete on %I', t, t);
    execute format($p$create policy %I_delete on %I for delete
      using (current_role_name() = 'accounts')$p$, t, t);
  end loop;
end $$;

-- =========================================================
-- 3b. product_rates — accounts office sets ₹ rate per cylinder/product,
--     used to turn the godown's vehicle-sales quantities into ₹ amounts.
--     (On the paper form this rate is left blank for the office to fill in.)
-- =========================================================
create table if not exists product_rates (
  product     text primary key,
  rate        numeric not null default 0,
  updated_at  timestamptz not null default now()
);

alter table product_rates enable row level security;

drop policy if exists product_rates_select on product_rates;
create policy product_rates_select on product_rates for select
  using (auth.uid() is not null);

drop policy if exists product_rates_write on product_rates;
create policy product_rates_write on product_rates for all
  using (current_role_name() = 'accounts')
  with check (current_role_name() = 'accounts');

-- =========================================================
-- 4. accounts_daily — office-only manual figures (bank deposit,
--    salary/advance, admin & other expenses, opening balance, notes)
--    that only the accounts office knows and aren't captured by the
--    other two forms.
-- =========================================================
create table if not exists accounts_daily (
  id                    uuid primary key default gen_random_uuid(),
  entry_date            date not null unique,
  opening_amount        numeric not null default 0,
  salary_advance        numeric not null default 0,
  admin_other_purchase  numeric not null default 0,
  other_expenses        numeric not null default 0,
  bank_deposit          numeric not null default 0,
  notes                 text,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table accounts_daily enable row level security;

drop policy if exists accounts_daily_all on accounts_daily;
create policy accounts_daily_all on accounts_daily for all
  using (current_role_name() = 'accounts')
  with check (current_role_name() = 'accounts');
