-- Vários números da API Oficial por empresa (antes era um só) e de qual número saiu cada mensagem.
-- Cada número oficial continua único no sistema inteiro (não pode estar em duas empresas).
alter table public.whatsapp_accounts drop constraint if exists whatsapp_accounts_organization_id_key;
create index if not exists whatsapp_accounts_org_idx on public.whatsapp_accounts (organization_id);
create unique index if not exists whatsapp_accounts_phone_number_id_key on public.whatsapp_accounts (phone_number_id);

-- mensagem enviada pela API Oficial: por qual número (o QR Code já guarda instance_id; Instagram/Messenger, meta_channel_id)
alter table public.whatsapp_outbound_messages add column if not exists account_id uuid references public.whatsapp_accounts(id) on delete set null;
create index if not exists whatsapp_inbound_lead_at_idx on public.whatsapp_inbound_messages (lead_id, received_at desc);
