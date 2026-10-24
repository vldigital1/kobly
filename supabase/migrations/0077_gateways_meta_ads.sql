-- 0077_gateways_meta_ads.sql
-- Kobly — novos gateways no bloco Cobrança (Mercado Pago e Woovi, Pix) e conta de anúncios do Facebook
-- para acompanhar as campanhas em tempo real ao lado das vendas e recuperações da Kobly.

alter table public.payment_integrations drop constraint if exists payment_integrations_provider_check;
alter table public.payment_integrations add constraint payment_integrations_provider_check check (provider in ('xpag', 'mercadopago', 'woovi'));

-- Conta de anúncios (Marketing API, permissão ads_read). Token cifrado; o cliente só vê o final.
create table public.meta_ads_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ad_account_id text not null check (ad_account_id ~ '^[0-9]{5,25}$'),
  name text not null default '',
  currency text,
  token_enc text not null,
  token_hint text not null,
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, ad_account_id)
);
create trigger set_updated_at before update on public.meta_ads_accounts for each row execute function public.tg_set_updated_at();

alter table public.meta_ads_accounts enable row level security;
create policy meta_ads_accounts_select on public.meta_ads_accounts for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.meta_ads_accounts from authenticated, anon, public;
grant select (id, organization_id, ad_account_id, name, currency, token_hint, status, last_error, last_sync_at, created_at, updated_at) on public.meta_ads_accounts to authenticated;
