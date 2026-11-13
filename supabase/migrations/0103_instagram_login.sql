-- Instagram com login direto (sem página do Facebook), comentário que vira Direct e story.
-- * meta_channels.auth: 'page' (login do Facebook, token da página) ou 'ig_login' (login do Instagram, token de 60 dias renovado sozinho)
-- * leads.ig_comment_id: último comentário do lead ainda sem resposta privada (a 1ª mensagem do fluxo sai como resposta a ele)
-- * ig_comment_events: cada comentário recebido uma vez só (o Instagram reenvia avisos)

alter table public.meta_channels add column if not exists auth text not null default 'page';
alter table public.meta_channels drop constraint if exists meta_channels_auth_check;
alter table public.meta_channels add constraint meta_channels_auth_check check (auth in ('page', 'ig_login'));
alter table public.meta_channels add column if not exists token_expires_at timestamptz;
alter table public.meta_channels alter column page_id drop not null;

alter table public.leads add column if not exists ig_comment_id text;
alter table public.leads add column if not exists ig_comment_at timestamptz;

create table if not exists public.ig_comment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  meta_channel_id uuid references public.meta_channels(id) on delete set null,
  comment_id text not null unique,
  media_id text,
  lead_id uuid references public.leads(id) on delete set null,
  body text,
  flows_started int not null default 0,
  public_reply text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ig_comment_events_org on public.ig_comment_events (organization_id, created_at desc);
alter table public.ig_comment_events enable row level security;
revoke all on public.ig_comment_events from authenticated, anon, public;
