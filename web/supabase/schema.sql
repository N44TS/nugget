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
