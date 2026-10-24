-- 0073_postback_signature.sql
-- Kobly — postback sem depender só do token na URL.
--
-- O token pbk_ na URL é um segredo que vaza em logs (servidor, proxy, plataforma). Com ele, alguém
-- forjaria eventos (ex.: "Compra Aprovada" falsa). Agora cada token pode exigir prova no CABEÇALHO:
--   • X-Kobly-Signature: t=<unix>,v1=<hex HMAC-SHA256(signing_secret, "<t>.<corpo>")>  (±5 min)
--   • X-HOTMART-HOTTOK = hottok cadastrado (o "Hottok" da conta Hotmart)
-- Compatibilidade: tokens sem require_signature continuam aceitando só a URL (modo legado), mas
-- assinatura/hottok INVÁLIDOS são sempre recusados, e o uso sem assinatura fica registrado em
-- last_unsigned_at para a tela avisar. Com require_signature = true, a URL sozinha não vale mais.

alter table public.postback_tokens
  add column if not exists signing_secret text not null default encode(gen_random_bytes(32), 'hex'),
  add column if not exists hottok text check (hottok is null or char_length(hottok) between 8 and 200),
  add column if not exists require_signature boolean not null default false,
  add column if not exists last_unsigned_at timestamptz;

comment on column public.postback_tokens.signing_secret is 'Segredo do HMAC do cabeçalho X-Kobly-Signature. Nunca vai na URL.';
comment on column public.postback_tokens.hottok is 'Hottok da Hotmart: o aviso precisa trazer X-HOTMART-HOTTOK igual.';
comment on column public.postback_tokens.require_signature is 'true = recusa aviso sem assinatura válida ou hottok (URL sozinha não basta).';
comment on column public.postback_tokens.last_unsigned_at is 'Último aviso aceito só pelo token da URL (modo legado) — a tela usa para avisar.';
