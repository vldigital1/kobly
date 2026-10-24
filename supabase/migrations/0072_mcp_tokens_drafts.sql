-- 0072_mcp_tokens_drafts.sql
-- Kobly — Fase 5: MCP próprio da Kobly (assistentes de IA externos criam/editam fluxos) e rascunhos.
--
-- Segurança: o token do MCP só é mostrado UMA vez; no banco fica só o SHA-256. O MCP grava RASCUNHOS:
-- publicar (ativar) uma versão continua sendo um clique de uma pessoa no editor.

alter table public.flow_graph_versions
  add column if not exists is_draft boolean not null default false,
  add column if not exists source text not null default 'editor' check (source in ('editor', 'mcp', 'copilot')),
  add column if not exists note text;

create table public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null,
  token_prefix text not null,          -- primeiros caracteres, para a pessoa reconhecer o token na lista
  token_hash text not null unique,     -- SHA-256 do token; o token em si nunca é guardado
  created_by uuid,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_mcp_tokens_org on public.mcp_tokens (organization_id);

alter table public.mcp_tokens enable row level security;
create policy mcp_tokens_select on public.mcp_tokens for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.mcp_tokens from authenticated, anon, public;
grant select (id, organization_id, label, token_prefix, last_used_at, revoked_at, created_at) on public.mcp_tokens to authenticated;
