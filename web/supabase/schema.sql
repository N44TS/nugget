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
