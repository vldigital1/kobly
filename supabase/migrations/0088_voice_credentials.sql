-- 0088_voice_credentials.sql
-- Kobly — voz com a chave ElevenLabs do próprio cliente: gerar áudio a partir de um texto nos blocos de
-- mídia e traduzir um fluxo inteiro (textos e áudios) para outro idioma. A chave fica cifrada; o cliente
-- só vê o final dela. Uma chave por empresa.

create table public.voice_credentials (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'elevenlabs' check (provider in ('elevenlabs')),
  key_enc text not null,
  key_hint text not null,
  voice_id text,
  voice_name text,
  status text not null default 'ok' check (status in ('ok', 'error')),
  last_error text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.voice_credentials for each row execute function public.tg_set_updated_at();

alter table public.voice_credentials enable row level security;
create policy voice_credentials_select on public.voice_credentials for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.voice_credentials from authenticated, anon, public;
grant select (organization_id, provider, key_hint, voice_id, voice_name, status, last_error, last_used_at, created_at, updated_at) on public.voice_credentials to authenticated;
