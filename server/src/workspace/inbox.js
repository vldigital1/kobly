// Rota POST /functions/v1/inbox: Chats ao vivo do WhatsApp oficial.
// Conversa = o que o lead mandou (whatsapp_inbound_messages) + o que a Kobly mandou
// (whatsapp_outbound_messages: fluxo, agente de IA ou uma pessoa). Responder em texto livre só
// com a janela de 24 h aberta (regra da Meta). Assumir o chat pausa a automação do lead.
import { AuthError } from '../auth.js';
import { isWindowOpen } from '../flows/vars.js';

const UUID = /^[0-9a-f-]{36}$/i;

export function createInbox({ pool, whatsapp, now = () => new Date() }) {
  const canAct = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode responder conversas.'); };
  async function leadOf(orgId, leadId) {
    if (!UUID.test(String(leadId || ''))) throw new AuthError(422, 'validation_failed', 'Informe o lead.');
    const l = (await pool.query(`select id, nome, sobrenome, email, telefone, produto, whatsapp_last_inbound_at, whatsapp_opt_out, automation_paused
      from public.leads where id = $1 and organization_id = $2`, [leadId, orgId])).rows[0];
    if (!l) throw new AuthError(404, 'not_found', 'Lead não encontrado.');
    return l;
  }
  const view = (l) => ({ ...l, janela_aberta: isWindowOpen(l.whatsapp_last_inbound_at, now()) });

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'list': { // uma linha por lead com a última mensagem (de qualquer lado)
        const q = typeof body.q === 'string' ? body.q.trim().slice(0, 80) : '';
        const { rows } = await pool.query(`
          with msgs as (
            select lead_id, body, received_at as at, 'lead' as de from public.whatsapp_inbound_messages where organization_id = $1 and lead_id is not null
            union all
            select lead_id, body, created_at as at, source as de from public.whatsapp_outbound_messages where organization_id = $1 and lead_id is not null
          ), ult as (
            select distinct on (lead_id) lead_id, body, at, de from msgs order by lead_id, at desc
          )
          select l.id as lead_id, l.nome, l.sobrenome, l.telefone, l.whatsapp_last_inbound_at, l.automation_paused, l.valor_compra,
                 u.body as ultima, u.at as ultima_em, u.de as ultima_de,
                 exists (select 1 from public.flow_executions e where e.lead_id = l.id and e.status in ('running','waiting')) as em_fluxo
            from ult u join public.leads l on l.id = u.lead_id
           where ($2 = '' or l.nome ilike '%' || $2 || '%' or l.telefone ilike '%' || $2 || '%' or l.email ilike '%' || $2 || '%')
             and ($3 = 'todas' or ($3 = 'aguardando' and u.de = 'lead') or ($3 = 'humano' and l.automation_paused)
               or ($3 = 'fluxo' and exists (select 1 from public.flow_executions e where e.lead_id = l.id and e.status in ('running','waiting'))))
           order by u.at desc limit 200`, [orgId, q, ['aguardando', 'humano', 'fluxo'].includes(body.filtro) ? body.filtro : 'todas']);
        return { conversations: rows.map((r) => ({ ...r, janela_aberta: isWindowOpen(r.whatsapp_last_inbound_at, now()) })) };
      }
      case 'messages': {
        const lead = await leadOf(orgId, body.lead_id);
        const { rows } = await pool.query(`
          select * from (
            select id::text, 'lead' as de, body, msg_type as tipo, received_at as at from public.whatsapp_inbound_messages where organization_id = $1 and lead_id = $2
            union all
            select id::text, source as de, body, 'text' as tipo, created_at as at from public.whatsapp_outbound_messages where organization_id = $1 and lead_id = $2
          ) m order by at desc limit 300`, [orgId, lead.id]);
        const flows = (await pool.query(`select e.id, e.status, e.current_ref, e.wait_kind, c.nome as campanha from public.flow_executions e join public.campaigns c on c.id = e.campaign_id
          where e.lead_id = $1 and e.organization_id = $2 and e.status in ('running','waiting')`, [lead.id, orgId])).rows;
        // WhatsApp por QR Code (sem API oficial): não há janela de 24 h
        const livre = whatsapp.freeTextAllowed ? await whatsapp.freeTextAllowed(orgId) : false;
        const extra = (await pool.query(`select l.valor_compra, l.link_recuperacao, l.created_at, l.utm,
            coalesce((select json_agg(json_build_object('id', t.id, 'nome', t.nome) order by t.nome) from public.lead_tags lt join public.tags t on t.id = lt.tag_id where lt.lead_id = l.id), '[]') as tags,
            coalesce((select json_agg(x order by x.em desc) from (select w.tipo_evento as tipo, w.produto, w.valor_produto as valor, w.created_at as em from public.webhook_events w where w.lead_id = l.id order by w.created_at desc limit 6) x), '[]') as eventos
          from public.leads l where l.id = $1`, [lead.id])).rows[0] || {};
        return { lead: { ...view(lead), ...extra, ...(livre ? { janela_aberta: true } : {}) }, messages: rows.reverse(), flows };
      }
      case 'send': {
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        const msg = typeof body.text === 'string' ? body.text.trim() : '';
        if (!msg) throw new AuthError(422, 'empty_text', 'Escreva a mensagem.');
        if (msg.length > 4096) throw new AuthError(422, 'validation_failed', 'Mensagem até 4096 caracteres.');
        if (lead.whatsapp_opt_out) throw new AuthError(409, 'opt_out', 'Este lead pediu para não receber WhatsApp.');
        const livre = whatsapp.freeTextAllowed ? await whatsapp.freeTextAllowed(orgId) : false; // WhatsApp por QR Code: sem janela
        if (!livre && !isWindowOpen(lead.whatsapp_last_inbound_at, now())) throw new AuthError(409, 'window_closed', 'A janela de 24 h está fechada: o lead precisa mandar uma mensagem antes (ou use um modelo aprovado num fluxo).');
        if (!lead.telefone) throw new AuthError(422, 'bad_phone', 'Lead sem telefone.');
        const out = await whatsapp.sendTextTo(orgId, { to: lead.telefone, text: msg });
        const r = await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, wa_message_id, sent_by, channel)
          values ($1,$2,$3,'humano',$4,$5,$6,$7) returning id::text, 'humano' as de, body, 'text' as tipo, created_at as at`, [orgId, lead.id, out.to || lead.telefone, msg, out.id || null, (user && user.id) || null, out.channel === 'uazapi' ? 'uazapi' : 'oficial']);
        return { ok: true, message: r.rows[0] };
      }
      case 'send_media': { // imagem, vídeo, áudio ou arquivo (link público, ex.: o arquivo enviado na hora pelo chat)
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        if (lead.whatsapp_opt_out) throw new AuthError(409, 'opt_out', 'Este lead pediu para não receber WhatsApp.');
        if (!lead.telefone) throw new AuthError(422, 'bad_phone', 'Lead sem telefone.');
        const kind = ['image', 'video', 'audio', 'document'].includes(body.kind) ? body.kind : 'document';
        const url = String(body.url || '').trim();
        if (!/^https?:\/\/\S+$/i.test(url)) throw new AuthError(422, 'validation_failed', 'Arquivo inválido.');
        const caption = typeof body.caption === 'string' && kind !== 'audio' ? body.caption.trim().slice(0, 1024) : '';
        const livre = whatsapp.freeTextAllowed ? await whatsapp.freeTextAllowed(orgId) : false;
        if (!livre && !isWindowOpen(lead.whatsapp_last_inbound_at, now())) throw new AuthError(409, 'window_closed', 'A janela de 24 h está fechada: o lead precisa mandar uma mensagem antes.');
        const out = await whatsapp.sendMediaTo(orgId, { to: lead.telefone, kind, url, caption: caption || undefined, filename: body.filename ? String(body.filename).slice(0, 120) : undefined });
        const label = { image: 'imagem', video: 'vídeo', audio: 'áudio', document: 'arquivo' }[kind];
        const r = await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, wa_message_id, sent_by, channel)
          values ($1,$2,$3,'humano',$4,$5,$6,$7) returning id::text, 'humano' as de, body, 'text' as tipo, created_at as at`,
          [orgId, lead.id, out.to || lead.telefone, `[${label}] ${caption || url.split('/').pop()}`, out.id || null, (user && user.id) || null, out.channel === 'uazapi' ? 'uazapi' : 'oficial']);
        return { ok: true, message: r.rows[0] };
      }
      case 'tags': { // adicionar/remover etiquetas do lead pelo chat
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        const ids = (a) => (Array.isArray(a) ? a : []).filter((x) => UUID.test(String(x)));
        if (ids(body.add).length) await pool.query(`insert into public.lead_tags (lead_id, tag_id) select $1, t.id from public.tags t where t.organization_id = $2 and t.id = any($3::uuid[]) on conflict do nothing`, [lead.id, orgId, ids(body.add)]);
        if (ids(body.remove).length) await pool.query(`delete from public.lead_tags where lead_id = $1 and tag_id = any($2::uuid[])`, [lead.id, ids(body.remove)]);
        return { ok: true };
      }
      case 'pause': { // assumir (paused=true) ou devolver para a automação (false)
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        const paused = body.paused !== false;
        await pool.query(`update public.leads set automation_paused = $2 where id = $1`, [lead.id, paused]);
        let cancelled = 0;
        if (paused) {
          const r = await pool.query(`update public.flow_executions set status = 'cancelled', finished_at = now(), lease_until = null, last_error = 'atendimento humano no chat ao vivo'
            where lead_id = $1 and organization_id = $2 and status in ('running','waiting')`, [lead.id, orgId]);
          cancelled = r.rowCount;
        }
        return { ok: true, paused, cancelled };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
