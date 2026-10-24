-- 0076_ai_credentials.sql
-- Kobly — IA com a chave do próprio cliente (BYOK). Cada empresa cadastra a chave de API do provedor
-- que quiser (OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter) e escolhe o modelo; os blocos de
-- IA dos fluxos, o agente e o copiloto usam a chave ATIVA da empresa (o custo da IA fica com o cliente).
-- A chave fica cifrada (AES-GCM, mesma chave de serviço do WhatsApp); o cliente só vê o final dela.

create table public.ai_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic', 'gemini', 'deepseek', 'openrouter')),
  label text not null default '',
  key_enc text not null,
  key_hint text not null,
  model text not null,
  is_active boolean not null default false,
  status text not null default 'ok' check (status in ('ok', 'error')),
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_ai_credentials_org on public.ai_credentials (organization_id);
-- uma chave ativa por empresa
create unique index ai_credentials_one_active on public.ai_credentials (organization_id) where is_active;
create trigger set_updated_at before update on public.ai_credentials for each row execute function public.tg_set_updated_at();

alter table public.ai_credentials enable row level security;
create policy ai_credentials_select on public.ai_credentials for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.ai_credentials from authenticated, anon, public;
grant select (id, organization_id, provider, label, key_hint, model, is_active, status, last_error, last_used_at, created_at, updated_at) on public.ai_credentials to authenticated;
