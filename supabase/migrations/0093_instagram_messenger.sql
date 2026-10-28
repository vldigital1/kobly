-- Instagram Direct e Messenger: a empresa conecta a página do Facebook (e o Instagram ligado a ela) com um clique.
-- As conversas entram na mesma caixa do Chat ao vivo e nos mesmos fluxos que o WhatsApp.
-- * meta_channels: página/Instagram conectados (token da página cifrado)
-- * meta_channel_oauth: login do Facebook à espera da escolha das páginas (30 min)
-- * leads.ig_user_id / leads.fb_psid: quem conversa pelo Instagram/Messenger (não tem telefone)
-- * leads.chat_channel: por onde a conversa com o lead acontece

create table public.meta_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('instagram', 'messenger')),
  page_id text not null,
  external_id text not null,            -- id da página (Messenger) ou da conta do Instagram
  name text,
  username text,
  picture_url text,
  token_enc text not null,
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  created_at timestamptz not null default now(),
  unique (kind, external_id)
);
create index idx_meta_channels_org on public.meta_channels (organization_id);
alter table public.meta_channels enable row level security;
revoke all on public.meta_channels from authenticated, anon, public;

create table public.meta_channel_oauth (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  token_enc text not null,
  user_name text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.meta_channel_oauth enable row level security;
revoke all on public.meta_channel_oauth from authenticated, anon, public;

alter table public.leads add column if not exists ig_user_id text;
alter table public.leads add column if not exists ig_username text;
alter table public.leads add column if not exists fb_psid text;
alter table public.leads add column if not exists chat_channel text check (chat_channel in ('whatsapp', 'instagram', 'messenger'));
create unique index if not exists leads_org_ig_user on public.leads (organization_id, ig_user_id) where ig_user_id is not null;
create unique index if not exists leads_org_fb_psid on public.leads (organization_id, fb_psid) where fb_psid is not null;

alter table public.whatsapp_inbound_messages add column if not exists meta_channel_id uuid references public.meta_channels(id) on delete cascade;
alter table public.whatsapp_inbound_messages drop constraint if exists whatsapp_inbound_channel;
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_channel check (account_id is not null or instance_id is not null or meta_channel_id is not null);

alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_messages_channel_check;
alter table public.whatsapp_outbound_messages add constraint whatsapp_outbound_messages_channel_check check (channel in ('oficial', 'uazapi', 'instagram', 'messenger'));
alter table public.whatsapp_outbound_messages add column if not exists meta_channel_id uuid references public.meta_channels(id) on delete set null;
