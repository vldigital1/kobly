-- 0083_uazapi_profile.sql
-- Kobly — cartão da conexão de WhatsApp por QR Code mais completo: foto e tipo do perfil, último sinal
-- do número e motivo da última desconexão (vêm do /instance/status e dos avisos "connection" da Uazapi).

alter table public.whatsapp_uazapi_instances
  add column profile_pic_url text,
  add column is_business boolean,
  add column last_seen_at timestamptz,
  add column disconnect_reason text;

grant select (profile_pic_url, is_business, last_seen_at, disconnect_reason) on public.whatsapp_uazapi_instances to authenticated;
