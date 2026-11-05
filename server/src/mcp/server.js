// MCP da Kobly (Model Context Protocol, transporte HTTP): POST /mcp com Authorization: Bearer kbmcp_...
// Deixa um assistente de IA (Claude, ChatGPT…) montar fluxos para a empresa dona do token:
// ler o catálogo de blocos e os recursos da conta, validar, CRIAR um fluxo novo (como rascunho) ou salvar um RASCUNHO
// num fluxo que já existe, ler métricas e o copiloto.
// Nunca publica: ativar uma versão é sempre um clique de uma pessoa no editor. Token só em hash no banco.
import { createHash, randomBytes } from 'node:crypto';
import { AuthError } from '../auth.js';
import { NODE_TYPES, TIPOS_EVENTO, PAYMENT_METHODS } from '../flows/graph.js';
import { createLimiter } from '../ratelimit.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const sha = (v) => createHash('sha256').update(v).digest('hex');

// O que cada bloco espera em "data" (guia para a IA montar o grafo certo).
const DATA_GUIDE = {
  trigger: '{ events: [eventos de checkout], stop_on_purchase?: bool } (evento do checkout) OU { source: "message", mode: "any" | "keywords", keywords?: ["quero saber mais", ...], match?: contains|equals|starts } (mensagem do lead no WhatsApp: qualquer texto só na primeira conversa; palavras-chave toda vez)',
  send_template: '{ template_id: id de kobly_recursos.modelos (APROVADO), vars: ["primeiro_nome" | "{{produto}}" | "texto fixo", ...] } — único que funciona com a janela de 24 h fechada',
  send_text: '{ text, link_preview?: bool, reply_last?: bool, react_last?: bool, react_emoji?: "👍", forwarded?: bool } — texto livre (na API oficial só com a janela de 24 h aberta)',
  send_media: '{ kind: image|audio|video|document, url: https público ou {{pagamento_qr}}, caption? (não em áudio), filename?, ptt?: bool (áudio como gravação de voz, padrão true), view_once?: bool, reply_last?, react_last?, react_emoji?, forwarded? }',
  send_buttons: '{ text, options: [{ id: a-z0-9_, title: até 20 (≤3 opções) ou 24 caracteres }], save_as?, timeout_minutes? } — saídas opt_<id>, other, timeout, failed',
  delay: '{ min_seconds, max_seconds, typing?: bool } ou { seconds }',
  wait_reply: '{ save_as?: "resposta", timeout_minutes? }',
  condition: '{ match: all|any, rules: [{ kind: var, name, op: eq|neq|contains|not_contains|gt|gte|lt|lte|empty|not_empty, value } | { kind: tag, tag_id, op: has|not_has } | { kind: purchased } | { kind: window_open } | { kind: weekday, days: [0-6] } | { kind: time_between, from: "HH:MM", to: "HH:MM" } | { kind: country, ddi: ["52"] }] }',
  ai_classify: '{ input?: "{{resposta}}", instructions?, outputs: [{ key, description }] (2–8), save_as? } — saídas out_<key>, other, error',
  ai_extract: '{ input?, instructions?, fields: [{ name, description, required? }] } — saídas ok, missing, error',
  ai_agent: '{ objective, knowledge?, tone?, opening?, max_turns?: 1–30, timeout_minutes? } — saídas done, handoff, expiration, error',
  split: '{ variants: [{ id, weight }] (2–6) } — saídas var_<id>, todas ligadas',
  checkpoint: '{ name }',
  wait_until: '{ mode: business_hours, days: [1..5], from: "09:00", to: "18:00" } ou { mode: datetime, at: "AAAA-MM-DD HH:MM" }',
  notify: '{ channel_id: id de kobly_recursos.canais_alerta, text }',
  payment: `{ integration_id: id de kobly_recursos.contas_pagamento, currency: ${Object.keys(PAYMENT_METHODS).join('|')}, method: (${Object.entries(PAYMENT_METHODS).map(([c, m]) => `${c}: ${m.join('/')}`).join('; ')}), amount: "45" ou "{{valor}}", open_amount?, listen_hours? } — saídas charge_created (use {{pagamento_codigo}}, {{pagamento_qr}}, {{pagamento_link}} na mensagem seguinte), payment_approved, error`,
  record_sale: '{ amount?, currency?, product? } — vazio usa o valor pago na cobrança',
  pixel: '{ pixel_config_id: id de kobly_recursos.pixels, event: Purchase|Lead|InitiateCheckout|AddPaymentInfo, value? }',
  tag: '{ add: [tag_id], remove: [tag_id] }',
  set_var: '{ name, op: set|add|subtract|multiply|divide, value }',
  goto_flow: '{ campaign_id: id de outro fluxo (kobly_listar_campanhas) } — o lead sai deste fluxo e começa o outro; sem saídas',
  webhook: '{ url: https://..., method?: POST|GET|PUT|PATCH, headers?: [{ key, value }], body?: texto/JSON com {{variaveis}} (vazio = JSON pronto com o lead e as variáveis), save_as?: "webhook" } — saídas success (2xx) e error; resposta em {{<save_as>_status}}, {{<save_as>_resposta}} e {{<save_as>_<campo>}}',
  end: '{}',
};

