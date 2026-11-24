-- Safe, additive migration for the currency fields already used by app.js.
-- Existing rows and financial records are preserved.
alter table public.transactions
  add column if not exists currency text not null default 'USD',
  add column if not exists fx_rates jsonb;

alter table public.essentials
  add column if not exists currency text not null default 'USD';
