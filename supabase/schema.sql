-- TipJar / Creator Tipping & Support Platform
-- Run this in the Supabase SQL editor (or via the Supabase CLI) before enabling live mode.

create extension if not exists pgcrypto;

do $$ begin
  create type transaction_status as enum ('PENDING', 'SUCCESS', 'FAILED');
exception
  when duplicate_object then null;
end $$;

-- Public creator profiles -------------------------------------------------------
create table if not exists public.creators (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-zA-Z0-9._-]{2,40}$'),
  display_name text not null,
  headline text not null default '',
  bio text not null default '',
  avatar_url text,
  avatar_emoji text not null default '✨',
  location text not null default '',
  followers integer not null default 0 check (followers >= 0),
  following integer not null default 0 check (following >= 0),
  posts integer not null default 0 check (posts >= 0),
  mpesa_phone text check (mpesa_phone ~ '^254[17][0-9]{8}$'),
  created_at timestamptz not null default now()
);

-- Preset gift amounts for each creator -----------------------------------------
create table if not exists public.gift_tiers (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title text not null,
  amount integer not null check (amount between 50 and 100000),
  icon text not null default '🎁',
  is_popular boolean not null default false,
  sort_order integer not null default 0
);

create index if not exists gift_tiers_creator_id_idx on public.gift_tiers(creator_id, sort_order);

-- Every attempted tip, including failed and pending STK pushes ------------------
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete restrict,
  supporter_name text not null default 'Anonymous',
  supporter_message text check (char_length(supporter_message) <= 240),
  gift_title text,
  amount integer not null check (amount between 50 and 100000),
  phone_number text not null default '' check (phone_number = '' or phone_number ~ '^254[17][0-9]{8}$'),
  payment_method text not null default 'mpesa',
  payment_account text,
  mode text not null default 'demo',
  status transaction_status not null default 'PENDING',
  mpesa_receipt_number text,
  checkout_request_id text not null unique,
  merchant_request_id text,
  account_reference text,
  polling_token text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists transactions_creator_status_idx
  on public.transactions(creator_id, status, created_at desc);

-- Upgrade existing installations created before multi-method support -----------
alter table public.transactions add column if not exists payment_method text not null default 'mpesa';
alter table public.transactions add column if not exists payment_account text;
alter table public.transactions add column if not exists mode text not null default 'demo';

alter table public.transactions drop constraint if exists transactions_phone_number_check;
alter table public.transactions add constraint transactions_phone_number_check
  check (phone_number = '' or phone_number ~ '^254[17][0-9]{8}$');

alter table public.transactions drop constraint if exists transactions_payment_method_check;
alter table public.transactions add constraint transactions_payment_method_check
  check (payment_method in ('mpesa', 'airtel', 'paypal', 'binance'));

alter table public.transactions drop constraint if exists transactions_mode_check;
alter table public.transactions add constraint transactions_mode_check
  check (mode in ('demo', 'live'));

-- Upgrade existing installations created before payment correlation hardening -
alter table public.transactions add column if not exists merchant_request_id text;
alter table public.transactions add column if not exists account_reference text;
alter table public.transactions add column if not exists polling_token text;
update public.transactions
  set polling_token = encode(gen_random_bytes(24), 'hex')
  where polling_token is null;
alter table public.transactions alter column polling_token set not null;

create unique index if not exists transactions_polling_token_key
  on public.transactions(polling_token);
create index if not exists transactions_merchant_request_id_idx
  on public.transactions(merchant_request_id);

-- Upgrade existing installations created before public profile stats ------------
alter table public.creators add column if not exists followers integer not null default 0;
alter table public.creators add column if not exists following integer not null default 0;
alter table public.creators add column if not exists posts integer not null default 0;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists transactions_touch_updated_at on public.transactions;
create trigger transactions_touch_updated_at
  before update on public.transactions
  for each row execute function public.touch_updated_at();

-- Aggregates used by the private creator dashboard -----------------------------
create or replace view public.creator_stats as
select
  c.id as creator_id,
  coalesce(sum(t.amount) filter (where t.status = 'SUCCESS'), 0)::bigint as total_supported,
  count(t.id) filter (where t.status = 'SUCCESS')::bigint as supporter_count,
  max(t.created_at) filter (where t.status = 'SUCCESS') as last_gift_at
from public.creators c
left join public.transactions t on t.creator_id = c.id
group by c.id;

-- Earnings are private: this view is read by the service role only.
revoke all on public.creator_stats from anon, authenticated;
grant select on public.creator_stats to service_role;

-- Row Level Security ------------------------------------------------------------
-- Profiles and gift tiers are public. Writes and all transaction reads go through
-- the server using the service role key, which bypasses RLS. Never expose that key.
alter table public.creators enable row level security;
alter table public.gift_tiers enable row level security;
alter table public.transactions enable row level security;

drop policy if exists "Public can view creators" on public.creators;
create policy "Public can view creators"
  on public.creators for select to anon, authenticated using (true);

drop policy if exists "Public can view gift tiers" on public.gift_tiers;
create policy "Public can view gift tiers"
  on public.gift_tiers for select to anon, authenticated using (true);
