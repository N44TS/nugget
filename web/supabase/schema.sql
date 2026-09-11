create table if not exists public.nugget_contributions (
  id uuid primary key default gen_random_uuid(),
  epoch text not null,
  envelope jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists nugget_contributions_epoch_created_idx
  on public.nugget_contributions (epoch, created_at);

create table if not exists public.nugget_receipts (
  id uuid primary key default gen_random_uuid(),
  claim_id text not null,
  batch_id text not null,
  created_at timestamptz not null,
  in_encrypted_pool boolean not null
);

alter table public.nugget_contributions enable row level security;
alter table public.nugget_receipts enable row level security;

create table if not exists public.nugget_buyer_payments (
  tx_hash text primary key,
  buyer_address text not null,
  amount_wei numeric not null,
  batch_id text,
  status text not null check (status in ('verified', 'completed', 'failed')),
  report_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.nugget_buyer_payments enable row level security;

create table if not exists public.nugget_reward_opt_ins (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null,
  wallet_address text not null,
  opted_in_at timestamptz not null default now(),
  status text not null default 'eligible' check (status in ('eligible', 'paid', 'excluded')),
  unique (batch_id, wallet_address)
);

create index if not exists nugget_reward_opt_ins_batch_idx
  on public.nugget_reward_opt_ins (batch_id, opted_in_at);

alter table public.nugget_reward_opt_ins enable row level security;

create table if not exists public.nugget_reward_registrations (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null,
  envelope jsonb not null,
  created_at timestamptz not null default now()
);

-- Privacy migration for databases created by an earlier demo build. A reward
-- registration's claim and wallet are now carried only in `envelope`, which
-- is decrypted in the CRE handler. Do not retain their plaintext pairing.
alter table public.nugget_reward_registrations drop column if exists claim_id;
alter table public.nugget_reward_registrations drop column if exists wallet_address;

create index if not exists nugget_reward_registrations_batch_idx
  on public.nugget_reward_registrations (batch_id, created_at);

alter table public.nugget_reward_registrations enable row level security;

-- The CRE simulation writes a Merkle proof produced from its decrypted,
-- validated cohort. This contains no cycle information.
create table if not exists public.nugget_reward_claim_proofs (
  batch_id text not null,
  wallet_address text not null,
  proof jsonb not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, wallet_address)
);

alter table public.nugget_reward_claim_proofs enable row level security;

create table if not exists public.nugget_reward_batches (
  batch_id text primary key,
  contributor_count integer not null,
  wallet_count integer not null,
  reward_pool_wei numeric not null,
  per_wallet_wei numeric,
  status text not null check (status in ('held', 'payable', 'paid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nugget_reward_allocations (
  batch_id text not null references public.nugget_reward_batches(batch_id),
  wallet_address text not null,
  amount_wei numeric not null,
  status text not null check (status in ('allocated', 'paid')),
  transaction_hash text,
  created_at timestamptz not null default now(),
  primary key (batch_id, wallet_address)
);

alter table public.nugget_reward_batches enable row level security;
alter table public.nugget_reward_allocations enable row level security;
