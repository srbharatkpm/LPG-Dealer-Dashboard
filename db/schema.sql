-- LPG Dealer Accounts (SR Bharat Gas, Kammapuram) — Supabase schema
-- Run this once, in full, in the Supabase SQL editor of a FRESH project
-- (not shared with any other app). Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE.

create extension if not exists pgcrypto;

-- =========================================================
-- 1. profiles — one row per signed-in user, carries their role
-- =========================================================
-- Roles are NEVER self-assigned. The app is served from a public URL,
-- so anything the signup form sends is untrusted: the role is decided
-- entirely by the bootstrap_first_owner() trigger below, and can only
-- be changed afterwards by an owner.
--
-- Roles:
--   owner    - full access to everything, incl. P&L, and can change anyone's role
--   manager  - daily accounts, stock, delivery, targets (no P&L view)
--   accounts - ledger/bookkeeping only
--   staff    - godown incharge: stock, vehicle sales, debits, cash count
--   driver   - delivery boy: trip sheet
--   pending  - signed up, no access to anything yet, awaiting the owner
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'manager', 'accounts', 'staff', 'driver', 'pending')),
  full_name   text not null,
  phone       text,
  vehicle_number text,   -- drivers: the vehicle they usually run
  line        text,      -- drivers: usual delivery line/route
  created_at  timestamptz not null default now()
);

alter table profiles enable row level security;

-- security definer helpers so RLS policies can read the caller's own role
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

-- owner/manager/accounts: can see and edit the day-to-day ledger
create or replace function is_office_role()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select current_role_name() in ('owner', 'manager', 'accounts');
$$;

-- owner/manager: operational oversight (stock, delivery, targets) minus P&L
create or replace function is_ops_role()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select current_role_name() in ('owner', 'manager');
$$;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select
  using (id = auth.uid() or is_office_role());

drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles for insert
  with check (id = auth.uid());

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update
  using (id = auth.uid() or current_role_name() = 'owner');

-- Widen the role check for databases created before 'pending' existed.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('owner', 'manager', 'accounts', 'staff', 'driver', 'pending'));

-- The signup form is on the public internet, so whatever role it submits
-- is ignored: the very first profile in the database becomes the owner
-- (bootstrapping the business), and every later signup lands on 'pending'
-- with no access until the owner assigns them one from the Team tab.
create or replace function bootstrap_first_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Rows created by the owner through the create-team-user edge function
  -- arrive as service_role and already carry their intended role, so let
  -- them through — except that owner is never handed out this way.
  if current_user = 'service_role' then
    if new.role = 'owner' then new.role := 'pending'; end if;
    return new;
  end if;

  if not exists (select 1 from profiles) then
    new.role := 'owner';
  else
    new.role := 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_bootstrap on profiles;
create trigger profiles_bootstrap
  before insert on profiles
  for each row execute function bootstrap_first_owner();

-- profiles_update lets a user edit their own row (name, phone, etc.),
-- which on its own would let anyone set their own role to 'owner'.
-- Role changes specifically are owner-only.
create or replace function enforce_role_change_by_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_user = 'service_role' then return new; end if;

  if new.role is distinct from old.role then
    if current_role_name() not in ('owner', 'manager') then
      raise exception 'Only the owner or a manager can change a role';
    end if;
    -- a manager may manage everyone except the owner account itself,
    -- so they cannot demote the owner and take over
    if old.role = 'owner' and current_role_name() <> 'owner' then
      raise exception 'The owner account can only be changed by the owner';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_role_guard on profiles;
create trigger profiles_role_guard
  before update on profiles
  for each row execute function enforce_role_change_by_owner();

-- =========================================================
-- 2. delivery_trips / delivery_entries — Delivery Boy trip sheet
-- =========================================================
create table if not exists delivery_trips (
  id              uuid primary key default gen_random_uuid(),
  driver_id       uuid not null references profiles(id),
  driver_name     text not null,
  vehicle_number  text not null,
  line            text,
  trip_date       date not null default current_date,
  starting_kms    numeric,
  ending_kms      numeric,

  -- uplift (what the driver loaded at the godown before heading out)
  total_uplifted  numeric not null default 0,
  uplift_time     text,          -- 'HH:MM', kept as text to avoid timezone fuss
  product         text,          -- main cylinder product carried this trip
  rate            numeric not null default 0,  -- ₹ per unit, snapshot from product_rates

  -- cash denomination count for what the driver collected/handed back
  note_500 int not null default 0, note_200 int not null default 0,
  note_100 int not null default 0, note_50  int not null default 0,
  note_20  int not null default 0, note_10  int not null default 0,
  coin_10  int not null default 0, coin_5   int not null default 0,
  coin_2   int not null default 0, coin_1   int not null default 0,
  total_paid_to_accounts numeric not null default 0,

  created_at      timestamptz not null default now()
);

