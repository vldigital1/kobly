-- 0084_uazapi_pause_flows.sql
-- Kobly — "Pausar fluxos ao desconectar" na conexão de WhatsApp por QR Code.
-- Se o número cair e a empresa ficar sem nenhum WhatsApp conectado, os fluxos ativos são pausados
-- (para não acumular envios falhos) e os ids ficam guardados; ao reconectar, só esses voltam a rodar.

alter table public.whatsapp_uazapi_instances
  add column pause_flows_on_disconnect boolean not null default false,
  add column paused_campaigns uuid[] not null default '{}';

grant select (pause_flows_on_disconnect) on public.whatsapp_uazapi_instances to authenticated;
