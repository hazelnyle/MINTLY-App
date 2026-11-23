-- MINTLY database foundation. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id,email) values(new.id,new.email)
  on conflict (id) do update set email=excluded.email;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('personal','household')),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.space_members (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key(space_id,user_id)
);
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('income','expense')),
  amount numeric(14,2) not null check (amount >= 0),
  description text not null,
  category text default 'General',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.essentials (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  estimated_cost numeric(14,2) not null default 0 check (estimated_cost >= 0),
  restock_days integer not null default 30 check (restock_days > 0),
  last_purchased date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('editor','viewer')),
  invited_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  created_at timestamptz not null default now(),
  unique(space_id,email)
);

create or replace function public.is_space_member(sid uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.space_members m where m.space_id=sid and m.user_id=auth.uid());
$$;
create or replace function public.space_role(sid uuid)
returns text language sql stable security definer set search_path=public as $$
 select role from public.space_members where space_id=sid and user_id=auth.uid() limit 1;
$$;
create or replace function public.can_edit_space(sid uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select coalesce(public.space_role(sid) in ('owner','admin','editor'),false);
$$;

alter table public.profiles enable row level security;
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.transactions enable row level security;
alter table public.essentials enable row level security;
alter table public.invitations enable row level security;

drop policy if exists "profile self read" on public.profiles;
create policy "profile self read" on public.profiles for select using (id=auth.uid());
drop policy if exists "members read spaces" on public.spaces;
create policy "members read spaces" on public.spaces for select using (public.is_space_member(id));
drop policy if exists "authenticated create spaces" on public.spaces;
create policy "authenticated create spaces" on public.spaces for insert to authenticated with check (created_by=auth.uid());
drop policy if exists "owners update spaces" on public.spaces;
create policy "owners update spaces" on public.spaces for update using (public.space_role(id) in ('owner','admin')) with check (public.space_role(id) in ('owner','admin'));
drop policy if exists "members read membership" on public.space_members;
create policy "members read membership" on public.space_members for select using (public.is_space_member(space_id));
drop policy if exists "user join membership" on public.space_members;
create policy "user join membership" on public.space_members for insert to authenticated with check (
  user_id=auth.uid() and (
    role='owner' and exists(select 1 from public.spaces s where s.id=space_id and s.created_by=auth.uid())
    or exists(select 1 from public.invitations i join public.profiles p on lower(p.email)=lower(i.email)
      where i.space_id=space_id and p.id=auth.uid() and i.status='pending' and i.role=role)
  )
);
drop policy if exists "admins update membership" on public.space_members;
create policy "admins update membership" on public.space_members for update using (public.space_role(space_id) in ('owner','admin')) with check (public.space_role(space_id) in ('owner','admin'));
drop policy if exists "admins remove membership" on public.space_members;
create policy "admins remove membership" on public.space_members for delete using (public.space_role(space_id) in ('owner','admin') and user_id<>auth.uid());

drop policy if exists "members read transactions" on public.transactions;
create policy "members read transactions" on public.transactions for select using (public.is_space_member(space_id));
drop policy if exists "editors manage transactions" on public.transactions;
create policy "editors manage transactions" on public.transactions for insert to authenticated with check (public.can_edit_space(space_id) and user_id=auth.uid());
create policy "editors update transactions" on public.transactions for update using (public.can_edit_space(space_id)) with check (public.can_edit_space(space_id));
create policy "editors delete transactions" on public.transactions for delete using (public.can_edit_space(space_id));
drop policy if exists "members read essentials" on public.essentials;
create policy "members read essentials" on public.essentials for select using (public.is_space_member(space_id));
drop policy if exists "editors manage essentials" on public.essentials;
create policy "editors manage essentials" on public.essentials for insert to authenticated with check (public.can_edit_space(space_id) and user_id=auth.uid());
create policy "editors update essentials" on public.essentials for update using (public.can_edit_space(space_id)) with check (public.can_edit_space(space_id));
create policy "editors delete essentials" on public.essentials for delete using (public.can_edit_space(space_id));
drop policy if exists "members read invitations" on public.invitations;
create policy "members read invitations" on public.invitations for select using (public.space_role(space_id) in ('owner','admin'));
