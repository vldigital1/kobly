// Pipeline e Leads (rota pipeline): leads em colunas pelo que aconteceu — Novo → Em contato (a Kobly mandou mensagem)
// → Respondeu → Cobrança (Pix/boleto gerado ou cobrança do fluxo) → Comprou; Perdido (pediu para sair,
// reembolso/chargeback ou arrastado). Arrastar o cartão guarda a etapa escolhida (leads.etapa_pipeline).
// Cada lead vem com a foto do WhatsApp, as etiquetas e a última mensagem da conversa.
//   board | more | move | leads | stats | detail | export | tag_bulk
import { AuthError } from '../auth.js';

export const STAGES = ['novo', 'contato', 'respondeu', 'cobranca', 'comprou', 'perdido'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// etapa calculada (a manual tem prioridade)
const STAGE_SQL = `coalesce(l.etapa_pipeline, case
  when l.whatsapp_opt_out or exists (select 1 from public.webhook_events w where w.lead_id = l.id and w.tipo_evento in ('Compra Reembolsada','Chargeback','Compra cancelada')) then 'perdido'
  when exists (select 1 from public.webhook_events w where w.lead_id = l.id and w.tipo_evento = 'Compra Aprovada')
    or exists (select 1 from public.payment_charges p where p.lead_id = l.id and p.status = 'confirmed') then 'comprou'
  when exists (select 1 from public.webhook_events w where w.lead_id = l.id and w.tipo_evento in ('Pix Gerado','Boleto Gerado'))
    or exists (select 1 from public.payment_charges p where p.lead_id = l.id and p.status = 'pending') then 'cobranca'
  when exists (select 1 from public.whatsapp_inbound_messages m where m.lead_id = l.id) then 'respondeu'
  when exists (select 1 from public.whatsapp_outbound_messages m where m.lead_id = l.id) or exists (select 1 from public.flow_executions e where e.lead_id = l.id) then 'contato'
  else 'novo' end)`;
const TAGS_SQL = `coalesce((select json_agg(json_build_object('id', t.id, 'nome', t.nome) order by t.nome) from public.lead_tags lt join public.tags t on t.id = lt.tag_id where lt.lead_id = l.id), '[]')`;
const LAST_SQL = `(select json_build_object('body', x.body, 'tipo', x.tipo, 'de', x.de) from (
    select body, msg_type as tipo, received_at as at, 'lead' as de from public.whatsapp_inbound_messages where lead_id = l.id
    union all select body, msg_type, created_at, source from public.whatsapp_outbound_messages where lead_id = l.id
    order by 3 desc limit 1) x)`;
const ORDERS = { recente: 'ultima_atividade desc nulls last', novos: 'created_at desc', valor: 'valor_compra desc nulls last', nome: 'nome asc nulls last' };
const csv = (v) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function createPipeline({ pool }) {
  function base(orgId, f) {
    const where = ['l.organization_id = $1'], params = [orgId];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const days = Number(f.days);
    if ([7, 30, 90].includes(days)) where.push(`l.created_at >= now() - make_interval(days => ${p(days)})`);
    const q = typeof f.q === 'string' ? f.q.trim().slice(0, 80) : '';
    if (q) { const v = p(`%${q}%`); where.push(`(l.nome ilike ${v} or l.sobrenome ilike ${v} or l.telefone ilike ${v} or l.email::text ilike ${v} or l.produto ilike ${v})`); }
    if (UUID.test(String(f.tag_id || ''))) where.push(`exists (select 1 from public.lead_tags lt where lt.lead_id = l.id and lt.tag_id = ${p(f.tag_id)})`);
    if (typeof f.origem === 'string' && f.origem) where.push(f.origem === '_sem' ? `coalesce(l.utm->>'utm_source', '') = ''` : `l.utm->>'utm_source' = ${p(f.origem.slice(0, 80))}`);
    if (Array.isArray(f.lead_ids) && f.lead_ids.length) where.push(`l.id = any(${p(f.lead_ids.filter((x) => UUID.test(String(x))).slice(0, 1000))}::uuid[])`);
    if (UUID.test(String(f.instance_id || ''))) { const v = p(f.instance_id); where.push(`(exists (select 1 from public.whatsapp_inbound_messages m where m.lead_id = l.id and m.instance_id = ${v}) or exists (select 1 from public.whatsapp_outbound_messages m where m.lead_id = l.id and m.instance_id = ${v}))`); }
    return { sql: `select l.*, ${STAGE_SQL} as etapa, ${TAGS_SQL} as tags_json, ${LAST_SQL} as ultima_msg,
        greatest(l.updated_at, (select max(m.received_at) from public.whatsapp_inbound_messages m where m.lead_id = l.id), (select max(m.created_at) from public.whatsapp_outbound_messages m where m.lead_id = l.id)) as ultima_atividade,
        exists (select 1 from public.flow_executions e where e.lead_id = l.id and e.status in ('running','waiting')) as em_fluxo
      from public.leads l where ${where.join(' and ')}`, params, p };
  }
  const card = (r) => ({ id: r.id, nome: [r.nome, r.sobrenome].filter(Boolean).join(' ') || r.email || (r.telefone ? `+${r.telefone}` : 'Lead'), telefone: r.telefone, email: r.email,
    produto: r.produto, valor: r.valor_compra, etapa: r.etapa, manual: !!r.etapa_pipeline, ultima: r.ultima_atividade, em_fluxo: r.em_fluxo, humano: r.automation_paused, criado: r.created_at,
    avatar_url: r.avatar_url || null, tags: r.tags_json || [], ultima_msg: r.ultima_msg || null, origem: (r.utm && r.utm.utm_source) || null, ultimo_evento: r.ultimo_evento || null,
    opt_out: !!r.whatsapp_opt_out });
  const canAct = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar leads.'); };
  const stageFilter = (b, f) => (STAGES.includes(f.stage) ? ` and etapa = ${b.p(f.stage)}` : '');

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'board': {
        const per = Math.min(60, Math.max(5, Number(body.limit) || 25));
        const b = base(orgId, body);
        const { rows } = await pool.query(`with x as (${b.sql}), r as (select x.*, row_number() over (partition by etapa order by ultima_atividade desc nulls last) as n,
            count(*) over (partition by etapa) as total, coalesce(sum(valor_compra) over (partition by etapa), 0) as soma from x)
          select * from r where n <= ${per}`, b.params);
        const cols = Object.fromEntries(STAGES.map((s) => [s, { total: 0, valor: 0, leads: [] }]));
        for (const r of rows) { const c = cols[r.etapa]; if (!c) continue; c.total = Number(r.total); c.valor = Number(r.soma); c.leads.push(card(r)); }
        return { columns: cols };
      }
      case 'more': {
        if (!STAGES.includes(body.stage)) throw new AuthError(422, 'validation_failed', 'Coluna inválida.');
        const b = base(orgId, body);
        const off = Math.max(0, Number(body.offset) || 0);
        const { rows } = await pool.query(`select * from (${b.sql}) x where etapa = $${b.params.length + 1} order by ultima_atividade desc nulls last limit 25 offset ${off}`, [...b.params, body.stage]);
        return { leads: rows.map(card) };
      }
      case 'move': {
        canAct(ctx);
        if (!UUID.test(String(body.lead_id || ''))) throw new AuthError(422, 'validation_failed', 'Lead inválido.');
        const stage = body.stage === null || body.stage === 'auto' ? null : body.stage;
        if (stage !== null && !STAGES.includes(stage)) throw new AuthError(422, 'validation_failed', 'Coluna inválida.');
        const r = await pool.query(`update public.leads set etapa_pipeline = $3 where id = $1 and organization_id = $2 returning id`, [body.lead_id, orgId, stage]);
        if (!r.rowCount) throw new AuthError(404, 'not_found', 'Lead não encontrado.');
        return { ok: true };
      }
      case 'leads': { // tabela de Leads: filtros, ordem e páginas
        const b = base(orgId, body);
        const size = Math.min(100, Math.max(10, Number(body.limit) || 25));
        const off = Math.max(0, Number(body.offset) || 0);
        const order = ORDERS[body.order] || ORDERS.recente;
        const { rows } = await pool.query(`select *, count(*) over () as total_rows from (${b.sql}) x where true${stageFilter(b, body)} order by ${order} limit ${size} offset ${off}`, b.params);
        return { leads: rows.map(card), total: rows[0] ? Number(rows[0].total_rows) : 0 };
      }
      case 'stats': { // números do topo e as origens para o filtro
        const b = base(orgId, { days: body.days });
        const s = (await pool.query(`select count(*)::int as total, count(*) filter (where created_at >= now() - interval '7 days')::int as novos7,
            count(*) filter (where etapa in ('respondeu','cobranca','comprou'))::int as responderam, count(*) filter (where etapa = 'comprou')::int as compraram,
            coalesce(sum(valor_compra) filter (where etapa = 'comprou'), 0)::float as vendido, count(*) filter (where em_fluxo)::int as em_fluxo
          from (${b.sql}) x`, b.params)).rows[0];
        const origens = (await pool.query(`select coalesce(nullif(utm->>'utm_source', ''), '_sem') as origem, count(*)::int as n from public.leads where organization_id = $1 group by 1 order by 2 desc limit 30`, [orgId])).rows;
        return { ...s, origens };
      }
      case 'detail': { // ficha do lead: dados, etiquetas e a linha do tempo
        if (!UUID.test(String(body.lead_id || ''))) throw new AuthError(422, 'validation_failed', 'Lead inválido.');
        const b = base(orgId, {});
        const r = (await pool.query(`select * from (${b.sql}) x where id = $${b.params.length + 1}`, [...b.params, body.lead_id])).rows[0];
        if (!r) throw new AuthError(404, 'not_found', 'Lead não encontrado.');
        const tl = (await pool.query(`select * from (
            select 'evento' as kind, w.tipo_evento::text as titulo, concat_ws(' · ', w.produto, case when w.valor_produto is not null then 'R$ ' || to_char(w.valor_produto, 'FM999G999G990D00') end) as sub, w.created_at as at from public.webhook_events w where w.lead_id = $1
            union all
            select 'fluxo', 'Fluxo ' || c.nome, case e.status when 'completed' then 'terminou' when 'cancelled' then 'parado' when 'failed' then 'deu erro' when 'waiting' then 'esperando' else 'rodando' end, e.started_at
              from public.flow_executions e join public.campaigns c on c.id = e.campaign_id where e.lead_id = $1
            union all
            select 'recebida', 'Mandou mensagem', left(coalesce(m.body, ''), 120), m.received_at from (select * from public.whatsapp_inbound_messages where lead_id = $1 order by received_at desc limit 5) m
            union all
            select 'enviada', case m.source when 'fluxo' then 'Fluxo enviou' when 'agente' then 'IA respondeu' when 'celular' then 'Você respondeu pelo celular' else 'Equipe respondeu' end, left(coalesce(m.body, ''), 120), m.created_at
              from (select * from public.whatsapp_outbound_messages where lead_id = $1 order by created_at desc limit 5) m
            union all
            select 'criado', 'Lead criado', coalesce(nullif($2, ''), 'cadastro'), $3::timestamptz
          ) t order by at desc limit 40`, [r.id, (r.utm && r.utm.utm_source) || '', r.created_at])).rows;
        const counts = (await pool.query(`select (select count(*) from public.whatsapp_inbound_messages where lead_id = $1)::int as recebidas,
            (select count(*) from public.whatsapp_outbound_messages where lead_id = $1)::int as enviadas,
            (select count(*) from public.flow_executions where lead_id = $1)::int as fluxos`, [r.id])).rows[0];
        return { lead: { ...card(r), sobrenome: r.sobrenome, metodo: r.metodo_pagamento, link: r.link_recuperacao, utm: r.utm || {}, notas: r.chat_notes || '' }, timeline: tl, counts };
      }
      case 'export': { // planilha (CSV) com os filtros da tela, até 10 mil leads
        const b = base(orgId, body);
        const { rows } = await pool.query(`select * from (${b.sql}) x where true${stageFilter(b, body)} order by created_at desc limit 10000`, b.params);
        const head = ['Nome', 'Telefone', 'E-mail', 'Etapa', 'Origem', 'Produto', 'Valor', 'Etiquetas', 'Último evento', 'Criado em'];
        const lines = rows.map((r) => { const c = card(r); return [c.nome, c.telefone, c.email, c.etapa, c.origem, c.produto, c.valor, (c.tags || []).map((t) => t.nome).join(', '), c.ultimo_evento, new Date(r.created_at).toISOString().slice(0, 10)].map(csv).join(';'); });
        return { csv: [head.join(';'), ...lines].join('\n'), count: rows.length };
      }
      case 'tag_bulk': { // etiqueta em vários leads de uma vez
        canAct(ctx);
        const ids = (Array.isArray(body.lead_ids) ? body.lead_ids : []).filter((x) => UUID.test(String(x))).slice(0, 500);
        if (!ids.length || !UUID.test(String(body.tag_id || ''))) throw new AuthError(422, 'validation_failed', 'Escolha os leads e a etiqueta.');
        const r = body.remove === true
          ? await pool.query(`delete from public.lead_tags lt using public.leads l where lt.lead_id = l.id and l.organization_id = $1 and l.id = any($2::uuid[]) and lt.tag_id = $3`, [orgId, ids, body.tag_id])
          : await pool.query(`insert into public.lead_tags (lead_id, tag_id) select l.id, t.id from public.leads l, public.tags t
              where l.organization_id = $1 and l.id = any($2::uuid[]) and t.id = $3 and t.organization_id = $1 on conflict do nothing`, [orgId, ids, body.tag_id]);
        return { ok: true, changed: r.rowCount };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