export function guide() {
  return {
    formato: { version: 1, start: 'ref do bloco Gatilho', nodes: [{ ref: 'id único (letras, números, _ e -)', type: 'tipo do bloco', data: '{...}', next: { '<saída>': '<ref do próximo bloco>' }, position: '{ x, y } opcional' }] },
    regras: [
      'Comece por exatamente um bloco "trigger" e defina "start" com a ref dele.',
      'Cada saída liga a no máximo um bloco; saídas obrigatórias precisam estar ligadas (o validador avisa).',
      'Laço precisa passar por um bloco que espera (delay, wait_reply, send_buttons, ai_agent, wait_until).',
      'Para falar com um lead que não escreveu nas últimas 24 h, comece com send_template (modelo aprovado).',
      'Use só ids que existem em kobly_recursos; não invente ids.',
      'Valide com kobly_validar_fluxo e corrija TODOS os erros antes de salvar.',
      'Fluxo NOVO: use kobly_criar_fluxo (cria o fluxo com o nome e salva o rascunho). Mudar um fluxo que já existe: kobly_salvar_rascunho com o campaign_id dele.',
      'Só diga ao usuário que o fluxo foi criado se a ferramenta respondeu ok: true. Se veio "erro", conte o erro, corrija e tente de novo. Depois confira com kobly_ler_fluxo.',
      'O fluxo fica como rascunho: uma pessoa abre em Fluxos, revisa e publica.',
    ],
    eventos_de_checkout: TIPOS_EVENTO,
    variaveis: '{{nome}} {{primeiro_nome}} {{email}} {{telefone}} {{produto}} {{valor}} {{cta_link}} {{resposta}} {{ultima_mensagem}} {{mensagem_inicial}} {{hora_atual}} {{dia_semana}} {{data_atual}} {{evento}} {{var.<nome>}} e as definidas por blocos (save_as, set_var, ai_extract, pagamento_*, webhook_*). Saudação pela hora do país: {{saudacao_personalizada}} (português), {{saudacao_personalizada_es}}, {{saudacao_personalizada_en}}, {{saudacao_personalizada_es_mx}}, {{saudacao_personalizada_es_co}}, {{saudacao_personalizada_pt_br}}… Anúncio de origem (Click-to-WhatsApp): {{source_id}} {{ctwa_clid}} {{ad_source_url}} {{ad_title}} {{ad_body}}',
    blocos: Object.entries(NODE_TYPES).map(([type, s]) => ({
      type, nome: s.label, saidas: s.dynamic ? `${s.exits.join(', ')} + dinâmicas (ver data)` : s.exits.join(', ') || '(nenhuma)',
      saidas_obrigatorias: s.required, data: DATA_GUIDE[type] || '{}',
    })),
  };
}

const TOOLS = [
  { name: 'kobly_guia', description: 'Formato do fluxo, regras, eventos de checkout, variáveis e TODOS os blocos com saídas e campos. Leia antes de montar um fluxo.', inputSchema: { type: 'object', properties: {} } },
  { name: 'kobly_listar_campanhas', description: 'Campanhas da conta: id, nome, status, versão publicada do fluxo e quantidade de rascunhos.', inputSchema: { type: 'object', properties: {} } },
  { name: 'kobly_recursos', description: 'Ids que os blocos usam: modelos do WhatsApp (só APPROVED enviam), etiquetas, contas de pagamento, pixels e canais de alerta. Sem segredos.', inputSchema: { type: 'object', properties: {} } },
  { name: 'kobly_ler_fluxo', description: 'Lê o fluxo de uma campanha: versão publicada (ou a versão pedida) e a lista de versões/rascunhos.', inputSchema: { type: 'object', required: ['campaign_id'], properties: { campaign_id: { type: 'string' }, version: { type: 'integer', description: 'opcional: ler uma versão específica' } } } },
  { name: 'kobly_validar_fluxo', description: 'Valida um fluxo SEM salvar. Devolve erros (impedem salvar) e avisos.', inputSchema: { type: 'object', required: ['graph'], properties: { graph: { type: 'object' } } } },
  { name: 'kobly_criar_fluxo', description: 'Cria um FLUXO NOVO com o nome dado e salva o grafo como rascunho (não publica). Recusa se houver erros. Use para fluxo novo ou cópia; aparece em Fluxos para uma pessoa revisar e publicar.', inputSchema: { type: 'object', required: ['nome', 'graph'], properties: { nome: { type: 'string', description: 'nome do fluxo (até 80 letras)' }, graph: { type: 'object' }, nota: { type: 'string', description: 'o que o fluxo faz (aparece para quem revisa)' } } } },
  { name: 'kobly_salvar_rascunho', description: 'Salva o fluxo como RASCUNHO da campanha (não publica). Recusa se houver erros. Uma pessoa revisa e publica no editor da Kobly.', inputSchema: { type: 'object', required: ['campaign_id', 'graph'], properties: { campaign_id: { type: 'string' }, graph: { type: 'object' }, nota: { type: 'string', description: 'o que mudou e por quê (aparece para quem revisa)' } } } },
  { name: 'kobly_metricas', description: 'Métricas do fluxo publicado: execuções por situação, leads que passaram por cada bloco e leads parados em cada bloco agora (sem dados pessoais).', inputSchema: { type: 'object', required: ['campaign_id'], properties: { campaign_id: { type: 'string' } } } },
  { name: 'kobly_copiloto', description: 'Sugestões do copiloto a partir das métricas reais por bloco (onde o funil perde leads e o que mudar).', inputSchema: { type: 'object', required: ['campaign_id'], properties: { campaign_id: { type: 'string' } } } },
];

