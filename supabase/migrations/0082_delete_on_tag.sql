-- 0082_delete_on_tag.sql
-- Kobly — "Apagar mensagem ao aplicar etiqueta" nos blocos de texto e mídia dos fluxos.
-- Ao enviar pelo WhatsApp por QR Code (Uazapi), a Kobly guarda o id da mensagem e a etiqueta escolhida.
-- Quando essa etiqueta entra no lead (pelo fluxo OU à mão na tela de Leads), o gatilho marca a mensagem
-- como "a apagar" e o servidor apaga no WhatsApp na próxima volta do motor.
-- A API oficial da Meta não permite apagar mensagem enviada: lá a opção não tem efeito.

create table public.flow_message_deletions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  instance_id uuid references public.whatsapp_uazapi_instances(id) on delete cascade,
  wa_message_id text not null,
  status text not null default 'waiting' check (status in ('waiting', 'due', 'done', 'failed')),
  attempts integer not null default 0,
  last_error text,
  due_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_flow_msg_del_wait on public.flow_message_deletions (lead_id, tag_id) where status = 'waiting';
create index idx_flow_msg_del_due on public.flow_message_deletions (due_at) where status = 'due';

create or replace function public.tg_lead_tag_delete_messages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.flow_message_deletions set status = 'due', due_at = now()
   where lead_id = new.lead_id and tag_id = new.tag_id and status = 'waiting';
  return new;
end;
$$;
revoke all on function public.tg_lead_tag_delete_messages() from public, anon, authenticated;
create trigger lead_tags_delete_messages after insert on public.lead_tags
  for each row execute function public.tg_lead_tag_delete_messages();

alter table public.flow_message_deletions enable row level security;
create policy flow_message_deletions_select on public.flow_message_deletions for select to authenticated using (public.has_org_access(organization_id));
revoke all on public.flow_message_deletions from authenticated, anon, public;
grant select on public.flow_message_deletions to authenticated;
