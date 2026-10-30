-- 0098_flow_message_trigger.sql
-- Kobly — Fluxo que começa por mensagem no WhatsApp (qualquer texto ou palavras-chave) e as variáveis do anúncio
-- que trouxe o lead (Click-to-WhatsApp: {{source_id}}, {{ctwa_clid}}, {{ad_source_url}}, {{ad_title}}, {{ad_body}}).

alter table public.leads add column if not exists ad_origin jsonb;   -- último anúncio de origem (referral da Meta)
