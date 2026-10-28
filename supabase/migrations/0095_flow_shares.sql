-- Compartilhar fluxo por código (como no ZapData e na Leona): cada fluxo tem um código; quem tem o código importa
-- o fluxo na conta dele (sempre a versão mais nova) e qualquer pessoa vê a prévia pelo link app.koblay.io/?fluxo=código.
-- "Gerar novo código" desativa o antigo.
create table public.flow_shares (
  code uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  active boolean not null default true,
  created_by uuid,
  imports int not null default 0,
  created_at timestamptz not null default now()
);
create unique index flow_shares_one_active on public.flow_shares (campaign_id) where active;
alter table public.flow_shares enable row level security;
revoke all on public.flow_shares from authenticated, anon, public;
