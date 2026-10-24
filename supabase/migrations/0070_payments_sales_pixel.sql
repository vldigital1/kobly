-- 0070_payments_sales_pixel.sql
-- Kobly — Fase 3 do motor de fluxos: cobrança dentro do fluxo (gateway do PRÓPRIO cliente),
-- confirmação por webhook que puxa o fluxo para a saída "pagamento aprovado", registro de
-- venda e eventos de conversão para o Pixel da Meta (API de Conversões).
--
-- Segredos (client secret do gateway, token do Pixel) ficam CIFRADOS (AES-256-GCM, chave do
-- serviço) e não são legíveis pelo cliente (grant por coluna). Toda escrita passa pelo serviço.

-- Credenciais de gateway por empresa (uma empresa pode ter várias: produção, sandbox, contas diferentes).
create table public.payment_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('xpag')),
  label text not null default 'Principal',
  client_id text not null,
  secret_enc text not null,
  sandbox boolean not null default false,
  -- o gateway chama /webhooks/payments/<provider>/<webhook_token>; o token só identifica a credencial
  webhook_token text not null unique,
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.payment_integrations for each row execute function public.tg_set_updated_at();
create index idx_payment_integrations_org on public.payment_integrations (organization_id);

-- Cobranças geradas pelos fluxos.
create table public.payment_charges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null references public.payment_integrations(id) on delete cascade,
  execution_id uuid references public.flow_executions(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  node_ref text,
  provider text not null,
  external_id text not null unique,
  transaction_id text,
  request_number text,
  currency text not null,
  method text,
  amount numeric(14,2),
  open_amount boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'expired', 'failed')),
  payment_code text,
  payment_qr text,
  checkout_url text,
  paid_amount numeric(14,2),
  -- até quando a confirmação ainda puxa o fluxo para "pagamento aprovado"
  listen_until timestamptz,
  confirmed_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.payment_charges for each row execute function public.tg_set_updated_at();
create unique index payment_charges_provider_tx on public.payment_charges (provider, transaction_id) where transaction_id is not null;
create index idx_payment_charges_org on public.payment_charges (organization_id, created_at desc);
create index idx_payment_charges_lead on public.payment_charges (lead_id);

-- Avisos recebidos do gateway (reentrega é comum: dedupe por chave do aviso).
create table public.payment_webhook_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null references public.payment_integrations(id) on delete cascade,
  dedupe_key text not null,
  status text,
  payload jsonb not null,
  result text,
  created_at timestamptz not null default now(),
  unique (integration_id, dedupe_key)
);

-- Vendas registradas pelos fluxos (bloco "Registrar venda").
create table public.flow_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  execution_id uuid references public.flow_executions(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  charge_id uuid references public.payment_charges(id) on delete set null,
  amount numeric(14,2) not null,
  currency text not null default 'BRL',
  product text,
  created_at timestamptz not null default now()
);
-- uma cobrança vira no máximo uma venda (o mesmo fluxo pode passar duas vezes pelo bloco)
create unique index flow_sales_one_per_charge on public.flow_sales (charge_id) where charge_id is not null;
create index idx_flow_sales_org on public.flow_sales (organization_id, created_at desc);

-- Pixel da Meta (API de Conversões) por empresa.
create table public.pixel_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null default 'Pixel',
  pixel_id text not null check (pixel_id ~ '^\d{5,25}$'),
  token_enc text not null,
  test_event_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.pixel_configs for each row execute function public.tg_set_updated_at();
create index idx_pixel_configs_org on public.pixel_configs (organization_id);

-- RLS: leitura pela empresa (sem colunas secretas); escrita só pelo serviço.
alter table public.payment_integrations enable row level security;
alter table public.payment_charges enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.flow_sales enable row level security;
alter table public.pixel_configs enable row level security;
create policy payment_integrations_select on public.payment_integrations for select to authenticated using (public.has_org_access(organization_id));
create policy payment_charges_select on public.payment_charges for select to authenticated using (public.has_org_access(organization_id));
create policy flow_sales_select on public.flow_sales for select to authenticated using (public.has_org_access(organization_id));
create policy pixel_configs_select on public.pixel_configs for select to authenticated using (public.has_org_access(organization_id));
-- payment_webhook_events: sem política de leitura (só o serviço)

revoke all on public.payment_integrations, public.payment_charges, public.payment_webhook_events, public.flow_sales, public.pixel_configs from authenticated, anon, public;
grant select (id, organization_id, provider, label, client_id, sandbox, status, last_error, created_at, updated_at) on public.payment_integrations to authenticated;
grant select on public.payment_charges, public.flow_sales to authenticated;
grant select (id, organization_id, label, pixel_id, test_event_code, created_at, updated_at) on public.pixel_configs to authenticated;
