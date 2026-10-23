-- 0069_flow_graph_engine.sql
-- Kobly — Fase 1 do novo motor de fluxos: fluxo em GRAFO (blocos + saídas nomeadas),
-- execução por lead com estado (onde parou, variáveis, o que está esperando) e caixa de
-- entrada do WhatsApp (o fluxo passa a ler o que o lead responde).
--
-- Convive com o motor antigo: campanha sem versão de grafo ativa continua no caminho
-- linear (flow_steps + scheduled_steps). Toda escrita destas tabelas passa pelo serviço
-- (rota flow-graph / motor); o cliente só lê, sempre filtrado pela RLS da empresa.

-- Fuso da empresa: condições de horário/dia da semana e intervalos usam este fuso.
alter table public.organizations add column if not exists timezone text not null default 'America/Sao_Paulo';

-- Janela de 24 h da API oficial: a última mensagem recebida do lead abre a janela.
alter table public.leads add column if not exists whatsapp_last_inbound_at timestamptz;

-- Versões do grafo de cada fluxo (histórico + desfazer). Só UMA ativa por fluxo.
create table public.flow_graph_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.campaign_flows(id) on delete cascade,
  version int not null,
  graph jsonb not null,
  is_active boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (flow_id, version)
);
create unique index flow_graph_versions_one_active on public.flow_graph_versions (flow_id) where is_active;
create index idx_flow_graph_versions_org on public.flow_graph_versions (organization_id);

-- Execução de um fluxo para UM lead.
create table public.flow_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  flow_id uuid not null references public.campaign_flows(id) on delete cascade,
  graph_version_id uuid not null references public.flow_graph_versions(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  webhook_event_id uuid references public.webhook_events(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_ref text not null,
  variables jsonb not null default '{}'::jsonb,
  -- espera: 'timer' (delay/intervalo) ou 'reply' (aguardar resposta); resume_exit = saída a seguir ao retomar
  wait_kind text check (wait_kind in ('timer', 'reply')),
  resume_exit text,
  run_at timestamptz not null default now(),
  lease_until timestamptz,
  stop_on_purchase boolean not null default false,
  steps_count int not null default 0,
  attempts int not null default 0,
  last_error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.flow_executions
  for each row execute function public.tg_set_updated_at();
-- um lead tem no máximo UMA execução viva por campanha (reentrega/novo evento não duplica)
create unique index flow_executions_one_alive on public.flow_executions (campaign_id, lead_id) where status in ('running', 'waiting');
create index idx_flow_executions_due on public.flow_executions (run_at) where status in ('running', 'waiting');
create index idx_flow_executions_lead_waiting on public.flow_executions (lead_id) where status = 'waiting' and wait_kind = 'reply';
create index idx_flow_executions_org on public.flow_executions (organization_id, created_at desc);

-- Trilha de cada bloco executado: depuração e contagem de leads por ponto do funil.
create table public.flow_execution_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  execution_id uuid not null references public.flow_executions(id) on delete cascade,
  flow_id uuid not null references public.campaign_flows(id) on delete cascade,
  ref text not null,
  node_type text not null,
  outcome text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index idx_flow_execution_events_exec on public.flow_execution_events (execution_id, id);
create index idx_flow_execution_events_flow_ref on public.flow_execution_events (flow_id, ref);

-- Caixa de entrada: tudo que o lead manda pelo WhatsApp oficial.
create table public.whatsapp_inbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  wa_message_id text not null unique,
  from_phone text not null,
  lead_id uuid references public.leads(id) on delete set null,
  msg_type text not null,
  body text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);
create index idx_whatsapp_inbound_org on public.whatsapp_inbound_messages (organization_id, received_at desc);
create index idx_whatsapp_inbound_lead on public.whatsapp_inbound_messages (lead_id, received_at desc);

-- RLS: leitura pela empresa; escrita só pelo serviço.
alter table public.flow_graph_versions enable row level security;
alter table public.flow_executions enable row level security;
alter table public.flow_execution_events enable row level security;
alter table public.whatsapp_inbound_messages enable row level security;
create policy flow_graph_versions_select on public.flow_graph_versions for select to authenticated using (public.has_org_access(organization_id));
create policy flow_executions_select on public.flow_executions for select to authenticated using (public.has_org_access(organization_id));
create policy flow_execution_events_select on public.flow_execution_events for select to authenticated using (public.has_org_access(organization_id));
create policy whatsapp_inbound_select on public.whatsapp_inbound_messages for select to authenticated using (public.has_org_access(organization_id));

revoke all on public.flow_graph_versions, public.flow_executions, public.flow_execution_events, public.whatsapp_inbound_messages from authenticated, anon, public;
grant select on public.flow_graph_versions, public.flow_executions, public.flow_execution_events, public.whatsapp_inbound_messages to authenticated;
