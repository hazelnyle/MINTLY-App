-- MINTLY: preserve entry timestamps and add the actual transaction date.
alter table public.transactions
  add column if not exists transaction_date date;

update public.transactions
set transaction_date = created_at::date
where transaction_date is null;

alter table public.transactions
  alter column transaction_date set default current_date,
  alter column transaction_date set not null;

-- Only household owners may permanently delete a household.
-- Deleting a space cascades to its members, transactions, essentials and invitations.
drop policy if exists "owners delete household spaces" on public.spaces;
create policy "owners delete household spaces"
  on public.spaces
  for delete
  using (kind = 'household' and public.space_role(id) = 'owner');
