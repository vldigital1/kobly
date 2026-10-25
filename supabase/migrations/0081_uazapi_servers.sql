-- 0081_uazapi_servers.sql
-- Kobly — vários servidores Uazapi (WhatsApp por QR Code). Cada servidor tem um limite de números
-- (ex.: Servidor PRO = 300). Um número novo vai para o servidor ativo com mais folga; quando todos
-- enchem, o administrador da Kobly adiciona outro servidor. O servidor do ambiente (UAZAPI_BASE_URL)
-- continua valendo como mais um servidor (server_id nulo).
-- Só o serviço lê e escreve (o admintoken fica cifrado; nem o Administrador lê o token de volta).

create table public.uazapi_servers (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  base_url text not null unique check (base_url ~ '^https://'),
  admin_token_enc text not null,
  token_hint text not null,
  capacity integer not null default 300 check (capacity between 1 and 100000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.uazapi_servers for each row execute function public.tg_set_updated_at();
alter table public.uazapi_servers enable row level security;
revoke all on public.uazapi_servers from authenticated, anon, public;

alter table public.whatsapp_uazapi_instances add column if not exists server_id uuid references public.uazapi_servers(id) on delete restrict;
create index if not exists idx_uazapi_instances_server on public.whatsapp_uazapi_instances (server_id);
