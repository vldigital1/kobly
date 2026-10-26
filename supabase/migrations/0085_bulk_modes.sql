-- 0085_bulk_modes.sql
-- Kobly — Disparo em massa no servidor novo: além de e-mail e WhatsApp, iniciar um FLUXO para cada lead,
-- e lista colada à mão (nome, telefone, e-mail) além dos filtros por etiqueta e evento.

alter table public.bulk_sends
  add column modo text not null default 'email' check (modo in ('email', 'whatsapp', 'fluxo')),
  add column campaign_id uuid references public.campaigns(id) on delete set null,
  add column texto text,
  add column nome text,
  add column origem text not null default 'filtro' check (origem in ('filtro', 'manual')),
  add column finished_at timestamptz;

create index if not exists idx_bulk_send_recipients_pend on public.bulk_send_recipients (run_at) where status = 'pendente';
