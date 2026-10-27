// Pipeline (rota pipeline): leads em colunas pelo que aconteceu — Novo → Em contato (a Kobly mandou mensagem)
// → Respondeu → Cobrança (Pix/boleto gerado ou cobrança do fluxo) → Comprou; Perdido (pediu para sair,
// reembolso/chargeback ou arrastado). Arrastar o cartão guarda a etapa escolhida (leads.etapa_pipeline).
//   board | more | move
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

export function createPipeline({ pool }) {
  function base(orgId, f) {
    const where = ['l.organization_id = $1'], params = [orgId];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const days = Number(f.days);
    if ([7, 30, 90].includes(days)) where.push(`l.created_at >= now() - make_interval(days => ${p(days)})`);
    const q = typeof f.q === 'string' ? f.q.trim().slice(0, 80) : '';
    if (q) { const v = p(`%${q}%`); where.push(`(l.nome ilike ${v} or l.telefone ilike ${v} or l.email::text ilike ${v} or l.produto ilike ${v})`); }
    if (UUID.test(String(f.tag_id || ''))) where.push(`exists (select 1 from public.lead_tags lt where lt.lead_id = l.id and lt.tag_id = ${p(f.tag_id)})`);
    return { sql: `select l.*, ${STAGE_SQL} as etapa,
        greatest(l.updated_at, (select max(m.received_at) from public.whatsapp_inbound_messages m where m.lead_id = l.id), (select max(m.created_at) from public.whatsapp_outbound_messages m where m.lead_id = l.id)) as ultima_atividade,
        exists (select 1 from public.flow_executions e where e.lead_id = l.id and e.status in ('running','waiting')) as em_fluxo
      from public.leads l where ${where.join(' and ')}`, params };
  }
  const card = (r) => ({ id: r.id, nome: [r.nome, r.sobrenome].filter(Boolean).join(' ') || r.email || r.telefone || 'Lead', telefone: r.telefone, email: r.email,
    produto: r.produto, valor: r.valor_compra, etapa: r.etapa, manual: !!r.etapa_pipeline, ultima: r.ultima_atividade, em_fluxo: r.em_fluxo, humano: r.automation_paused, criado: r.created_at });

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
        if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode mover leads.');
        if (!UUID.test(String(body.lead_id || ''))) throw new AuthError(422, 'validation_failed', 'Lead inválido.');
        const stage = body.stage === null || body.stage === 'auto' ? null : body.stage;
        if (stage !== null && !STAGES.includes(stage)) throw new AuthError(422, 'validation_failed', 'Coluna inválida.');
        const r = await pool.query(`update public.leads set etapa_pipeline = $3 where id = $1 and organization_id = $2 returning id`, [body.lead_id, orgId, stage]);
        if (!r.rowCount) throw new AuthError(404, 'not_found', 'Lead não encontrado.');
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
