-- Kobly — Cobrança com dois provedores: Pix Automático pelo Asaas (o cliente autoriza o débito no banco uma vez)
-- e cartão pela Stripe. As assinaturas antigas do Asaas (Pix comum e cartão) continuam funcionando como antes.
--   provider: 'asaas' (assinatura do Asaas), 'pix_auto' (Pix Automático do Asaas) ou 'stripe' (cartão)
alter table public.subscriptions add column if not exists provider text check (provider in ('asaas', 'pix_auto', 'stripe'));
alter table public.subscriptions add column if not exists stripe_customer_id text;
alter table public.subscriptions add column if not exists stripe_subscription_id text;
alter table public.subscriptions add column if not exists stripe_item_id text;
alter table public.subscriptions add column if not exists pix_auth_id text;          -- autorização do Pix Automático em uso
alter table public.subscriptions add column if not exists pix_auth_status text;      -- CREATED | ACTIVE | REFUSED | CANCELLED | EXPIRED
alter table public.subscriptions add column if not exists pix_auth_value numeric(10,2); -- valor autorizado pelo cliente (piso do limite)
update public.subscriptions set provider = 'asaas' where provider is null and asaas_subscription_id is not null;

alter table public.invoices add column if not exists stripe_invoice_id text;
alter table public.invoices add column if not exists stripe_payment_intent_id text;
alter table public.invoices add column if not exists pix_auth_id text;               -- QR Code que paga e autoriza o Pix Automático
create unique index if not exists invoices_stripe_invoice_key on public.invoices (stripe_invoice_id) where stripe_invoice_id is not null;
create index if not exists invoices_stripe_pi_idx on public.invoices (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists invoices_pix_auth_idx on public.invoices (pix_auth_id) where pix_auth_id is not null;
create index if not exists subscriptions_stripe_sub_idx on public.subscriptions (stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists subscriptions_pix_auth_idx on public.subscriptions (pix_auth_id) where pix_auth_id is not null;

-- avisos repetidos (o Asaas e a Stripe reenviam o mesmo evento): processa uma vez só
create table if not exists public.billing_events (
  id text primary key,                 -- id do evento no provedor
  provider text not null,
  created_at timestamptz not null default now()
);
alter table public.billing_events enable row level security;
revoke all on public.billing_events from authenticated, anon, public;
