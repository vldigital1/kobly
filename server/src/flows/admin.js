// Rota POST /functions/v1/flow-graph: salvar/validar/versionar o grafo de uma campanha e ler métricas.
// Toda escrita passa por aqui (o cliente só lê as tabelas do motor), sempre conferindo a empresa.
import { AuthError } from '../auth.js';
import { validateGraph } from './graph.js';

const UUID = /^[0-9a-f-]{36}$/i;

export function createFlowAdmin({ pool }) {
  async function flowOf(orgId, campaignId) {
    if (!UUID.test(String(campaignId || ''))) throw new AuthError(422, 'validation_failed', 'Informe a campanha.');
    const { rows } = await pool.query(`select f.id as flow_id, c.id as campaign_id from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
      where c.id = $1 and c.organization_id = $2`, [campaignId, orgId]);
    if (rows[0]) return rows[0];
    const c = await pool.query(`select id from public.campaigns where id = $1 and organization_id = $2`, [campaignId, orgId]);
    if (!c.rows[0]) throw new AuthError(404, 'not_found', 'Campanha não encontrada.');
    const f = await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [campaignId, orgId]);
    return { flow_id: f.rows[0].id, campaign_id: campaignId };
  }
  const canEdit = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar fluxos.'); };

  // Avisos que dependem do banco: modelo/etiqueta de outra empresa ou inexistente.
  async function refWarnings(orgId, graph) {
    const warns = [];
    const tpls = new Set(), tags = new Set();
    for (const n of graph.nodes || []) {
      const d = n.data || {};
      if (n.type === 'send_template' && d.template_id) tpls.add(String(d.template_id));
      if (n.type === 'send_text' && d.fallback_template_id) tpls.add(String(d.fallback_template_id));
      if (n.type === 'tag') for (const t of [...(d.add || []), ...(d.remove || [])]) tags.add(String(t));
      if (n.type === 'condition') for (const r of d.rules || []) if (r.kind === 'tag' && r.tag_id) tags.add(String(r.tag_id));
    }
    if (tpls.size) {
      const { rows } = await pool.query(`select id::text, status from public.whatsapp_templates where organization_id = $1 and id::text = any($2::text[])`, [orgId, [...tpls]]);
      const found = new Map(rows.map((r) => [r.id, r.status]));
      for (const t of tpls) if (!found.has(t)) warns.push(`Modelo ${t} não existe nesta empresa.`); else if (found.get(t) !== 'APPROVED') warns.push(`Modelo ${t} ainda não está aprovado pela Meta (${found.get(t)}).`);
    }
    // conta do gateway, Pixel e canal de alerta precisam ser desta empresa
    const refs = [['payment', 'integration_id', 'payment_integrations', 'Conta de pagamento'], ['pixel', 'pixel_config_id', 'pixel_configs', 'Pixel'], ['notify', 'channel_id', 'notification_channels', 'Canal de alerta']];
    for (const [type, field, table, label] of refs) {
      const ids = [...new Set((graph.nodes || []).filter((n) => n.type === type && n.data && n.data[field]).map((n) => String(n.data[field])))];
      if (!ids.length) continue;
      const { rows } = await pool.query(`select id::text from public.${table} where organization_id = $1 and id::text = any($2::text[])`, [orgId, ids]);
      const found = new Set(rows.map((r) => r.id));
      for (const id of ids) if (!found.has(id)) warns.push(`${label} ${id} não existe nesta empresa.`);
    }
    if (tags.size) {
      const valid = [...tags].filter((t) => UUID.test(t));
      const { rows } = valid.length ? await pool.query(`select id::text from public.tags where organization_id = $1 and id = any($2::uuid[])`, [orgId, valid]) : { rows: [] };
      const found = new Set(rows.map((r) => r.id));
      for (const t of tags) if (!found.has(t)) warns.push(`Etiqueta ${t} não existe nesta empresa.`);
    }
    return warns;
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'validate': {
        const v = validateGraph(body.graph);
        return { ...v, warnings: [...v.warnings, ...(v.ok ? await refWarnings(orgId, body.graph) : [])] };
      }
      case 'get': {
        const f = await flowOf(orgId, body.campaign_id);
        const { rows } = await pool.query(`select version, is_active, created_at, case when is_active then graph end as graph from public.flow_graph_versions where flow_id = $1 order by version desc limit 50`, [f.flow_id]);
        const active = rows.find((r) => r.is_active) || null;
        return { flow_id: f.flow_id, active: active ? { version: active.version, graph: active.graph } : null, versions: rows.map(({ graph, ...r }) => r) };
      }
      case 'save': {
        canEdit(ctx);
        const v = validateGraph(body.graph);
        if (!v.ok) throw Object.assign(new AuthError(422, 'invalid_graph', v.errors[0]), { details: v });
        const f = await flowOf(orgId, body.campaign_id);
        const warnings = [...v.warnings, ...(await refWarnings(orgId, body.graph))];
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [f.flow_id]); // duas abas salvando ao mesmo tempo
          const n = (await client.query(`select coalesce(max(version), 0) + 1 as v from public.flow_graph_versions where flow_id = $1`, [f.flow_id])).rows[0].v;
          await client.query(`update public.flow_graph_versions set is_active = false where flow_id = $1 and is_active`, [f.flow_id]);
          await client.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active, created_by) values ($1,$2,$3,$4::jsonb,true,$5)`,
            [orgId, f.flow_id, n, JSON.stringify(body.graph), user.id || null]);
          await client.query('commit');
          return { ok: true, version: n, warnings };
        } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
      }
      case 'activate': { // desfazer: volta para uma versão anterior
        canEdit(ctx);
        const f = await flowOf(orgId, body.campaign_id);
        const ver = Number(body.version);
        const ok = await pool.query(`select 1 from public.flow_graph_versions where flow_id = $1 and version = $2`, [f.flow_id, ver]);
        if (!ok.rows[0]) throw new AuthError(404, 'not_found', 'Versão não encontrada.');
        await pool.query(`update public.flow_graph_versions set is_active = (version = $2) where flow_id = $1`, [f.flow_id, ver]);
        return { ok: true, version: ver };
      }
      case 'deactivate': { // volta a campanha para o motor antigo (lista de etapas)
        canEdit(ctx);
        const f = await flowOf(orgId, body.campaign_id);
        await pool.query(`update public.flow_graph_versions set is_active = false where flow_id = $1 and is_active`, [f.flow_id]);
        return { ok: true };
      }
      case 'stats': { // execuções por situação + leads que passaram por cada bloco (onde o funil vaza)
        const f = await flowOf(orgId, body.campaign_id);
        const byStatus = (await pool.query(`select status, count(*)::int as n from public.flow_executions where flow_id = $1 group by status`, [f.flow_id])).rows;
        const byNode = (await pool.query(`select ref, node_type, outcome, count(distinct execution_id)::int as leads from public.flow_execution_events where flow_id = $1 group by ref, node_type, outcome order by ref`, [f.flow_id])).rows;
        // leads distintos que chegaram a cada bloco (o contador mostrado no editor) e quantos estão parados nele agora
        const byRef = (await pool.query(`select ref, count(distinct execution_id)::int as leads from public.flow_execution_events where flow_id = $1 group by ref`, [f.flow_id])).rows;
        const waitingAt = (await pool.query(`select current_ref as ref, count(*)::int as leads from public.flow_executions where flow_id = $1 and status in ('running','waiting') group by current_ref`, [f.flow_id])).rows;
        const recent = (await pool.query(`select e.id, e.status, e.current_ref, e.last_error, e.started_at, e.finished_at, l.nome, l.email from public.flow_executions e join public.leads l on l.id = e.lead_id
          where e.flow_id = $1 order by e.created_at desc limit 50`, [f.flow_id])).rows;
        return { by_status: byStatus, by_node: byNode, by_ref: byRef, waiting_at: waitingAt, recent };
      }
      case 'cancel_execution': {
        canEdit(ctx);
        if (!UUID.test(String(body.execution_id || ''))) throw new AuthError(422, 'validation_failed', 'Informe a execução.');
        const r = await pool.query(`update public.flow_executions set status = 'cancelled', finished_at = now(), lease_until = null, last_error = 'cancelado manualmente'
          where id = $1 and organization_id = $2 and status in ('running','waiting') returning id`, [body.execution_id, orgId]);
        return { ok: r.rowCount === 1 };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
