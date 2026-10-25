-- 0079_platform_connections.sql
-- Kobly — Plataformas de venda (Hotmart, Kiwify, Cakto, Kirvano, PerfectPay, Payt) com página própria.
-- Cada conexão é um postback_token (a URL que a plataforma chama) que agora sabe de qual plataforma é e
-- guarda a chave de validação dela:
--   kiwify     → token do webhook (a Kiwify assina o corpo com HMAC-SHA1 no parâmetro ?signature=)
--   cakto      → secret do webhook (vem no corpo, campo "secret")
--   payt       → integration_key (vem no corpo)
--   perfectpay → token do postback (vem no corpo, campo "token")
--   hotmart    → continua no campo hottok (cabeçalho X-HOTMART-HOTTOK)
-- Com a chave cadastrada, aviso que não prova ser da plataforma é recusado.
-- Kiwify e Cakto também conectam por API: a Kobly cria o webhook na conta do cliente. As chaves de API
-- ficam em platform_api_credentials (cifradas; o cliente não lê).

alter table public.postback_tokens
  add column if not exists platform text check (platform in ('hotmart', 'kiwify', 'cakto', 'kirvano', 'perfectpay', 'payt')),
  add column if not exists platform_secret text,
  add column if not exists last_event_at timestamptz,
  add column if not exists events_count integer not null default 0;

create table public.platform_api_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  postback_token_id uuid not null unique references public.postback_tokens(id) on delete cascade,
  platform text not null check (platform in ('kiwify', 'cakto')),
  credentials_enc text not null,
  remote_webhook_id text,
  created_at timestamptz not null default now()
);
alter table public.platform_api_credentials enable row level security;
revoke all on public.platform_api_credentials from authenticated, anon, public;

-- Zenith (pagamentos locais no México e outros países) no bloco Cobrança
alter table public.payment_integrations drop constraint if exists payment_integrations_provider_check;
alter table public.payment_integrations add constraint payment_integrations_provider_check check (provider in ('xpag', 'mercadopago', 'woovi', 'pushinpay', 'syncpay', 'zenith'));
