-- 0075_team_products_tracking.sql
-- Kobly — Equipe/Convites, Produtos e Trackeamento (UTM + UTMify).
--
-- * profiles.team_role: papel dentro da empresa. 'admin' configura tudo; 'atendente' só usa os Chats ao
--   vivo, Leads e Pipeline. O dono (organizations.user_fundador_id) é sempre admin e não sai da equipe.
--   Só o servidor muda o papel (o gatilho abaixo congela a coluna para quem chama pelo PostgREST).
-- * products: catálogo da empresa; casa com o nome/ID do produto que chega do checkout (aliases).
-- * webhook_events.utm / leads.utm: parâmetros de rastreio (utm_*, src, sck). No lead fica o 1º toque.
-- * tracking_integrations: credencial da UTMify (cifrada). payment_charges.tracking_*: envio de cada
--   cobrança do fluxo para a UTMify (aguardando pagamento → pago).

alter table public.profiles
  add column if not exists team_role text not null default 'admin' check (team_role in ('admin', 'atendente'));

create or replace function public.tg_profiles_team_role_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- auth.uid() nulo = servidor confiável (rota team). Pelo PostgREST ninguém troca o próprio papel.
  if auth.uid() is not null and not public.is_admin() then
    new.team_role := old.team_role;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_profiles_team_role_guard() from public, anon, authenticated;
create trigger profiles_team_role_guard before update on public.profiles
  for each row execute function public.tg_profiles_team_role_guard();

create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null check (length(nome) between 1 and 160),
  aliases text[] not null default '{}',        -- outros nomes/IDs com que o checkout manda o produto
  preco numeric(14,2),
  moeda text not null default 'BRL' check (moeda ~ '^[A-Z]{3}$'),
  checkout_url text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_org_nome on public.products (organization_id, lower(nome));
create trigger set_updated_at before update on public.products for each row execute function public.tg_set_updated_at();

alter table public.webhook_events add column if not exists utm jsonb;
alter table public.leads add column if not exists utm jsonb;
create index if not exists idx_leads_utm_source on public.leads (organization_id, (utm->>'utm_source')) where utm is not null;

create table public.tracking_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('utmify')),
  token_enc text not null,
  token_hint text not null,                    -- últimos caracteres, para reconhecer na tela
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);
create trigger set_updated_at before update on public.tracking_integrations for each row execute function public.tg_set_updated_at();

alter table public.payment_charges
  add column if not exists tracking_status text,
  add column if not exists tracking_error text;

alter table public.products enable row level security;
alter table public.tracking_integrations enable row level security;
create policy products_select on public.products for select to authenticated using (public.has_org_access(organization_id));
create policy tracking_integrations_select on public.tracking_integrations for select to authenticated using (public.has_org_access(organization_id));

revoke all on public.products, public.tracking_integrations from authenticated, anon, public;
grant select on public.products to authenticated;
grant select (id, organization_id, provider, token_hint, status, last_error, last_sent_at, created_at, updated_at) on public.tracking_integrations to authenticated;
