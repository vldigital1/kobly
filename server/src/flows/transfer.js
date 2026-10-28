// Compartilhar fluxo entre contas da Kobly por CÓDIGO (como no ZapData e na Leona): share gera o código do fluxo,
// a prévia pública mostra o desenho e importar pelo código copia a versão mais nova para a outra conta.
// Por baixo, o pacote é montado na hora (exportFlow) e aplicado na conta de destino (importFlow).
// Exportar: o grafo da versão publicada (ou do rascunho mais novo) + o que ele usa e que outra conta não tem:
// etiquetas (pelo nome), e-mails (assunto e corpo), agentes de IA (objetivo, conhecimento, tom) e os modelos do
// WhatsApp (nome, idioma e texto — a outra conta precisa ter o modelo aprovado com o mesmo nome).
// Importar: cria uma campanha nova com o fluxo como RASCUNHO e troca os ids: etiquetas pelo nome (cria as que
// faltam), e-mails e agentes copiados, modelos achados pelo nome; contas de pagamento, Pixel, canal de alerta e
// chaves de IA ficam em branco (são da outra conta) e voltam na lista "falta configurar".
import { AuthError } from '../auth.js';

export const FORMAT = 'kobly-flow';
const UUID = /^[0-9a-f-]{36}$/i;
const OWN_FIELDS = { integration_id: 'Conta de pagamento', pixel_config_id: 'Pixel', channel_id: 'Canal de alerta', integrationKeyId: 'Chave de IA', credential_id: 'Chave de IA', ai_credential_id: 'Chave de IA', instance_id: 'Número de WhatsApp' };

