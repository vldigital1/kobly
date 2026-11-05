-- Proxy por número (Uazapi): padrão da Uazapi ou um proxy do cliente (endereço guardado cifrado).
alter table public.whatsapp_uazapi_instances
  add column if not exists proxy_mode text not null default 'uazapi' check (proxy_mode in ('uazapi', 'custom')),
  add column if not exists proxy_url_enc text,
  add column if not exists proxy_display text,
  add column if not exists proxy_checked_at timestamptz;
