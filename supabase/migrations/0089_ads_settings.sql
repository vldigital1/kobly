-- 0089_ads_settings.sql
-- Kobly — taxas e despesas usadas no lucro do gerenciador de anúncios (imposto, taxa do gateway,
-- custo do produto em % do faturamento e custo fixo por venda). Uma linha por empresa; só o serviço escreve.

create table public.ads_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  imposto_pct numeric(6,2) not null default 0 check (imposto_pct between 0 and 100),
  taxa_gateway_pct numeric(6,2) not null default 0 check (taxa_gateway_pct between 0 and 100),
  custo_produto_pct numeric(6,2) not null default 0 check (custo_produto_pct between 0 and 100),
  custo_por_venda numeric(14,2) not null default 0 check (custo_por_venda >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.ads_settings for each row execute function public.tg_set_updated_at();

alter table public.ads_settings enable row level security;
create policy ads_settings_select on public.ads_settings for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.ads_settings from authenticated, anon, public;
grant select on public.ads_settings to authenticated;
