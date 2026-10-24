-- 0078_more_pix_gateways.sql
-- Kobly — mais gateways de Pix no bloco Cobrança: PushinPay e SyncPay (mesmo contrato de Mercado Pago e Woovi).
alter table public.payment_integrations drop constraint if exists payment_integrations_provider_check;
alter table public.payment_integrations add constraint payment_integrations_provider_check check (provider in ('xpag', 'mercadopago', 'woovi', 'pushinpay', 'syncpay'));
