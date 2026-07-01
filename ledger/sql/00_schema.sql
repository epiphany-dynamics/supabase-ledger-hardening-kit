-- Schema for the ledger hardening demo.
--
-- A minimal "accounts" table representing any balance that must never go
-- negative: wallet credits, subscription usage allowances, marketplace
-- seller balances, in-app currency, etc. Plus a ledger_entries table so
-- every deduction is auditable, which is standard practice for anything
-- involving money or credits.

drop table if exists ledger_entries;
drop table if exists accounts;

create table accounts (
  id           uuid primary key default gen_random_uuid(),
  owner_label  text not null,          -- human-readable label for demo output
  balance_cents bigint not null check (balance_cents >= 0),
  updated_at   timestamptz not null default now()
);

create table ledger_entries (
  id           bigint generated always as identity primary key,
  account_id   uuid not null references accounts(id),
  amount_cents bigint not null,        -- negative = deduction, positive = credit
  reason       text not null,
  created_at   timestamptz not null default now()
);

create index on ledger_entries (account_id);

-- Seed a single demo account with a known starting balance. Every test run
-- resets this so results are reproducible.
insert into accounts (id, owner_label, balance_cents)
values ('00000000-0000-0000-0000-000000000001', 'demo-account', 10000); -- $100.00
