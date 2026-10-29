-- Planos novos da Kobly (cobrança por conexão) e assinatura automática pelo Asaas (Pix e cartão).
-- Essencial: R$ 57 + R$ 27 por conexão a mais (1 a 10). PRO: R$ 87 + R$ 37 (1 a 10).
-- Scale: R$ 420 com 10 conexões + R$ 27 por conexão de 11 a 50 + R$ 20 acima de 50.
-- Agência 5/10/20: R$ 397 / R$ 697 / R$ 1.197 (cada conta de cliente com o PRO e 1 conexão).
-- Ciclos: mensal, trimestral (5% de desconto) e anual (2 meses grátis). Os preços ficam no servidor (billing/pricing.js).
-- * subscriptions: a assinatura de cada conta (uma por empresa), com o cartão salvo como token do Asaas
-- * invoices: faturas (assinatura, upgrade), com o Pix e o link do Asaas
-- Cada fatura paga grava em transactions (o histórico antigo e a comissão dos afiliados continuam funcionando).

alter table public.plans add column if not exists code text;
create unique index if not exists plans_code_key on public.plans (code) where code is not null;
update public.plans set deleted = true, status = 'Inativo' where code is null and deleted = false;
insert into public.plans (nome, descricao, status, valor_mensal, valor_anual, code) values
  ('Essencial', 'WhatsApp por QR Code, fluxos, checkout, Chat ao vivo e Pipeline.', 'Ativo', 57, 570, 'essencial'),
  ('PRO', 'Todos os canais, IA, voz, gestor de anúncios, cobrança no fluxo e disparo em massa.', 'Ativo', 87, 870, 'pro'),
  ('Scale', 'Para quem precisa de muitas conexões: a partir de 11, com preço menor por conexão.', 'Ativo', 447, 4470, 'scale'),
  ('Agência 5', 'Até 5 contas de clientes com tudo do PRO.', 'Ativo', 397, 3970, 'agencia5'),
  ('Agência 10', 'Até 10 contas de clientes com tudo do PRO.', 'Ativo', 697, 6970, 'agencia10'),
  ('Agência 20', 'Até 20 contas de clientes com tudo do PRO.', 'Ativo', 1197, 11970, 'agencia20')
on conflict (code) where code is not null do nothing;

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  plan_code text not null check (plan_code in ('essencial', 'pro', 'scale', 'agencia5', 'agencia10', 'agencia20')),
  connections int not null default 1 check (connections between 1 and 1000),
  cycle text not null default 'mensal' check (cycle in ('mensal', 'trimestral', 'anual')),
  price numeric(10,2) not null,                       -- valor de cada ciclo
  status text not null default 'pendente' check (status in ('pendente', 'ativa', 'inadimplente', 'cancelada', 'cortesia')),
  billing_type text check (billing_type in ('PIX', 'CREDIT_CARD')),
  asaas_customer_id text,
  asaas_subscription_id text,
  card_token_enc text,
  card_last4 text,
  card_brand text,
  current_period_end timestamptz,                     -- renova em
  pending_change jsonb,                                -- redução marcada para a próxima renovação
  note text,
  started_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  kind text not null check (kind in ('assinatura', 'upgrade')),
  description text,
  value numeric(10,2) not null,
  status text not null default 'pendente' check (status in ('pendente', 'paga', 'vencida', 'estornada', 'cancelada', 'falhou')),
  billing_type text,
  asaas_payment_id text unique,
  due_date date,
  paid_at timestamptz,
  invoice_url text,
  pix_payload text,
  pix_image text,
  change jsonb,                                        -- upgrade: o que muda quando pagar
  created_at timestamptz not null default now()
);
create index idx_invoices_org on public.invoices (organization_id, created_at desc);

alter table public.subscriptions enable row level security;
alter table public.invoices enable row level security;
revoke all on public.subscriptions, public.invoices from authenticated, anon, public;
