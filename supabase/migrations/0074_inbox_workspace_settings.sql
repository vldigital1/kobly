-- 0074_inbox_workspace_settings.sql
-- Kobly — Chats ao vivo e Configurações da automação.
--
-- * whatsapp_outbound_messages: tudo que a Kobly manda pelo WhatsApp oficial (fluxo, agente de IA
--   ou uma pessoa no chat). Junto com whatsapp_inbound_messages forma a conversa do lead.
-- * leads.automation_paused: a pessoa assumiu o chat; o motor não inicia nem retoma fluxos do lead.
-- * quick_replies, custom_fields, global_variables, ai_agents: configurações reaproveitadas pelos
--   fluxos ({{global.chave}}, {{campo.chave}}) e pelo bloco "Agente de IA" (agente salvo).
-- Escrita só pelo serviço (rota workspace-settings / inbox); o cliente só lê pela RLS da empresa.

alter table public.leads
  add column if not exists automation_paused boolean not null default false,
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

create table public.whatsapp_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  to_phone text not null,
  source text not null check (source in ('fluxo', 'agente', 'humano')),
  body text,
  wa_message_id text,
  sent_by uuid,
  created_at timestamptz not null default now()
);
create index idx_whatsapp_outbound_org on public.whatsapp_outbound_messages (organization_id, created_at desc);
create index idx_whatsapp_outbound_lead on public.whatsapp_outbound_messages (lead_id, created_at desc);

create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shortcut text not null check (shortcut ~ '^[a-z0-9_-]{1,32}$'),
  body text not null check (length(body) between 1 and 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, shortcut)
);

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null,
  field_type text not null default 'texto' check (field_type in ('texto', 'numero', 'data', 'opcoes')),
  options jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

create table public.global_variables (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  value text not null default '' check (length(value) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

create table public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  objective text not null,
  knowledge text not null default '',
  tone text,
  opening text,
  max_turns int not null default 10 check (max_turns between 1 and 30),
  timeout_minutes int not null default 60 check (timeout_minutes between 1 and 43200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_ai_agents_org on public.ai_agents (organization_id);

create trigger set_updated_at before update on public.quick_replies for each row execute function public.tg_set_updated_at();
create trigger set_updated_at before update on public.custom_fields for each row execute function public.tg_set_updated_at();
create trigger set_updated_at before update on public.global_variables for each row execute function public.tg_set_updated_at();
create trigger set_updated_at before update on public.ai_agents for each row execute function public.tg_set_updated_at();

alter table public.whatsapp_outbound_messages enable row level security;
alter table public.quick_replies enable row level security;
alter table public.custom_fields enable row level security;
alter table public.global_variables enable row level security;
alter table public.ai_agents enable row level security;
create policy whatsapp_outbound_select on public.whatsapp_outbound_messages for select to authenticated using (public.has_org_access(organization_id));
create policy quick_replies_select on public.quick_replies for select to authenticated using (public.has_org_access(organization_id));
create policy custom_fields_select on public.custom_fields for select to authenticated using (public.has_org_access(organization_id));
create policy global_variables_select on public.global_variables for select to authenticated using (public.has_org_access(organization_id));
create policy ai_agents_select on public.ai_agents for select to authenticated using (public.has_org_access(organization_id));

revoke all on public.whatsapp_outbound_messages, public.quick_replies, public.custom_fields, public.global_variables, public.ai_agents from authenticated, anon, public;
grant select on public.whatsapp_outbound_messages, public.quick_replies, public.custom_fields, public.global_variables, public.ai_agents to authenticated;
