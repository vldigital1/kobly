-- 0086_pipeline_stage.sql
-- Kobly — Pipeline de WhatsApp e vendas. A etapa do lead é calculada pelo que aconteceu (mensagens, respostas,
-- cobrança, compra); quando alguém arrasta o cartão para outra coluna, a etapa escolhida fica guardada aqui
-- e vale até alguém mudar de novo (ou limpar).

alter table public.leads add column etapa_pipeline text
  check (etapa_pipeline in ('novo', 'contato', 'respondeu', 'cobranca', 'comprou', 'perdido'));