alter table delivery_trips enable row level security;

drop policy if exists delivery_trips_select on delivery_trips;
create policy delivery_trips_select on delivery_trips for select
  using (driver_id = auth.uid() or is_office_role() or is_ops_role());

drop policy if exists delivery_trips_insert on delivery_trips;
create policy delivery_trips_insert on delivery_trips for insert
  with check (driver_id = auth.uid() and current_role_name() = 'driver');

drop policy if exists delivery_trips_update on delivery_trips;
create policy delivery_trips_update on delivery_trips for update
  using (driver_id = auth.uid() or is_office_role() or is_ops_role());

drop policy if exists delivery_trips_delete on delivery_trips;
create policy delivery_trips_delete on delivery_trips for delete
  using (driver_id = auth.uid() or is_office_role());

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
  delivered_qty numeric not null default 1,
  return_qty    numeric not null default 0,
  amount        numeric not null default 0,   -- incidental/COD amount, not the standard cylinder price
  created_at    timestamptz not null default now()
);

alter table delivery_entries enable row level security;

drop policy if exists delivery_entries_select on delivery_entries;
create policy delivery_entries_select on delivery_entries for select
  using (
    is_office_role() or is_ops_role()
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
    is_office_role() or is_ops_role()
    or exists (select 1 from delivery_trips t where t.id = trip_id and t.driver_id = auth.uid())
  );

drop policy if exists delivery_entries_delete on delivery_entries;
create policy delivery_entries_delete on delivery_entries for delete
  using (
    is_office_role() or is_ops_role()
    or exists (select 1 from delivery_trips t where t.id = trip_id and t.driver_id = auth.uid())
  );

-- =========================================================
-- 3. godown_stock — Staff (Godown Incharge): per product/condition qty
-- =========================================================
-- One row per (date, product, condition). "condition" lets each product
-- track whatever states actually apply to it:
--   cylinders (14.2kg/19kg/5kg)  -> 'full', 'empty'
--   DPR / Regulator              -> 'sound', 'defective'
--   accessories (hose, lighter, book, stove) -> 'qty' (single bucket)
create table if not exists godown_stock (
  id             uuid primary key default gen_random_uuid(),
  entry_date     date not null default current_date,
  product        text not null,
  condition      text not null default 'qty' check (condition in ('full', 'empty', 'sound', 'defective', 'qty')),
  quantity       numeric not null default 0,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  unique (entry_date, product, condition)
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
      using (current_role_name() = 'staff' or is_office_role() or is_ops_role())$p$, t, t);

    execute format('drop policy if exists %I_insert on %I', t, t);
    -- accounts included: approving a driver sheet writes the resulting
    -- stock movement into godown_stock on the office's behalf
    execute format($p$create policy %I_insert on %I for insert
      with check (current_role_name() = 'staff' or is_office_role())$p$, t, t);

    execute format('drop policy if exists %I_update on %I', t, t);
    execute format($p$create policy %I_update on %I for update
      using (current_role_name() = 'staff' or is_office_role() or is_ops_role())$p$, t, t);

    execute format('drop policy if exists %I_delete on %I', t, t);
    execute format($p$create policy %I_delete on %I for delete
      using (current_role_name() in ('owner', 'manager', 'staff'))$p$, t, t);
  end loop;
end $$;

-- =========================================================
-- 3b. product_rates — office sets ₹ rate per cylinder/product,
--     used to turn quantities into ₹ amounts.
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
  using (is_office_role())
  with check (is_office_role());

-- =========================================================
-- 3c. sales_targets — Owner/Manager set a ₹ sales target per period
-- =========================================================
create table if not exists sales_targets (
  id            uuid primary key default gen_random_uuid(),
  period_type   text not null check (period_type in ('daily', 'monthly')),
  period_start  date not null,
  target_amount numeric not null default 0,
  notes         text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (period_type, period_start)
);

