-- 0087_meta_ads_oauth.sql
-- Kobly — "Conectar com Facebook": o login do Facebook devolve um token que fica guardado aqui (cifrado)
-- por alguns minutos, até o cliente escolher quais contas de anúncios ligar. Só o serviço lê e escreve.

create table public.meta_ads_oauth (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  token_enc text not null,
  user_name text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.meta_ads_oauth enable row level security;
revoke all on public.meta_ads_oauth from authenticated, anon, public;