export function createMcp({ pool, flowAdmin, limiter = createLimiter({ max: 60, windowMs: 60_000 }), now = () => new Date() }) {
  // ---- tokens (rota mcp-tokens, para a tela de Integrações) ----------------------------
  async function handleTokens(ctx, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode gerenciar o acesso de IA.'); };
    switch (body.action) {
      case 'list': return { tokens: (await pool.query(`select id, label, token_prefix, last_used_at, revoked_at, created_at from public.mcp_tokens where organization_id = $1 order by created_at desc`, [orgId])).rows };
      case 'create': {
        editor();
        const token = `kbmcp_${randomBytes(32).toString('base64url')}`;
        const { rows } = await pool.query(`insert into public.mcp_tokens (organization_id, label, token_prefix, token_hash, created_by) values ($1,$2,$3,$4,$5) returning id, label, token_prefix, created_at`,
          [orgId, String(body.label || 'Assistente de IA').slice(0, 60), token.slice(0, 12), sha(token), ctx.userId || null]);
        return { token, info: rows[0], aviso: 'Copie agora: este token não aparece de novo.' };
      }
      case 'revoke': {
        editor();
        const r = await pool.query(`update public.mcp_tokens set revoked_at = now() where id = $1 and organization_id = $2 and revoked_at is null`, [body.id, orgId]);
        return { ok: r.rowCount === 1 };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  async function authenticate(bearer) {
    if (!bearer || !/^kbmcp_[A-Za-z0-9_-]{30,}$/.test(bearer)) return null;
    const row = (await pool.query(`select id, organization_id, last_used_at from public.mcp_tokens where token_hash = $1 and revoked_at is null`, [sha(bearer)])).rows[0];
    if (!row) return null;
    if (!row.last_used_at || now() - new Date(row.last_used_at) > 5 * 60_000) await pool.query(`update public.mcp_tokens set last_used_at = now() where id = $1`, [row.id]).catch(() => {});
    return { tokenId: row.id, orgId: row.organization_id };
  }

  // ---- ferramentas -----------------------------------------------------------------------
  async function callTool(org, name, args = {}) {
    const ctx = { orgId: org.orgId, role: 'Cliente' };
    const A = (action, extra) => flowAdmin.handle(ctx, null, { action, ...extra });
    switch (name) {
      case 'kobly_guia': return guide();
      case 'kobly_listar_campanhas': return { campanhas: (await pool.query(`select c.id, c.nome, c.status_campanha as status,
          (select v.version from public.campaign_flows f join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where f.campaign_id = c.id) as versao_publicada,
          (select count(*)::int from public.campaign_flows f join public.flow_graph_versions v on v.flow_id = f.id and v.is_draft where f.campaign_id = c.id) as rascunhos
        from public.campaigns c where c.organization_id = $1 order by c.created_at desc limit 100`, [org.orgId])).rows };
      case 'kobly_recursos': {
        const q = (sql) => pool.query(sql, [org.orgId]).then((r) => r.rows);
        return {
          modelos: await q(`select id, name, language, status, category, variable_count, body_text from public.whatsapp_templates where organization_id = $1 order by name`),
          etiquetas: await q(`select id, nome from public.tags where organization_id = $1 order by nome`),
          contas_pagamento: await q(`select id, provider, label, sandbox from public.payment_integrations where organization_id = $1`),
          pixels: await q(`select id, label, pixel_id from public.pixel_configs where organization_id = $1`),
          canais_alerta: await q(`select id, kind, label from public.notification_channels where organization_id = $1`),
        };
      }
      case 'kobly_ler_fluxo': {
        const base = await A('get', { campaign_id: args.campaign_id });
        if (args.version) return { ...(await A('get_version', { campaign_id: args.campaign_id, version: args.version })), versoes: base.versions };
        return { publicado: base.active, versoes: base.versions };
      }
      case 'kobly_validar_fluxo': return A('validate', { graph: args.graph });
      case 'kobly_criar_fluxo': {
        const nome = String(args.nome || '').trim().slice(0, 80);
        if (!nome) throw new AuthError(422, 'validation_failed', 'Informe o nome do fluxo.');
        const v = await A('validate', { graph: args.graph });
        if (!v.ok) throw Object.assign(new AuthError(422, 'invalid_graph', `O fluxo tem erros: ${v.errors.slice(0, 5).join(' | ')}`), { details: v });
        const camp = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,$2,'Rascunho') returning id`, [org.orgId, nome])).rows[0];
        await pool.query(`insert into public.campaign_stats (campaign_id, organization_id) values ($1,$2)`, [camp.id, org.orgId]).catch(() => {});
        try {
          const r = await A('save_draft', { campaign_id: camp.id, graph: args.graph, note: args.nota || 'criado pela IA (MCP)', source: 'mcp' });
          return { ...r, campaign_id: camp.id, nome, proximo_passo: `Fluxo "${nome}" criado como rascunho. Ele aparece em Fluxos na Kobly; uma pessoa abre, revisa e publica.` };
        } catch (e) { await pool.query(`delete from public.campaigns where id = $1`, [camp.id]).catch(() => {}); throw e; }
      }
      case 'kobly_salvar_rascunho': {
        const r = await A('save_draft', { campaign_id: args.campaign_id, graph: args.graph, note: args.nota, source: 'mcp' });
        const c = (await pool.query(`select nome from public.campaigns where id = $1`, [args.campaign_id])).rows[0];
        return { ...r, nome: c && c.nome, proximo_passo: `Rascunho salvo na versão ${r.version} do fluxo "${c && c.nome}". Uma pessoa abre esse fluxo em Fluxos, revisa e publica.` };
      }
      case 'kobly_metricas': { const { recent, by_node, ...s } = await A('stats', { campaign_id: args.campaign_id }); return s; } // sem dados pessoais
      case 'kobly_copiloto': return A('copilot', { campaign_id: args.campaign_id });
      default: throw new AuthError(404, 'unknown_tool', `Ferramenta desconhecida: ${name}`);
    }
  }

  // ---- JSON-RPC -------------------------------------------------------------------------
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  async function handleMessage(org, msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Requisição inválida');
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null; // notifications/initialized etc.: nada a responder
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return ok({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kobly', version: '1.0.0' },
          instructions: 'Kobly: automação de vendas e atendimento pelo WhatsApp. Leia kobly_guia e kobly_recursos antes de montar um fluxo; valide antes de salvar. Fluxo novo: kobly_criar_fluxo. Mudar fluxo existente: kobly_salvar_rascunho. Só diga que deu certo se a resposta tiver ok: true. Você só salva rascunhos; uma pessoa publica.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params && msg.params.name;
        try {
          const data = await callTool(org, name, (msg.params && msg.params.arguments) || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: false });
        } catch (e) {
          const text = e instanceof AuthError ? JSON.stringify({ erro: e.message, codigo: e.code, ...(e.details ? { detalhes: e.details } : {}) }) : JSON.stringify({ erro: 'Erro interno' });
          if (!(e instanceof AuthError)) console.error('[mcp]', name, e && e.message);
          return ok({ content: [{ type: 'text', text }], isError: true });
        }
      }
      default: return rpcError(msg.id, -32601, `Método não suportado: ${msg.method}`);
    }
  }

  // Requisição HTTP inteira → { status, body | null }
  async function handleHttp(bearer, rawBody) {
    const org = await authenticate(bearer);
    if (!org) return { status: 401, body: rpcError(null, -32001, 'Token do MCP inválido ou revogado. Gere um em Integrações → Acesso de IA (MCP).') };
    if (!limiter(org.tokenId)) return { status: 429, body: rpcError(null, -32002, 'Muitas requisições; aguarde um minuto.') };
    let msg;
    try { msg = JSON.parse(rawBody || ''); } catch { return { status: 400, body: rpcError(null, -32700, 'JSON inválido') }; }
    if (Array.isArray(msg)) return { status: 400, body: rpcError(null, -32600, 'Lotes não são suportados') };
    const res = await handleMessage(org, msg);
    return res ? { status: 200, body: res } : { status: 202, body: null };
  }

  return { handleHttp, handleTokens, handleMessage, callTool, TOOLS };
}