alter table sales_targets enable row level security;

drop policy if exists sales_targets_select on sales_targets;
create policy sales_targets_select on sales_targets for select
  using (is_office_role() or is_ops_role());

drop policy if exists sales_targets_write on sales_targets;
create policy sales_targets_write on sales_targets for all
  using (is_ops_role())
  with check (is_ops_role());

-- =========================================================
-- 3d. credit_customers / credit_transactions — customers who buy on
--     credit (pay later). Balance owed = sum(sale amounts) - sum(payments).
-- =========================================================
create table if not exists credit_customers (
  id           uuid primary key default gen_random_uuid(),
  consumer_no  text,
  name         text not null,
  phone        text,
  address      text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);

create table if not exists credit_transactions (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references credit_customers(id) on delete cascade,
  entry_date    date not null default current_date,
  type          text not null check (type in ('sale', 'payment')),
  product       text,
  qty           numeric,
  amount        numeric not null default 0,
  notes         text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

alter table credit_customers enable row level security;
alter table credit_transactions enable row level security;

drop policy if exists credit_customers_all on credit_customers;
create policy credit_customers_all on credit_customers for all
  using (is_office_role())
  with check (is_office_role());

drop policy if exists credit_transactions_all on credit_transactions;
create policy credit_transactions_all on credit_transactions for all
  using (is_office_role())
  with check (is_office_role());

-- =========================================================
-- 4. accounts_daily — office-only manual figures (bank deposit,
--    salary/advance, admin & other expenses, opening balance, notes)
--    that aren't captured by the other forms. Owner/Manager/Accounts
--    can all edit; P&L (derived from this + everything else) is
--    computed client-side and shown only to Owner.
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
  using (is_office_role())
  with check (is_office_role());

-- =========================================================
-- 5. customers — master contact list (imported from file, or grown
--    from consumer_no/name/phone_no already typed into delivery
--    entries), used as the audience for WhatsApp broadcasts.
-- =========================================================
create table if not exists customers (
  id           uuid primary key default gen_random_uuid(),
  consumer_no  text,
  name         text not null,
  phone        text not null default '',  -- E.164 without '+', e.g. 91XXXXXXXXXX; may be blank in BPCL data
  line         text,
  address      text,
  opted_out    boolean not null default false,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);

-- BPCL eConnect "List Of Consumers" fields. Identity for imports is the
-- BPCL consumer number, NOT the phone — in the real export thousands of
-- consumers share a family phone or have none at all.
alter table customers add column if not exists alt_phone text;
alter table customers add column if not exists category text;          -- Domestic / Commercial
alter table customers add column if not exists last_delivery date;
alter table customers add column if not exists subsidy_elig int;       -- quota eligible this year
alter table customers add column if not exists subsidy_delv int;       -- quota delivered this year
alter table customers add column if not exists kyc_done boolean;
alter table customers add column if not exists no_of_cylinders int;
alter table customers add column if not exists blue_book text;

-- older databases had unique(phone); the BPCL master breaks that
alter table customers drop constraint if exists customers_phone_key;
create unique index if not exists customers_consumer_no_key
  on customers (consumer_no) where consumer_no is not null and consumer_no <> '';

-- set true by importing the eConnect "EKYC Pending Customers" report;
-- cleared per-customer from the Follow-ups page once their eKYC is done
alter table customers add column if not exists ekyc_pending boolean not null default false;

-- =========================================================
-- 5b. followup_logs — office staff call log against consumers
--     (refill chase + eKYC chase). One row per call/contact attempt.
-- =========================================================
create table if not exists followup_logs (
  id           uuid primary key default gen_random_uuid(),
  consumer_no  text not null,
  followup_type text not null default 'refill' check (followup_type in ('refill', 'ekyc')),
  entry_date   date not null default current_date,
  outcome      text not null check (outcome in ('booked', 'no_answer', 'call_later', 'not_interested', 'done')),
  notes        text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);

alter table followup_logs enable row level security;

drop policy if exists followup_logs_all on followup_logs;
create policy followup_logs_all on followup_logs for all
  using (is_office_role())
  with check (is_office_role());

alter table customers enable row level security;

drop policy if exists customers_all on customers;
create policy customers_all on customers for all
  using (is_office_role())
  with check (is_office_role());

-- =========================================================
-- 6. WhatsApp broadcast — template registry + send queue.
--
-- Meta's WhatsApp Cloud API requires any business-initiated message
-- (i.e. not a reply within 24h of the customer texting first) to use
-- a pre-approved template, and caps a new number to 250 unique
-- customers/24h until the business is verified or earns higher tiers.
-- So sending is modeled as a QUEUE (broadcast_recipients, one row per
-- customer, status pending/sent/failed) that gets worked off in
-- batches over time via the send-whatsapp-broadcast edge function —
-- never a single all-at-once blast.
-- =========================================================
create table if not exists whatsapp_templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,  -- must exactly match the template name approved in Meta Business Manager
  category     text not null check (category in ('utility', 'marketing', 'authentication')),
  language     text not null default 'en',
  body_text    text not null,         -- reference copy only; source of truth is Meta's WhatsApp Manager
  param_count  int not null default 0,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);

