-- WhatsApp oficial com UM CLIQUE ("Conectar com Facebook" / Cadastro incorporado da Meta).
-- A conta conectada assim usa o app da Kobly (Provedor de Tecnologia): os avisos chegam no webhook do app
-- (/webhooks/whatsapp-app, assinado com o segredo do app da Kobly) e o cliente não configura nada na Meta.
alter table public.whatsapp_accounts add column if not exists embedded boolean not null default false;
create index if not exists idx_whatsapp_accounts_waba on public.whatsapp_accounts (waba_id);
