-- 0097_bulk_schedule.sql
-- Kobly — Disparo agendado: além de "agora", o disparo pode sair UMA VEZ num dia e hora, ou TODO DIA num
-- período (ex.: Black Friday de 20 a 30/11, todo dia às 9h). Na repetição diária só os leads que entraram no
-- público desde o último envio recebem (a linha única por lead em bulk_send_recipients garante isso).
-- Status novos: agendado (esperando o horário) e pausado.

alter table public.bulk_sends
  add column agenda text not null default 'agora' check (agenda in ('agora', 'uma_vez', 'diario')),
  add column start_at timestamptz,           -- uma_vez: quando sai; diario: primeiro dia (com o horário)
  add column end_date date,                  -- diario: último dia (inclusive)
  add column send_time time,                 -- diario: horário de cada dia (fuso de São Paulo)
  add column next_run_at timestamptz,        -- próxima vez que o servidor monta a fila
  add column last_run_at timestamptz,
  add column runs int not null default 0;

create index if not exists idx_bulk_sends_next_run on public.bulk_sends (next_run_at) where status = 'agendado';
