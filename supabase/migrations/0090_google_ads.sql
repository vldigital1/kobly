-- 0090_google_ads.sql
-- Kobly — contas do Google Ads conectadas pelo "Conectar com Google" (refresh token cifrado; contas de
-- cliente dentro de uma MCC guardam o login_customer_id da MCC) e o login pendente enquanto o cliente
-- escolhe as contas. Só o serviço lê o token.

create table public.google_ads_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id text not null check (customer_id ~ '^[0-9]{6,12}$'),
  login_customer_id text check (login_customer_id ~ '^[0-9]{6,12}$'),
  name text not null default '',
  currency text,
  token_enc text not null,
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, customer_id)
);
create trigger set_updated_at before update on public.google_ads_accounts for each row execute function public.tg_set_updated_at();
alter table public.google_ads_accounts enable row level security;
create policy google_ads_accounts_select on public.google_ads_accounts for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.google_ads_accounts from authenticated, anon, public;
grant select (id, organization_id, customer_id, login_customer_id, name, currency, status, last_error, last_sync_at, created_at, updated_at) on public.google_ads_accounts to authenticated;

create table public.google_ads_oauth (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  token_enc text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.google_ads_oauth enable row level security;
revoke all on public.google_ads_oauth from authenticated, anon, public;
