// Rota POST /functions/v1/inbox: Chats ao vivo do WhatsApp (API Oficial e QR Code).
// Conversa = o que o lead mandou (whatsapp_inbound_messages) + o que a Kobly ou a empresa mandou
// (whatsapp_outbound_messages: fluxo, agente de IA, uma pessoa pela Kobly ou pelo próprio celular).
// Mídia (áudio, vídeo, imagem, arquivo) abre por link: o da Uazapi vale 2 dias e é buscado de novo quando vence.
// Responder em texto livre só com a janela de 24 h aberta na API Oficial. Assumir o chat pausa a automação do lead.
// Limpar e arquivar mexem só na tela da Kobly; nada é apagado no WhatsApp.
import { AuthError } from '../auth.js';
import { isWindowOpen } from '../flows/vars.js';

const UUID = /^[0-9a-f-]{36}$/i;
const MEDIA_TTL_MS = 40 * 3600 * 1000; // link da Uazapi vale 48 h
const AVATAR_TTL_MS = 24 * 3600 * 1000;

export function createInbox({ pool, whatsapp, flows = null, now = () => new Date() }) {
  const canAct = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode responder conversas.'); };
  async function leadOf(orgId, leadId) {
    if (!UUID.test(String(leadId || ''))) throw new AuthError(422, 'validation_failed', 'Informe o lead.');
    const l = (await pool.query(`select id, nome, sobrenome, email, telefone, produto, whatsapp_last_inbound_at, whatsapp_opt_out, automation_paused,
        avatar_url, chat_notes, chat_archived_at, chat_cleared_at
      from public.leads where id = $1 and organization_id = $2`, [leadId, orgId])).rows[0];
    if (!l) throw new AuthError(404, 'not_found', 'Lead não encontrado.');
    return l;
  }
  const view = (l) => ({ ...l, janela_aberta: isWindowOpen(l.whatsapp_last_inbound_at, now()) });
  const kindOf = (k) => (['image', 'video', 'audio', 'document'].includes(k) ? k : 'document');

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'list': { // uma linha por lead com a última mensagem (de qualquer lado) e quantas o lead mandou sem resposta
        const q = typeof body.q === 'string' ? body.q.trim().slice(0, 80) : '';
        const filtro = ['aguardando', 'humano', 'fluxo', 'arquivadas'].includes(body.filtro) ? body.filtro : 'todas';
        const { rows } = await pool.query(`
          with msgs as (
            select lead_id, body, msg_type as tipo, received_at as at, 'lead' as de from public.whatsapp_inbound_messages where organization_id = $1 and lead_id is not null
            union all
            select lead_id, body, msg_type as tipo, created_at as at, source as de from public.whatsapp_outbound_messages where organization_id = $1 and lead_id is not null
          ), vis as (
            select m.* from msgs m join public.leads l on l.id = m.lead_id where m.at > coalesce(l.chat_cleared_at, '-infinity'::timestamptz)
          ), ult as (
            select distinct on (lead_id) lead_id, body, tipo, at, de from vis order by lead_id, at desc
          ), resp as (
            select lead_id, max(at) as at from vis where de <> 'lead' group by lead_id
          ), unread as (
            select v.lead_id, count(*)::int as n from vis v left join resp r on r.lead_id = v.lead_id
             where v.de = 'lead' and v.at > coalesce(r.at, '-infinity'::timestamptz) group by v.lead_id
          )
          select l.id as lead_id, l.nome, l.sobrenome, l.telefone, l.whatsapp_last_inbound_at, l.automation_paused, l.valor_compra, l.avatar_url,
                 u.body as ultima, u.tipo as ultima_tipo, u.at as ultima_em, u.de as ultima_de, coalesce(n.n, 0) as nao_lidas,
                 (l.chat_archived_at is not null and u.at <= l.chat_archived_at) as arquivada,
                 exists (select 1 from public.flow_executions e where e.lead_id = l.id and e.status in ('running','waiting')) as em_fluxo
            from ult u join public.leads l on l.id = u.lead_id left join unread n on n.lead_id = l.id
           where ($2 = '' or l.nome ilike '%' || $2 || '%' or l.telefone ilike '%' || $2 || '%' or l.email ilike '%' || $2 || '%')
             and (case when $3 = 'arquivadas' then l.chat_archived_at is not null and u.at <= l.chat_archived_at
                       else not (l.chat_archived_at is not null and u.at <= l.chat_archived_at) end)
             and ($3 in ('todas', 'arquivadas') or ($3 = 'aguardando' and u.de = 'lead') or ($3 = 'humano' and l.automation_paused)
               or ($3 = 'fluxo' and exists (select 1 from public.flow_executions e where e.lead_id = l.id and e.status in ('running','waiting'))))
           order by u.at desc limit 300`, [orgId, q, filtro]);
        const arquivadas = (await pool.query(`select count(*)::int as n from public.leads l where l.organization_id = $1 and l.chat_archived_at is not null`, [orgId])).rows[0].n;
        return { conversations: rows.map((r) => ({ ...r, janela_aberta: isWindowOpen(r.whatsapp_last_inbound_at, now()) })), arquivadas };
      }
      case 'messages': {
        const lead = await leadOf(orgId, body.lead_id);
        const { rows } = await pool.query(`
          select * from (
            select id::text, 'lead' as de, body, msg_type as tipo, received_at as at, media_url from public.whatsapp_inbound_messages where organization_id = $1 and lead_id = $2
            union all
            select id::text, source as de, body, msg_type as tipo, created_at as at, media_url from public.whatsapp_outbound_messages where organization_id = $1 and lead_id = $2
          ) m where m.at > coalesce($3::timestamptz, '-infinity'::timestamptz) order by at desc limit 400`, [orgId, lead.id, lead.chat_cleared_at]);
        const running = (await pool.query(`select e.id, e.status, e.current_ref, e.wait_kind, c.nome as campanha from public.flow_executions e join public.campaigns c on c.id = e.campaign_id
          where e.lead_id = $1 and e.organization_id = $2 and e.status in ('running','waiting')`, [lead.id, orgId])).rows;
        // WhatsApp por QR Code (sem API oficial): não há janela de 24 h
        const livre = whatsapp.freeTextAllowed ? await whatsapp.freeTextAllowed(orgId) : false;
        const extra = (await pool.query(`select l.valor_compra, l.link_recuperacao, l.created_at, l.utm,
            coalesce((select json_agg(json_build_object('id', t.id, 'nome', t.nome) order by t.nome) from public.lead_tags lt join public.tags t on t.id = lt.tag_id where lt.lead_id = l.id), '[]') as tags,
            coalesce((select json_agg(x order by x.em desc) from (select w.tipo_evento as tipo, w.produto, w.valor_produto as valor, w.created_at as em from public.webhook_events w where w.lead_id = l.id order by w.created_at desc limit 6) x), '[]') as eventos
          from public.leads l where l.id = $1`, [lead.id])).rows[0] || {};
        // só os links de arquivos enviados pela Kobly vão direto; os do WhatsApp abrem pela ação "media"
        const messages = rows.reverse().map((m) => ({ ...m, media_url: m.de === 'humano' || m.de === 'fluxo' || m.de === 'agente' ? m.media_url : null }));
        return { lead: { ...view(lead), ...extra, ...(livre ? { janela_aberta: true } : {}) }, messages, flows: running, livre };
      }
      case 'media': { // link para tocar/ver uma mídia da conversa
        const lead = await leadOf(orgId, body.lead_id);
        if (!UUID.test(String(body.id || ''))) throw new AuthError(422, 'validation_failed', 'Mensagem inválida.');
        const table = body.de === 'lead' ? 'whatsapp_inbound_messages' : 'whatsapp_outbound_messages';
        const m = (await pool.query(`select id, instance_id, wa_message_id, media_url, media_at from public.${table} where id = $1 and organization_id = $2 and lead_id = $3`, [body.id, orgId, lead.id])).rows[0];
        if (!m) throw new AuthError(404, 'not_found', 'Mensagem não encontrada.');
        if (m.media_url && (!m.media_at || now() - new Date(m.media_at) < MEDIA_TTL_MS)) return { url: m.media_url };
        if (!m.wa_message_id || !whatsapp.mediaLink) throw new AuthError(404, 'media_gone', 'Esta mídia não está disponível.');
        const r = await whatsapp.mediaLink(orgId, { instanceId: m.instance_id, messageId: m.wa_message_id });
        await pool.query(`update public.${table} set media_url = $2, media_at = now() where id = $1`, [m.id, r.url]);
        return { url: r.url, mimetype: r.mimetype };
      }
      case 'avatars': { // fotos do WhatsApp dos contatos da lista (busca as que faltam ou passaram de 24 h)
        const ids = (Array.isArray(body.lead_ids) ? body.lead_ids : []).filter((x) => UUID.test(String(x))).slice(0, 30);
        if (!ids.length || !whatsapp.avatarOf) return { avatars: {} };
        const rows = (await pool.query(`select id, telefone, avatar_url, avatar_at from public.leads where organization_id = $1 and id = any($2::uuid[])`, [orgId, ids])).rows;
        const out = {};
        for (const l of rows) {
          if (l.avatar_at && now() - new Date(l.avatar_at) < AVATAR_TTL_MS) { out[l.id] = l.avatar_url || ''; continue; }
          if (!l.telefone) continue;
          const url = await whatsapp.avatarOf(orgId, l.telefone).catch(() => null);
          if (url === null) continue; // WhatsApp fora do ar: tenta depois
          await pool.query(`update public.leads set avatar_url = nullif($2, ''), avatar_at = now() where id = $1`, [l.id, url]);
          out[l.id] = url;
        }
        return { avatars: out };
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
        const r = await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, wa_message_id, sent_by, channel, instance_id)
          values ($1,$2,$3,'humano',$4,$5,$6,$7,$8) returning id::text, 'humano' as de, body, msg_type as tipo, created_at as at, media_url`,
          [orgId, lead.id, out.to || lead.telefone, msg, out.id || null, (user && user.id) || null, out.channel === 'uazapi' ? 'uazapi' : 'oficial', out.instanceId || null]);
        if (lead.chat_archived_at) await pool.query(`update public.leads set chat_archived_at = null where id = $1`, [lead.id]);
        return { ok: true, message: r.rows[0] };
      }
      case 'send_media': { // imagem, vídeo, áudio ou arquivo (link público, ex.: o arquivo enviado na hora pelo chat)
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        if (lead.whatsapp_opt_out) throw new AuthError(409, 'opt_out', 'Este lead pediu para não receber WhatsApp.');
        if (!lead.telefone) throw new AuthError(422, 'bad_phone', 'Lead sem telefone.');
        const kind = kindOf(body.kind);
        const url = String(body.url || '').trim();
        if (!/^https?:\/\/\S+$/i.test(url)) throw new AuthError(422, 'validation_failed', 'Arquivo inválido.');
        const caption = typeof body.caption === 'string' && kind !== 'audio' ? body.caption.trim().slice(0, 1024) : '';
        const livre = whatsapp.freeTextAllowed ? await whatsapp.freeTextAllowed(orgId) : false;
        if (!livre && !isWindowOpen(lead.whatsapp_last_inbound_at, now())) throw new AuthError(409, 'window_closed', 'A janela de 24 h está fechada: o lead precisa mandar uma mensagem antes.');
        const out = await whatsapp.sendMediaTo(orgId, { to: lead.telefone, kind, url, caption: caption || undefined, filename: body.filename ? String(body.filename).slice(0, 120) : undefined });
        const label = { image: 'imagem', video: 'vídeo', audio: 'áudio', document: 'arquivo' }[kind];
        const r = await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, wa_message_id, sent_by, channel, msg_type, media_url, instance_id)
          values ($1,$2,$3,'humano',$4,$5,$6,$7,$8,$9,$10) returning id::text, 'humano' as de, body, msg_type as tipo, created_at as at, media_url`,
          [orgId, lead.id, out.to || lead.telefone, caption || (kind === 'document' ? String(body.filename || url.split('/').pop()) : `[${label}]`), out.id || null, (user && user.id) || null,
            out.channel === 'uazapi' ? 'uazapi' : 'oficial', kind, url, out.instanceId || null]);
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
      case 'notes': { // anotações internas do atendimento (o lead não vê)
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
        await pool.query(`update public.leads set chat_notes = nullif($2, '') where id = $1`, [lead.id, text]);
        return { ok: true };
      }
      case 'archive': { // tira da lista principal; volta sozinha quando o lead mandar mensagem nova
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        await pool.query(`update public.leads set chat_archived_at = case when $2 then now() else null end where id = $1`, [lead.id, body.archived !== false]);
        return { ok: true };
      }
      case 'clear': { // esvazia a conversa na Kobly (continua na lista quando chegar mensagem nova; nada é apagado no WhatsApp)
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        await pool.query(`update public.leads set chat_cleared_at = now() where id = $1`, [lead.id]);
        return { ok: true };
      }
      case 'call': { // ligação muda pelo WhatsApp por QR Code
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        if (!lead.telefone) throw new AuthError(422, 'bad_phone', 'Lead sem telefone.');
        if (!whatsapp.ringCall) throw new AuthError(409, 'not_connected', 'Ligação só funciona com o WhatsApp por QR Code conectado.');
        return whatsapp.ringCall(orgId, lead.telefone);
      }
      case 'flows': { // fluxos publicados para disparar à mão
        const { rows } = await pool.query(`select c.id, c.nome, c.status_campanha as status from public.campaigns c
          where c.organization_id = $1 and exists (select 1 from public.campaign_flows f join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where f.campaign_id = c.id)
          order by c.nome`, [orgId]);
        return { flows: rows };
      }
      case 'start_flow': { // dispara um fluxo para este lead agora
        canAct(ctx);
        const lead = await leadOf(orgId, body.lead_id);
        if (!UUID.test(String(body.campaign_id || ''))) throw new AuthError(422, 'validation_failed', 'Escolha o fluxo.');
        if (!flows) throw new AuthError(503, 'unavailable', 'Fluxos indisponíveis agora.');
        if (lead.automation_paused) await pool.query(`update public.leads set automation_paused = false where id = $1`, [lead.id]);
        const r = await flows.startForLead({ orgId, campaignId: body.campaign_id, leadId: lead.id, tipo: 'Disparo manual (chat)' });
        if (!r.started) throw new AuthError(409, 'not_started', `O fluxo não começou: ${r.reason}.`);
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
