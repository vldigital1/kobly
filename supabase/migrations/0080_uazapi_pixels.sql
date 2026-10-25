-- 0080_uazapi_pixels.sql
-- Kobly — Conexões e Trackeamento.
-- * WhatsApp não oficial pela Uazapi (QR Code): uma instância por número, criada no servidor Uazapi da
--   Kobly (admintoken fica no ambiente do servidor). O token da instância fica cifrado.
-- * Mensagens recebidas pela Uazapi entram na mesma caixa de entrada (whatsapp_inbound_messages), agora com
--   account_id (oficial) OU instance_id (Uazapi); as enviadas guardam o canal.
-- * Pixels por plataforma: Meta (API de Conversões), TikTok (Events API) e Google (GA4 Measurement Protocol).

create table public.whatsapp_uazapi_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null,
  instance_name text not null unique,
  token_enc text not null,
  webhook_public_id uuid not null unique default gen_random_uuid(),
  status text not null default 'disconnected' check (status in ('disconnected', 'connecting', 'connected', 'hibernated')),
  phone text,
  profile_name text,
  last_error text,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_uazapi_instances_org on public.whatsapp_uazapi_instances (organization_id);
create trigger set_updated_at before update on public.whatsapp_uazapi_instances for each row execute function public.tg_set_updated_at();
alter table public.whatsapp_uazapi_instances enable row level security;
create policy uazapi_instances_select on public.whatsapp_uazapi_instances for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.whatsapp_uazapi_instances from authenticated, anon, public;
grant select (id, organization_id, label, status, phone, profile_name, last_error, connected_at, created_at, updated_at) on public.whatsapp_uazapi_instances to authenticated;

alter table public.whatsapp_inbound_messages alter column account_id drop not null;
alter table public.whatsapp_inbound_messages add column if not exists instance_id uuid references public.whatsapp_uazapi_instances(id) on delete cascade;
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_channel check (account_id is not null or instance_id is not null);
alter table public.whatsapp_outbound_messages add column if not exists channel text not null default 'oficial' check (channel in ('oficial', 'uazapi'));

alter table public.pixel_configs add column if not exists provider text not null default 'meta' check (provider in ('meta', 'tiktok', 'google'));
alter table public.pixel_configs drop constraint if exists pixel_configs_pixel_id_check;
alter table public.pixel_configs add constraint pixel_configs_pixel_id_check check (
  (provider = 'meta' and pixel_id ~ '^\d{5,25}$')
  or (provider = 'tiktok' and pixel_id ~ '^[A-Z0-9]{10,40}$')
  or (provider = 'google' and pixel_id ~ '^G-[A-Z0-9]{4,20}$')
);