create table if not exists whatsapp_broadcasts (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  template_id       uuid references whatsapp_templates(id),
  audience_filter   text not null default 'all',   -- 'all' | 'line:<name>'
  param_values      jsonb not null default '{}'::jsonb,
  status            text not null default 'draft' check (status in ('draft', 'sending', 'completed', 'cancelled')),
  total_recipients  int not null default 0,
  sent_count        int not null default 0,
  failed_count      int not null default 0,
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now()
);

create table if not exists broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  broadcast_id  uuid not null references whatsapp_broadcasts(id) on delete cascade,
  customer_id   uuid not null references customers(id),
  status        text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  wa_message_id text,
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (broadcast_id, customer_id)
);

alter table whatsapp_templates enable row level security;
alter table whatsapp_broadcasts enable row level security;
alter table broadcast_recipients enable row level security;

drop policy if exists whatsapp_templates_all on whatsapp_templates;
create policy whatsapp_templates_all on whatsapp_templates for all
  using (is_office_role())
  with check (is_office_role());

-- composing/viewing broadcasts: any office role. Actually queueing/
-- sending is gated a level higher, inside the edge function itself
-- (owner/manager only), since that's the point where real messages
-- to real customers go out.
drop policy if exists whatsapp_broadcasts_all on whatsapp_broadcasts;
create policy whatsapp_broadcasts_all on whatsapp_broadcasts for all
  using (is_office_role())
  with check (is_office_role());

drop policy if exists broadcast_recipients_all on broadcast_recipients;
create policy broadcast_recipients_all on broadcast_recipients for all
  using (is_office_role())
  with check (is_office_role());

-- =========================================================
-- 6b. Operations: vehicles, attendance, payroll, driver targets
-- =========================================================

-- Delivery vehicles master list
create table if not exists vehicles (
  id             uuid primary key default gen_random_uuid(),
  vehicle_number text not null unique,
  vehicle_type   text not null default 'delivery'
                 check (vehicle_type in ('delivery', 'bulk', 'other')),
  make_model     text,
  insurance_expiry date,
  fc_expiry      date,          -- fitness certificate
  permit_expiry  date,
  active         boolean not null default true,
  notes          text,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now()
);

-- Staff attendance — one row per person per day
create table if not exists staff_attendance (
  id          uuid primary key default gen_random_uuid(),
  entry_date  date not null default current_date,
  staff_id    uuid not null references profiles(id),
  status      text not null default 'present'
              check (status in ('present', 'absent', 'half_day', 'leave')),
  notes       text,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  unique (entry_date, staff_id)
);

