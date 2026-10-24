-- 0071_notification_channels.sql
-- Kobly — Fase 4 do motor de fluxos: canais de alerta para a equipe (bloco "Alerta").
-- Telegram por bot próprio da empresa; o token fica CIFRADO e não é legível pelo cliente.

create table public.notification_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('telegram')),
  label text not null,
  token_enc text not null,
  default_chat_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.notification_channels for each row execute function public.tg_set_updated_at();
create index idx_notification_channels_org on public.notification_channels (organization_id);

alter table public.notification_channels enable row level security;
create policy notification_channels_select on public.notification_channels for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.notification_channels from authenticated, anon, public;
grant select (id, organization_id, kind, label, default_chat_id, created_at, updated_at) on public.notification_channels to authenticated;
