-- 0099_public_api.sql
-- Kobly — API pública: chaves da empresa para outros sistemas (gateway, checkout, CRM) dispararem fluxos.
--   GET  /public/v1/me · GET /public/v1/instances · GET /public/v1/flows · POST /public/v1/flows/{id}/trigger
-- A chave só fica em hash (SHA-256); aparece uma única vez ao criar.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null,
  key_prefix text not null,
  key_hash text not null unique,
  created_by uuid,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_api_keys_org on public.api_keys (organization_id);

alter table public.api_keys enable row level security;
revoke all on public.api_keys from authenticated, anon, public;
