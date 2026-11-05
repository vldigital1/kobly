-- Agentes de voz e ligações.
-- voice_agents: o agente (nome, provedor ElevenLabs/OpenAI, voz, instruções, primeira frase, saídas). Na ElevenLabs a
--   Kobly cria/atualiza o agente na conta do cliente (elevenlabs_agent_id).
-- voice_call_settings: número de ligação da ElevenLabs (WhatsApp ligado lá) + modelo de pedido de permissão; OpenAI
--   para atender quem liga (projeto + segredo do webhook).
-- voice_calls: cada ligação feita pelo bloco Ligação (ou recebida pela OpenAI), com o resultado.
create table public.voice_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  provider text not null default 'elevenlabs' check (provider in ('elevenlabs', 'openai')),
  voice_id text,
  voice_name text,
  language text not null default 'pt',
  instructions text not null default '',
  first_message text not null default '',
  outcomes jsonb not null default '[]'::jsonb,
  max_duration_s int not null default 300 check (max_duration_s between 30 and 3600),
  silence_timeout_s int not null default 20 check (silence_timeout_s between 5 and 120),
  elevenlabs_agent_id text,
  sync_error text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_voice_agents_org on public.voice_agents (organization_id, created_at);

create table public.voice_call_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  el_phone_number_id text,
  el_phone_label text,
  permission_template text,
  permission_language text not null default 'pt_BR',
  openai_project_id text,
  openai_webhook_secret_enc text,
  openai_agent_id uuid references public.voice_agents(id) on delete set null,
  openai_webhook_id uuid not null unique default gen_random_uuid(),
  updated_at timestamptz not null default now()
);

create table public.voice_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  execution_id uuid references public.flow_executions(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  voice_agent_id uuid references public.voice_agents(id) on delete set null,
  provider text not null check (provider in ('elevenlabs', 'openai', 'uazapi')),
  direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  external_id text,
  phone text,
  status text not null default 'pending' check (status in ('pending', 'done')),
  result text check (result in ('answered', 'no_answer', 'rejected')),
  outcome text,
  duration_s int,
  summary text,
  transcript text,
  error text,
  check_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index idx_voice_calls_pending on public.voice_calls (check_after) where status = 'pending';
create index idx_voice_calls_org on public.voice_calls (organization_id, created_at desc);

alter table public.voice_agents enable row level security;
alter table public.voice_call_settings enable row level security;
alter table public.voice_calls enable row level security;
