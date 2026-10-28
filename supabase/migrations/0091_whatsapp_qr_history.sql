-- WhatsApp por QR Code (Uazapi): todas as conversas do número entram em Conversas.
-- * Quem manda mensagem e ainda não é lead vira lead (utm_source = whatsapp).
-- * O que a empresa responde pelo próprio celular entra como saída "celular".
-- * Ao conectar, a Kobly puxa o histórico recente (history_* acompanham a importação).

alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_messages_source_check;
alter table public.whatsapp_outbound_messages add constraint whatsapp_outbound_messages_source_check
  check (source in ('fluxo', 'agente', 'humano', 'celular'));
create index if not exists idx_whatsapp_outbound_wa on public.whatsapp_outbound_messages (organization_id, wa_message_id) where wa_message_id is not null;

alter table public.whatsapp_uazapi_instances add column if not exists history_status text check (history_status in ('running', 'done', 'error'));
alter table public.whatsapp_uazapi_instances add column if not exists history_count int not null default 0;
alter table public.whatsapp_uazapi_instances add column if not exists history_at timestamptz;
alter table public.whatsapp_uazapi_instances add column if not exists history_error text;