-- Payroll — salary payments, advances and deductions per staff member.
-- Monthly net = sum(salary) - sum(advance) - sum(deduction) + sum(bonus)
create table if not exists payroll_entries (
  id          uuid primary key default gen_random_uuid(),
  entry_date  date not null default current_date,
  staff_id    uuid not null references profiles(id),
  type        text not null
              check (type in ('salary', 'advance', 'bonus', 'deduction')),
  amount      numeric not null default 0,
  notes       text,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

-- Per-driver delivery targets (cylinders per month)
create table if not exists driver_targets (
  id           uuid primary key default gen_random_uuid(),
  month_start  date not null,   -- first day of the month
  driver_id    uuid not null references profiles(id),
  target_qty   numeric not null default 0,
  notes        text,
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  unique (month_start, driver_id)
);

alter table vehicles enable row level security;
alter table staff_attendance enable row level security;
alter table payroll_entries enable row level security;
alter table driver_targets enable row level security;

-- vehicles / attendance / targets: ops manage, office+staff view.
-- payroll is money — office roles only, staff cannot read each other's pay.
drop policy if exists vehicles_select on vehicles;
create policy vehicles_select on vehicles for select
  using (auth.uid() is not null);
drop policy if exists vehicles_write on vehicles;
create policy vehicles_write on vehicles for all
  using (is_ops_role())
  with check (is_ops_role());

drop policy if exists staff_attendance_select on staff_attendance;
create policy staff_attendance_select on staff_attendance for select
  using (staff_id = auth.uid() or is_office_role() or current_role_name() = 'staff');
drop policy if exists staff_attendance_write on staff_attendance;
create policy staff_attendance_write on staff_attendance for all
  using (is_ops_role() or current_role_name() = 'staff')
  with check (is_ops_role() or current_role_name() = 'staff');

drop policy if exists payroll_entries_select on payroll_entries;
create policy payroll_entries_select on payroll_entries for select
  using (staff_id = auth.uid() or is_office_role());
drop policy if exists payroll_entries_write on payroll_entries;
create policy payroll_entries_write on payroll_entries for all
  using (is_office_role())
  with check (is_office_role());

drop policy if exists driver_targets_select on driver_targets;
create policy driver_targets_select on driver_targets for select
  using (driver_id = auth.uid() or is_office_role());
drop policy if exists driver_targets_write on driver_targets;
create policy driver_targets_write on driver_targets for all
  using (is_ops_role())
  with check (is_ops_role());

-- =========================================================
-- 6c. Refill bookings — the front door of the daily workflow.
--     Office records a booking; it gets assigned to a driver's trip
--     and marked delivered/cancelled.
-- =========================================================
create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  booking_date  date not null default current_date,
  consumer_no   text,
  consumer_name text not null,
  phone         text,
  line          text,
  product       text not null default '14.2 Kg Domestic',
  qty           numeric not null default 1,
  payment_mode  text not null default 'cash'
                check (payment_mode in ('cash', 'online', 'gpay', 'credit')),
  status        text not null default 'booked'
                check (status in ('booked', 'assigned', 'delivered', 'cancelled')),
  assigned_driver uuid references profiles(id),
  delivered_date  date,
  notes         text,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

-- =========================================================
-- 6d. Plant purchases (uplift from the bottling plant) — inventory
--     inflow: full cylinders received against empties sent.
-- =========================================================
create table if not exists plant_purchases (
  id             uuid primary key default gen_random_uuid(),
  purchase_date  date not null default current_date,
  invoice_no     text,
  product        text not null,
  qty_received   numeric not null default 0,  -- full cylinders in
  empties_sent   numeric not null default 0,  -- empty cylinders out
  amount         numeric not null default 0,  -- invoice value
  vehicle_number text,                        -- lorry that fetched the load
  notes          text,
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now()
);

alter table bookings enable row level security;
alter table plant_purchases enable row level security;

-- bookings: office manages; drivers see and can update the ones
-- assigned to them (mark delivered on the road)
drop policy if exists bookings_select on bookings;
create policy bookings_select on bookings for select
  using (is_office_role() or assigned_driver = auth.uid());
drop policy if exists bookings_write on bookings;
create policy bookings_write on bookings for insert
  with check (is_office_role());
drop policy if exists bookings_update on bookings;
create policy bookings_update on bookings for update
  using (is_office_role() or assigned_driver = auth.uid());
drop policy if exists bookings_delete on bookings;
create policy bookings_delete on bookings for delete
  using (is_office_role());

-- plant purchases: office + godown staff
drop policy if exists plant_purchases_select on plant_purchases;
create policy plant_purchases_select on plant_purchases for select
  using (is_office_role() or current_role_name() = 'staff');
drop policy if exists plant_purchases_write on plant_purchases;
create policy plant_purchases_write on plant_purchases for all
  using (is_office_role() or current_role_name() = 'staff')
  with check (is_office_role() or current_role_name() = 'staff');

-- =========================================================
-- 6e. day_sheets — the office's daily Credit/Debit sheet, mirroring
--     their Excel format 1:1. Stored as one JSONB document per date:
--     the sheet is a free-form document with variable rows per section
--     (drivers, expense lines), so a document column matches the paper
--     better than a dozen skinny tables would.
-- =========================================================
create table if not exists day_sheets (
  id          uuid primary key default gen_random_uuid(),
  entry_date  date not null unique,
  data        jsonb not null default '{}'::jsonb,
  created_by  uuid references profiles(id),
  updated_at  timestamptz not null default now()
);

alter table day_sheets enable row level security;

drop policy if exists day_sheets_all on day_sheets;
create policy day_sheets_all on day_sheets for all
  using (is_office_role())
  with check (is_office_role());

-- =========================================================
-- 6f. driver_sheets — each delivery boy's daily settlement sheet, the
--     digital twin of the printed "SR Bharat Gas - Kammapuram" godown
--     page: stock movement, per-product sale, debits, denominations.
--     One JSONB document per driver per date; the driver edits and
--     submits it daily, the office reads every driver's sheet and
--     builds the cumulative account from them.
-- =========================================================
create table if not exists driver_sheets (
  id          uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references profiles(id),
  sheet_date  date not null default current_date,
  driver_name text,
  data        jsonb not null default '{}'::jsonb,
  submitted   boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (driver_id, sheet_date)
);

-- Approval lifecycle: draft (driver still filling) -> submitted (pending
-- verification, visible on the office Day Sheet) -> approved (accounts
-- has collected the cash; the sheet's sales auto-flow into the day's
-- Total Sales and the driver's copy locks).
alter table driver_sheets add column if not exists status text not null default 'draft'
  check (status in ('draft', 'submitted', 'approved'));
alter table driver_sheets add column if not exists approved_by uuid references profiles(id);
alter table driver_sheets add column if not exists approved_at timestamptz;
-- true once this sheet's deliveries have been applied to godown_stock
-- (so approve/reopen can apply/reverse exactly once)
alter table driver_sheets add column if not exists stock_applied boolean not null default false;

-- older rows recorded submission as a boolean only
update driver_sheets set status = 'submitted' where submitted and status = 'draft';

alter table driver_sheets enable row level security;

drop policy if exists driver_sheets_select on driver_sheets;
create policy driver_sheets_select on driver_sheets for select
  using (driver_id = auth.uid() or is_office_role());

drop policy if exists driver_sheets_insert on driver_sheets;
create policy driver_sheets_insert on driver_sheets for insert
  with check (driver_id = auth.uid() and current_role_name() = 'driver');

drop policy if exists driver_sheets_update on driver_sheets;
create policy driver_sheets_update on driver_sheets for update
  using (driver_id = auth.uid() or is_office_role());

drop policy if exists driver_sheets_delete on driver_sheets;
create policy driver_sheets_delete on driver_sheets for delete
  using (driver_id = auth.uid() or is_office_role());

-- =========================================================
-- 7. Table privileges (GRANTs)
--
-- GRANT and RLS are two separate gates: Postgres checks the table
-- privilege FIRST, and only then evaluates row policies. Supabase does
-- not always apply its default privileges to tables created this way,
-- which shows up as "permission denied for table X" (SQLSTATE 42501)
-- even for a correctly signed-in user, before any policy runs.
--
-- Granting to `authenticated` only, deliberately: every policy above
-- requires auth.uid(), so `anon` has no reachable rows anyway and
-- giving it table access would be pointless surface area. Sign-up and
-- sign-in go through the auth API, not PostgREST, so they are
-- unaffected by these grants.
-- =========================================================
-- Blanket form rather than a table-by-table list: this runs last, so
-- every table above already exists, and there is no list to fall out of
-- sync when a table is added later.
--
-- This project's database has NO default privileges at all (confirmed
-- live: authenticated AND service_role both hit "permission denied"
-- until granted explicitly), so every role the app touches is granted
-- here: `authenticated` for signed-in users via PostgREST, and
-- `service_role` for the edge functions (create-team-user inserts the
-- new staff member's profile row with it).
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ...and for anything created after this point.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
