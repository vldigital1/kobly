// Rota POST /functions/v1/flow-graph: salvar/validar/versionar o grafo de uma campanha e ler métricas.
// Toda escrita passa por aqui (o cliente só lê as tabelas do motor), sempre conferindo a empresa.
import { AuthError } from '../auth.js';
import { validateGraph } from './graph.js';

const UUID = /^[0-9a-f-]{36}$/i;

export function createFlowAdmin({ pool, copilot = null }) {
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
    const refs = [['payment', 'integration_id', 'payment_integrations', 'Conta de pagamento'], ['pixel', 'pixel_config_id', 'pixel_configs', 'Pixel'], ['notify', 'channel_id', 'notification_channels', 'Canal de alerta'], ['ai_agent', 'agent_id', 'ai_agents', 'Agente de IA']];
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
      case 'list': { // tela Fluxos: campanhas com fluxo em grafo (publicado ou só rascunho) e quantos leads estão nele
        const { rows } = await pool.query(`
          select c.id as campaign_id, c.nome, c.status_campanha as status, c.updated_at,
                 max(v.version) filter (where v.is_active) as active_version,
                 count(v.id) filter (where v.is_draft)::int as drafts,
                 max(v.created_at) as last_saved_at,
                 (select count(*)::int from public.flow_executions e where e.flow_id = f.id and e.status in ('running','waiting')) as leads_ativos,
                 (select count(*)::int from public.flow_executions e where e.flow_id = f.id) as leads_total,
                 (select n->'data'->'events' from public.flow_graph_versions v2, jsonb_array_elements(v2.graph->'nodes') n
                   where v2.flow_id = f.id and n->>'ref' = v2.graph->>'start' order by v2.is_active desc, v2.version desc limit 1) as eventos
            from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
            join public.flow_graph_versions v on v.flow_id = f.id
           where c.organization_id = $1
           group by c.id, f.id order by max(v.created_at) desc`, [orgId]);
        return { flows: rows };
      }
      case 'validate': {
        const v = validateGraph(body.graph);
        return { ...v, warnings: [...v.warnings, ...(v.ok ? await refWarnings(orgId, body.graph) : [])] };
      }
      case 'get': {
        const f = await flowOf(orgId, body.campaign_id);
        const { rows } = await pool.query(`select version, is_active, is_draft, source, note, created_at, case when is_active then graph end as graph from public.flow_graph_versions where flow_id = $1 order by version desc limit 50`, [f.flow_id]);
        const active = rows.find((r) => r.is_active) || null;
        return { flow_id: f.flow_id, active: active ? { version: active.version, graph: active.graph } : null, versions: rows.map(({ graph, ...r }) => r) };
      }
      case 'get_version': { // abre um rascunho ou versão antiga no editor (sem ativar)
        const f = await flowOf(orgId, body.campaign_id);
        const r = (await pool.query(`select version, is_active, is_draft, source, note, graph from public.flow_graph_versions where flow_id = $1 and version = $2`, [f.flow_id, Number(body.version)])).rows[0];
        if (!r) throw new AuthError(404, 'not_found', 'Versão não encontrada.');
        return r;
      }
      case 'save':        // editor: nova versão já publicada (ativa)
      case 'save_draft': { // editor ou assistente de IA (MCP): só rascunho; publicar é sempre um clique de uma pessoa
        canEdit(ctx);
        const draft = body.action === 'save_draft';
        const v = validateGraph(body.graph);
        if (!v.ok) throw Object.assign(new AuthError(422, 'invalid_graph', v.errors[0]), { details: v });
        const f = await flowOf(orgId, body.campaign_id);
        const warnings = [...v.warnings, ...(await refWarnings(orgId, body.graph))];
        const source = ['editor', 'mcp', 'copilot'].includes(body.source) ? body.source : 'editor';
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [f.flow_id]); // duas abas salvando ao mesmo tempo
          const n = (await client.query(`select coalesce(max(version), 0) + 1 as v from public.flow_graph_versions where flow_id = $1`, [f.flow_id])).rows[0].v;
          if (!draft) await client.query(`update public.flow_graph_versions set is_active = false where flow_id = $1 and is_active`, [f.flow_id]);
          await client.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active, is_draft, source, note, created_by) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
            [orgId, f.flow_id, n, JSON.stringify(body.graph), !draft, draft, source, body.note ? String(body.note).slice(0, 500) : null, (user && user.id) || null]);
          await client.query('commit');
          return { ok: true, version: n, draft, warnings };
        } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
      }
      case 'activate': { // publicar um rascunho ou desfazer para uma versão anterior — sempre revalida antes
        canEdit(ctx);
        const f = await flowOf(orgId, body.campaign_id);
        const ver = Number(body.version);
        const row = (await pool.query(`select graph from public.flow_graph_versions where flow_id = $1 and version = $2`, [f.flow_id, ver])).rows[0];
        if (!row) throw new AuthError(404, 'not_found', 'Versão não encontrada.');
        const v = validateGraph(row.graph);
        if (!v.ok) throw Object.assign(new AuthError(422, 'invalid_graph', `A versão ${ver} tem erros: ${v.errors[0]}`), { details: v });
        await pool.query(`update public.flow_graph_versions set is_active = (version = $2), is_draft = case when version = $2 then false else is_draft end where flow_id = $1`, [f.flow_id, ver]);
        return { ok: true, version: ver };
      }
      case 'copilot': { // lê as métricas por bloco da versão ativa e sugere melhorias
        if (!copilot) throw new AuthError(503, 'copilot_unavailable', 'Copiloto indisponível neste ambiente.');
        const f = await flowOf(orgId, body.campaign_id);
        const act = (await pool.query(`select graph from public.flow_graph_versions where flow_id = $1 and is_active`, [f.flow_id])).rows[0];
        if (!act) throw new AuthError(400, 'not_published', 'Publique o fluxo antes de pedir sugestões ao copiloto.');
        return copilot.run(f.flow_id, act.graph);
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
