-- Conversas: mídia de verdade (áudio, vídeo, imagem, arquivo), foto do contato e ferramentas do chat.
-- * tipo e link da mídia nas mensagens (o link da Uazapi vale 2 dias: media_at diz quando foi buscado)
-- * foto do contato no WhatsApp (avatar_url, atualizada a cada 24 h)
-- * notas, arquivar e limpar conversa (some só da tela da Kobly; nada é apagado no WhatsApp)

alter table public.whatsapp_inbound_messages add column if not exists media_url text;
alter table public.whatsapp_inbound_messages add column if not exists media_at timestamptz;

alter table public.whatsapp_outbound_messages add column if not exists msg_type text not null default 'text';
alter table public.whatsapp_outbound_messages add column if not exists media_url text;
alter table public.whatsapp_outbound_messages add column if not exists media_at timestamptz;
alter table public.whatsapp_outbound_messages add column if not exists instance_id uuid references public.whatsapp_uazapi_instances(id) on delete set null;

alter table public.leads add column if not exists avatar_url text;
alter table public.leads add column if not exists avatar_at timestamptz;
alter table public.leads add column if not exists chat_notes text;
alter table public.leads add column if not exists chat_archived_at timestamptz;
alter table public.leads add column if not exists chat_cleared_at timestamptz;