// percorre o grafo inteiro (blocos, regras de condição etc.) e chama fn(chave, valor, objeto)
function walk(v, fn) {
  if (Array.isArray(v)) { v.forEach((x) => walk(x, fn)); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { fn(k, v[k], v); walk(v[k], fn); }
}
// ids de etiqueta: bloco "tag" (add/remove), regras de condição (tag_id) e "apagar ao etiquetar" (delete_on_tag)
function tagIds(graph) {
  const ids = new Set();
  for (const n of graph.nodes || []) {
    const d = n.data || {};
    if (n.type === 'tag') for (const t of [...(d.add || []), ...(d.remove || [])]) ids.add(String(t));
  }
  walk(graph, (k, v) => { if ((k === 'tag_id' || k === 'delete_on_tag') && v) ids.add(String(v)); });
  return [...ids].filter((x) => UUID.test(x));
}

export function createFlowTransfer({ pool, siteUrl = '' }) {
  const linkOf = (code) => `${String(siteUrl || 'https://app.koblay.io').replace(/\/$/, '')}/?fluxo=${code}`;
  async function shareOf(code) {
    if (!UUID.test(String(code || '').trim())) throw new AuthError(422, 'bad_code', 'Código inválido. Confira se copiou o código inteiro.');
    const s = (await pool.query(`select s.code, s.organization_id, s.campaign_id, o.nome as conta from public.flow_shares s join public.organizations o on o.id = s.organization_id where s.code = $1 and s.active`, [String(code).trim()])).rows[0];
    if (!s) throw new AuthError(404, 'code_not_found', 'Esse código não existe ou foi desativado por quem compartilhou.');
    return s;
  }
  // código do fluxo (o mesmo enquanto não pedir um novo)
  async function share(orgId, userId, campaignId, renew = false) {
    if (!UUID.test(String(campaignId || ''))) throw new AuthError(422, 'validation_failed', 'Informe o fluxo.');
    const ok = (await pool.query(`select 1 from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id join public.flow_graph_versions v on v.flow_id = f.id where c.id = $1 and c.organization_id = $2 limit 1`, [campaignId, orgId])).rowCount;
    if (!ok) throw new AuthError(404, 'not_found', 'Salve o fluxo no editor antes de compartilhar.');
    if (renew) await pool.query(`update public.flow_shares set active = false where campaign_id = $1 and organization_id = $2 and active`, [campaignId, orgId]);
    let s = (await pool.query(`select code from public.flow_shares where campaign_id = $1 and organization_id = $2 and active`, [campaignId, orgId])).rows[0];
    if (!s) s = (await pool.query(`insert into public.flow_shares (organization_id, campaign_id, created_by) values ($1,$2,$3) returning code`, [orgId, campaignId, userId || null])).rows[0];
    return { code: s.code, link: linkOf(s.code) };
  }
  // prévia (pública): desenho do fluxo e os nomes do que ele usa — sem e-mails inteiros, chaves ou contas
  async function preview(code) {
    const s = await shareOf(code);
    const pkg = await exportFlow(s.organization_id, s.campaign_id);
    const graph = JSON.parse(JSON.stringify(pkg.graph));
    walk(graph, (k, v, obj) => { if (OWN_FIELDS[k] && v) obj[k] = null; });
    const r = pkg.resources;
    return { code: s.code, link: linkOf(s.code), nome: pkg.name, conta: s.conta, blocos: (graph.nodes || []).length, graph,
      lookups: { tags: Object.entries(r.tags).map(([id, t]) => ({ id, nome: t.nome })), templates: Object.entries(r.templates).map(([id, t]) => ({ id, name: t.name })),
        emails: Object.entries(r.emails).map(([id, e]) => ({ id, assunto: e.assunto, titulo: e.titulo })), agents: Object.entries(r.agents).map(([id, a]) => ({ id, name: a.name })) },
      inclui: { etiquetas: Object.keys(r.tags).length, emails: Object.keys(r.emails).length, agentes: Object.keys(r.agents).length, modelos: Object.keys(r.templates).length } };
  }
  // importar pelo código: monta o pacote da versão mais nova e aplica nesta conta
  async function importByCode(orgId, userId, code, nome) {
    const s = await shareOf(code);
    const pkg = await exportFlow(s.organization_id, s.campaign_id);
    const r = await importFlow(orgId, userId, pkg, nome);
    await pool.query(`update public.flow_shares set imports = imports + 1 where code = $1`, [s.code]);
    return r;
  }
  async function exportFlow(orgId, campaignId, version = null) {
    if (!UUID.test(String(campaignId || ''))) throw new AuthError(422, 'validation_failed', 'Informe o fluxo.');
    const c = (await pool.query(`select c.id, c.nome from public.campaigns c where c.id = $1 and c.organization_id = $2`, [campaignId, orgId])).rows[0];
    if (!c) throw new AuthError(404, 'not_found', 'Fluxo não encontrado.');
    const v = (await pool.query(`select v.version, v.graph from public.flow_graph_versions v join public.campaign_flows f on f.id = v.flow_id
      where f.campaign_id = $1 and v.organization_id = $2 ${version ? 'and v.version = $3' : ''} order by ${version ? 'v.version' : 'v.is_active desc, v.version desc'} limit 1`,
      version ? [campaignId, orgId, Number(version)] : [campaignId, orgId])).rows[0];
    if (!v) throw new AuthError(404, 'not_found', 'Esse fluxo ainda não tem nada salvo.');
    const graph = v.graph;
    const res = { tags: {}, emails: {}, agents: {}, templates: {} };
    const tids = tagIds(graph);
    if (tids.length) for (const t of (await pool.query(`select id::text, nome from public.tags where organization_id = $1 and id = any($2::uuid[])`, [orgId, tids])).rows) res.tags[t.id] = { nome: t.nome };
    const ids = { email_id: new Set(), agent_id: new Set(), template_id: new Set() };
    walk(graph, (k, val) => {
      if (!val) return;
      if (k === 'email_id') ids.email_id.add(String(val));
      if (k === 'agent_id') ids.agent_id.add(String(val));
      if (k === 'template_id' || k === 'fallback_template_id') ids.template_id.add(String(val));
    });
    const list = (s) => [...s].filter((x) => UUID.test(x));
    if (ids.email_id.size) for (const e of (await pool.query(`select id::text, titulo, assunto, corpo_html from public.emails where organization_id = $1 and id = any($2::uuid[])`, [orgId, list(ids.email_id)])).rows) res.emails[e.id] = { titulo: e.titulo, assunto: e.assunto, corpo_html: e.corpo_html };
    if (ids.agent_id.size) for (const a of (await pool.query(`select id::text, name, objective, knowledge, tone, opening, max_turns, timeout_minutes from public.ai_agents where organization_id = $1 and id = any($2::uuid[])`, [orgId, list(ids.agent_id)])).rows) { const { id, ...x } = a; res.agents[id] = x; }
    if (ids.template_id.size) for (const t of (await pool.query(`select id::text, name, language, category, body_text from public.whatsapp_templates where organization_id = $1 and id = any($2::uuid[])`, [orgId, list(ids.template_id)])).rows) { const { id, ...x } = t; res.templates[id] = x; }
    return { format: FORMAT, version: 1, exported_at: new Date().toISOString(), name: c.nome, graph, resources: res };
  }

  async function importFlow(orgId, userId, pkg, nome) {
    if (!pkg || pkg.format !== FORMAT || !pkg.graph || !Array.isArray(pkg.graph.nodes)) throw new AuthError(422, 'bad_file', 'Esse arquivo não é um fluxo da Kobly (.kobly.json).');
    if (JSON.stringify(pkg).length > 3_000_000) throw new AuthError(422, 'too_big', 'Arquivo grande demais.');
    const r = pkg.resources || {};
    const graph = JSON.parse(JSON.stringify(pkg.graph));
    const pendencias = [];
    const client = await pool.connect();
    try {
      await client.query('begin');
      // etiquetas pelo nome (cria as que faltam)
      const tagMap = new Map();
      for (const [oldId, t] of Object.entries(r.tags || {})) {
        const name = String((t && t.nome) || '').trim().slice(0, 80);
        if (!name) continue;
        let row = (await client.query(`select id from public.tags where organization_id = $1 and lower(nome) = lower($2) limit 1`, [orgId, name])).rows[0];
        if (!row) row = (await client.query(`insert into public.tags (organization_id, nome) values ($1,$2) returning id`, [orgId, name])).rows[0];
        tagMap.set(oldId, row.id);
      }
      const emailMap = new Map(), agentMap = new Map(), tplMap = new Map();
      for (const [oldId, e] of Object.entries(r.emails || {})) {
        const row = (await client.query(`insert into public.emails (organization_id, titulo, assunto, corpo_html) values ($1,$2,$3,$4) returning id`,
          [orgId, String(e.titulo || e.assunto || 'E-mail importado').slice(0, 200), String(e.assunto || '').slice(0, 300), String(e.corpo_html || '').slice(0, 500000)])).rows[0];
        emailMap.set(oldId, row.id);
      }
      for (const [oldId, a] of Object.entries(r.agents || {})) {
        const row = (await client.query(`insert into public.ai_agents (organization_id, name, objective, knowledge, tone, opening, max_turns, timeout_minutes) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [orgId, String(a.name || 'Agente importado').slice(0, 120), String(a.objective || '').slice(0, 4000) || 'Atender o lead', String(a.knowledge || '').slice(0, 50000), a.tone || null, a.opening || null,
            Math.min(30, Math.max(1, Number(a.max_turns) || 10)), Math.min(43200, Math.max(1, Number(a.timeout_minutes) || 60))])).rows[0];
        agentMap.set(oldId, row.id);
      }
      for (const [oldId, t] of Object.entries(r.templates || {})) {
        const row = (await client.query(`select id from public.whatsapp_templates where organization_id = $1 and name = $2 order by (language = $3) desc, (status = 'APPROVED') desc limit 1`, [orgId, String(t.name || ''), String(t.language || '')])).rows[0];
        if (row) tplMap.set(oldId, row.id);
        else pendencias.push(`Modelo do WhatsApp "${t.name}" (${t.language || 'idioma?'}): crie e aprove na sua conta com esse nome${t.body_text ? `. Texto: "${String(t.body_text).slice(0, 160)}"` : ''}.`);
      }
      // troca os ids no grafo
      const ownMissing = new Set();
      for (const n of graph.nodes) {
        const d = n.data || {};
        if (n.type === 'tag') { d.add = (d.add || []).map((x) => tagMap.get(String(x)) || null).filter(Boolean); d.remove = (d.remove || []).map((x) => tagMap.get(String(x)) || null).filter(Boolean); }
      }
      walk(graph, (k, val, obj) => {
        if (val === undefined || val === null || val === '') return;
        if (k === 'tag_id' || k === 'delete_on_tag') obj[k] = tagMap.get(String(val)) || null;
        else if (k === 'email_id') obj[k] = emailMap.get(String(val)) || null;
        else if (k === 'agent_id') obj[k] = agentMap.get(String(val)) || null;
        else if (k === 'template_id' || k === 'fallback_template_id') obj[k] = tplMap.get(String(val)) || null;
        else if (OWN_FIELDS[k]) { obj[k] = null; ownMissing.add(OWN_FIELDS[k]); }
      });
      for (const label of ownMissing) pendencias.push(`${label}: escolha a da sua conta nos blocos que usam.`);
      const name = String(nome || pkg.name || 'Fluxo importado').trim().slice(0, 120);
      const c = (await client.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,$2,'Rascunho') returning id`, [orgId, name])).rows[0];
      const f = (await client.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [c.id, orgId])).rows[0];
      await client.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active, is_draft, source, note, created_by) values ($1,$2,1,$3::jsonb,false,true,'editor',$4,$5)`,
        [orgId, f.id, JSON.stringify(graph), `Importado de arquivo${pendencias.length ? ` — falta configurar: ${pendencias.length}` : ''}`.slice(0, 500), userId || null]);
      await client.query('commit');
      return { campaign_id: c.id, nome: name, pendencias, criados: { etiquetas: tagMap.size, emails: emailMap.size, agentes: agentMap.size } };
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  }
  return { exportFlow, importFlow, share, preview, importByCode };
}
