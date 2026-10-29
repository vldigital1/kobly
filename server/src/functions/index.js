// Rotas /functions/v1/<nome>: substituem as Edge Functions do Supabase, uma por vez.
// Enquanto uma função não foi portada, responde 501 com um aviso claro (a tela mostra o erro
// em vez de falhar em silêncio). Cada handler recebe (ctx, req, res, io).
import { AuthError } from '../auth.js';

const bearerOf = (req) => { const m = /^Bearer (.+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : null; };

// Atendente: conversa com os leads e lê o que precisa para isso; nada de configurar a conta.
const ATENDENTE = { inbox: null, 'workspace-settings': ['get'], 'flow-graph': ['list', 'get', 'get_version', 'stats'], team: ['list'], pipeline: null };
export const atendentePode = (fn, action) => Object.prototype.hasOwnProperty.call(ATENDENTE, fn) && (ATENDENTE[fn] === null || ATENDENTE[fn].includes(action));

// Travas do plano (só com BILLING_ENFORCE ligado): recurso que o plano precisa ter e vagas de conexão.
// Só as ações que criam ou ligam algo; ver e desligar continuam livres.
const GATES = {
  'whatsapp-account': { connect: { feature: 'canais', slots: 1 } },
  'meta-channels': { oauth_start: { feature: 'canais' }, connect: { feature: 'canais', slots: (b) => (Array.isArray(b.page_ids) ? b.page_ids.length : 1) * (Array.isArray(b.kinds) && b.kinds.length ? b.kinds.length : 2) } },
  'uazapi': { create: { slots: 1 } },
  'ai-keys': { connect: { feature: 'ia' }, activate: { feature: 'ia' } },
  voice: { connect: { feature: 'ia' }, tts: { feature: 'ia' }, translate_flow: { feature: 'ia' } },
  'meta-ads': { oauth_start: { feature: 'anuncios' }, connect: { feature: 'anuncios' }, oauth_connect: { feature: 'anuncios' } },
  'google-ads': { oauth_start: { feature: 'anuncios' }, oauth_connect: { feature: 'anuncios' } },
  'bulk-send': { create: { feature: 'disparo' } },
  'payment-integrations': { connect: { feature: 'cobranca' } },
};

export function createFunctions(ctx) {
  const wa = ctx.whatsapp;
  async function gate(fnName, body, org) {
    const g = ctx.billing && ctx.billing.enforce && GATES[fnName] && GATES[fnName][body.action];
    if (!g) return;
    if (g.feature) await ctx.billing.requireFeature(org.orgId, g.feature, org.role);
    if (g.slots) await ctx.billing.requireSlots(org.orgId, typeof g.slots === 'function' ? g.slots(body) : g.slots, org.role);
  }
  // Exige usuário logado e devolve o usuário + a empresa-alvo.
  async function authedOrg(req, body, fnName = null) {
    const user = await ctx.auth.userFromAccessToken(bearerOf(req));
    const org = await wa.resolveOrg(user, body.org_id || null);
    if (org.teamRole === 'atendente' && !atendentePode(fnName, body.action)) throw new AuthError(403, 'forbidden', 'Seu papel na equipe (atendente) só usa os Chats ao vivo, Leads e Pipeline.');
    return { user, org };
  }
  const whatsappAccount = async (req, res, io) => {
    const body = await io.readJson(req);
    const { org } = await authedOrg(req, body, 'whatsapp-account');
    await gate('whatsapp-account', body, org);
    switch (body.action) {
      case 'status': return io.send(res, 200, await wa.status(org, { refresh: !!body.refresh }));
      case 'connect': return io.send(res, 200, await wa.connect(org, body));
      case 'disconnect': return io.send(res, 200, await wa.disconnect(org));
      case 'sync_templates': return io.send(res, 200, await wa.syncTemplates(org));
      case 'create_template': return io.send(res, 200, await wa.createTemplate(org, body));
      case 'send_test': return io.send(res, 200, await wa.sendTemplateTo(org.orgId, { to: body.to, template_id: body.template_id, variables: body.variables || [], button_suffix: body.button_suffix }));
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  };
  const inviteClient = async (req, res, io) => {
    const body = await io.readJson(req);
    const user = await ctx.auth.userFromAccessToken(bearerOf(req));
    return io.send(res, 200, await ctx.invites.invite(user, body));
  };
  // Fluxo em grafo: salvar/validar/versões/métricas (ver src/flows/admin.js).
  const flowGraph = async (req, res, io) => {
    if (!ctx.flowAdmin) throw new AuthError(503, 'flows_unavailable', 'Motor de fluxos indisponível neste ambiente.');
    const body = await io.readJson(req);
    const { user, org } = await authedOrg(req, body, 'flow-graph');
    return io.send(res, 200, await ctx.flowAdmin.handle(org, user, body));
  };
  // Credenciais do gateway de pagamento e do Pixel da Meta (segredos cifrados; só o serviço escreve).
  const orgRoute = (svc, fnName) => async (req, res, io) => {
    if (!ctx[svc]) throw new AuthError(503, 'unavailable', 'Recurso indisponível neste ambiente.');
    const body = await io.readJson(req);
    const { org } = await authedOrg(req, body, fnName);
    await gate(fnName, body, org);
    return io.send(res, 200, await ctx[svc].handle(org, body));
  };
  // Serviços que também precisam do usuário (quem enviou, quem alterou).
  const orgUserRoute = (svc, fnName) => async (req, res, io) => {
    if (!ctx[svc]) throw new AuthError(503, 'unavailable', 'Recurso indisponível neste ambiente.');
    const body = await io.readJson(req);
    const { user, org } = await authedOrg(req, body, fnName);
    await gate(fnName, body, org);
    return io.send(res, 200, await ctx[svc].handle(org, user, body));
  };
  // Infraestrutura da Kobly (ex.: servidores Uazapi): só o Administrador da plataforma, sem empresa-alvo.
  const platformAdminRoute = (fn) => async (req, res, io) => {
    const body = await io.readJson(req);
    const user = await ctx.auth.userFromAccessToken(bearerOf(req));
    const p = (await ctx.pool.query(`select tipo_user_geral from public.profiles where auth_id = $1`, [user.id])).rows[0];
    if (!p || p.tipo_user_geral !== 'Administrador') throw new AuthError(403, 'forbidden', 'Só o Administrador da Kobly gerencia os servidores.');
    return io.send(res, 200, await fn(body));
  };
  // Só o usuário logado (sem empresa-alvo): o programa de afiliados é da pessoa, não da empresa.
  const userRoute = (fn) => async (req, res, io) => {
    const body = await io.readJson(req);
    const user = await ctx.auth.userFromAccessToken(bearerOf(req));
    return io.send(res, 200, await fn(user, body));
  };
  const handlers = {
    'whatsapp-account': () => whatsappAccount,
    'invite-client': () => inviteClient,
    'flow-graph': () => flowGraph,
    'payment-integrations': () => orgRoute('payments', 'payment-integrations'),
    'pixel-configs': () => orgRoute('pixel', 'pixel-configs'),
    'notify-channels': () => orgRoute('notifier', 'notify-channels'),
    'mcp-tokens': () => orgRoute('mcpTokens', 'mcp-tokens'),
    'workspace-settings': () => orgUserRoute('workspaceSettings', 'workspace-settings'),
    'inbox': () => orgUserRoute('inbox', 'inbox'),
    'team': () => orgUserRoute('team', 'team'),
    'products': () => orgUserRoute('products', 'products'),
    'tracking': () => orgUserRoute('tracking', 'tracking'),
    'ai-keys': () => orgUserRoute('aiKeys', 'ai-keys'),
    'meta-ads': () => orgUserRoute('metaAds', 'meta-ads'),
    voice: () => orgUserRoute('voice', 'voice'),
    'google-ads': () => orgUserRoute('googleAds', 'google-ads'),
    'platforms': () => orgUserRoute('platforms', 'platforms'),
    'uazapi': () => orgUserRoute('uazapi', 'uazapi'),
    'meta-channels': () => orgUserRoute('metaChannels', 'meta-channels'),
    'bulk-send': () => orgUserRoute('bulk', 'bulk-send'),
    'dashboard': () => orgUserRoute('dashboard', 'dashboard'),
    'pipeline': () => orgUserRoute('pipeline', 'pipeline'),
    'admin-dashboard': () => platformAdminRoute((body) => ctx.dashboard.admin(body)),
    'uazapi-servers': () => platformAdminRoute((body) => ctx.uazapi.handleServers(body)),
    'affiliates': () => userRoute((user, body) => ctx.affiliates.handle(user, body)),
    'affiliates-admin': () => platformAdminRoute((body) => ctx.affiliates.admin(body)),
    'billing': () => orgUserRoute('billing', 'billing'),
    'billing-admin': () => platformAdminRoute((body) => ctx.billing.admin(body)),
  };
  return {
    names: () => Object.keys(handlers),
    async handle(name, req, res, io) {
      if (req.method !== 'POST') throw new AuthError(405, 'method_not_allowed', 'Use POST');
      const h = handlers[name];
      if (!h) {
        await io.readBody(req, 64 * 1024).catch(() => {});
        return io.send(res, 501, { code: 'not_ported', error: 'not_ported', message: `A função "${name}" ainda não está disponível neste ambiente.` });
      }
      return h(ctx)(req, res, io);
    },
  };
}
