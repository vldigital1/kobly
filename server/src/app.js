import { createMailer } from './mailer.js';
import { createFlowEmail } from './email/flowEmail.js';
import { createBulk } from './bulk/service.js';
import { createDashboard } from './workspace/dashboard.js';
import { createPipeline } from './workspace/pipeline.js';
import { createInvites } from './invite.js';
import { createStorage } from './storage.js';
import { createUnsubscribe } from './unsubscribe.js';
import { createEngine } from './engine/steps.js';
import { createPostback } from './ingest/postback.js';
import { createServer } from 'node:http';
import { createAuth, AuthError } from './auth.js';
import { createLimiter } from './ratelimit.js';
import { createFunctions } from './functions/index.js';
import { createWhatsapp } from './whatsapp/service.js';
import { createGraph } from './whatsapp/graph.js';
import { parseKey } from './whatsapp/crypto.js';
import { createFlowRuntime } from './flows/runtime.js';
import { createFlowAdmin } from './flows/admin.js';
import { createAiKeys } from './ai/router.js';
import { createMetaAds } from './ads/meta.js';
import { createVoice } from './voice/elevenlabs.js';
import { createGoogleAds } from './ads/google.js';
import { createPayments } from './payments/service.js';
import { createXpag } from './payments/xpag.js';
import { createMercadoPago, createWoovi, createPushinPay, createSyncPay } from './payments/pix_br.js';
import { createZenith } from './payments/zenith.js';
import { createPlatforms } from './platforms/service.js';
import { createUazapi } from './whatsapp/uazapi.js';
import { createPixel } from './payments/pixel.js';
import { createNotifier } from './notify/telegram.js';
import { createCopilot } from './flows/copilot.js';
import { createMcp } from './mcp/server.js';
import { createWorkspaceSettings } from './workspace/settings.js';
import { createInbox } from './workspace/inbox.js';
import { createMetaChannels, channelAddress } from './messaging/metaChannels.js';
import { createTeam } from './workspace/team.js';
import { createUtmify } from './tracking/utmify.js';
import { createTracking, createProducts } from './tracking/service.js';
import { tokenFrom } from './ingest/auth.js';

const MAX_BODY = 64 * 1024;
const MAX_PROXY_BODY = 5 * 1024 * 1024;
// Cabeçalhos do cliente que podem seguir para o PostgREST (o resto é descartado).
const FORWARD_REQ = ['authorization', 'content-type', 'accept', 'prefer', 'range', 'range-unit', 'accept-profile', 'content-profile'];
const FORWARD_RES = ['content-type', 'content-range', 'content-profile', 'preference-applied', 'location'];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AuthError(413, 'too_large', 'Corpo grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = MAX_BODY) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString()); } catch { throw new AuthError(400, 'bad_json', 'JSON inválido'); }
}

export function createApp({ pool, config, mailer: mailerIn = null, fetchImpl = globalThis.fetch, graph = null }) {
  const mailer = mailerIn || createMailer({ apiKey: config.resendApiKey, from: config.mailFrom, siteUrl: config.siteUrl || (config.allowedOrigins || [])[0] || '' });
  const auth = createAuth({ pool, jwtSecret: config.jwtSecret, requireConfirm: config.requireConfirm, mailer, allowedOrigins: config.allowedOrigins || [] });
  const whatsapp = createWhatsapp({
    pool, graph: graph || createGraph({ base: config.metaGraphBase }),
    secretKey: config.secretKey ? parseKey(config.secretKey) : null,
    publicBaseUrl: config.publicBaseUrl || '', globalAppSecret: config.metaAppSecret || null,
  });
  const secretKeyBuf = config.secretKey ? parseKey(config.secretKey) : null;
  // IA: chave de cada empresa (BYOK); a da plataforma só como reserva se AI_PLATFORM_FALLBACK=true
  const aiKeys = createAiKeys({ pool, secretKey: secretKeyBuf, fetchImpl, allowPlatform: !!config.aiPlatformFallback,
    platform: { apiKey: config.aiApiKey, baseUrl: config.aiBaseUrl, model: config.aiModel } });
  const llm = aiKeys;
  const paymentsCore = createPayments({ pool, providers: { xpag: createXpag({ base: config.xpagBase, fetchImpl }), mercadopago: createMercadoPago({ fetchImpl }), woovi: createWoovi({ fetchImpl }), pushinpay: createPushinPay({ fetchImpl }), syncpay: createSyncPay({ fetchImpl }), zenith: createZenith({ fetchImpl }) }, secretKey: secretKeyBuf, publicBaseUrl: config.publicBaseUrl || '' });
  const pixel = createPixel({ pool, secretKey: secretKeyBuf, fetchImpl, graphBase: config.metaGraphBase });
  const notifier = createNotifier({ pool, secretKey: secretKeyBuf, fetchImpl });
  // UTMify: cobrança do fluxo vira pedido "aguardando pagamento"; confirmada, vira "pago" (nunca derruba o fluxo)
  const utmify = createUtmify({ pool, secretKey: secretKeyBuf, fetchImpl });
  const toUtmify = (charge, status) => utmify.onCharge(charge, status).catch((e) => console.error('[utmify]', e.message));
  const payments = {
    ...paymentsCore,
    async createCharge(a) { const c = await paymentsCore.createCharge(a); if (c && c.status === 'pending') toUtmify(c, 'waiting_payment'); return c; },
    receiveWebhook: (prov, tok, raw, onConfirmed) => paymentsCore.receiveWebhook(prov, tok, raw, async (charge) => { await toUtmify(charge, 'paid'); if (onConfirmed) await onConfirmed(charge); }),
  };
  // WhatsApp por QR Code (Uazapi). Mensagens recebidas entram na mesma caixa e nos mesmos fluxos.
  let flows = null;
  const uazapi = createUazapi({ pool, secretKey: secretKeyBuf, base: config.uazapiBase, adminToken: config.uazapiAdminToken, envCapacity: config.uazapiCapacity || 300, publicBaseUrl: config.publicBaseUrl || '', fetchImpl,
    onInbound: (a) => flows.onInbound(a) });
  // Instagram Direct e Messenger: endereço ig:<id> / fb:<id> no lugar do telefone
  const metaChannels = createMetaChannels({ pool, secretKey: secretKeyBuf, fetchImpl, graphBase: config.metaAdsGraphBase, appId: config.metaAdsAppId, appSecret: config.metaAdsAppSecret,
    configId: config.metaMsgConfigId, verifyToken: config.metaMsgVerifyToken, publicBaseUrl: config.publicBaseUrl || '', siteUrl: config.siteUrl, onInbound: (a) => flows.onInboundLead(a) });
  const viaMeta = (a) => !!channelAddress(a && a.to);
  // Envio de texto: API oficial quando a empresa tem; senão o número conectado por QR Code.
  const officialConnected = async (orgId) => (await pool.query(`select 1 from public.whatsapp_accounts where organization_id = $1 and status = 'connected'`, [orgId])).rowCount > 0;
  const waRouted = {
    ...whatsapp,
    async sendTextTo(orgId, a) {
      if (viaMeta(a)) return metaChannels.sendTextTo(orgId, a);
      try { return await whatsapp.sendTextTo(orgId, a); }
      catch (e) { if (e.code === 'not_connected' && await uazapi.hasConnected(orgId)) return uazapi.sendTextTo(orgId, a); throw e; }
    },
    async sendMediaTo(orgId, a) {
      if (viaMeta(a)) return metaChannels.sendMediaTo(orgId, a);
      try { return await whatsapp.sendMediaTo(orgId, a); }
      catch (e) { if (e.code === 'not_connected' && await uazapi.hasConnected(orgId)) return uazapi.sendMediaTo(orgId, a); throw e; }
    },
    // apagar para todos só existe no WhatsApp por QR Code (a API oficial da Meta não apaga)
    deleteMessage: (orgId, a) => uazapi.deleteMessage(orgId, a),
    // mídia, foto do contato e ligação: só existem no WhatsApp por QR Code
    mediaLink: (orgId, a) => uazapi.mediaLink(orgId, a),
    avatarOf: (orgId, phone) => uazapi.avatarOf(orgId, phone),
    ringCall: (orgId, phone) => uazapi.ringCall(orgId, phone),
    // sem a API oficial, o WhatsApp comum não tem janela de 24 h
    freeTextAllowed: async (orgId, to) => !channelAddress(to) && !(await officialConnected(orgId)) && uazapi.hasConnected(orgId),
    sendTemplateTo: (orgId, a) => (viaMeta(a) ? Promise.reject(Object.assign(new Error('Instagram e Messenger não usam modelos do WhatsApp.'), { code: 'unsupported' })) : whatsapp.sendTemplateTo(orgId, a)),
    sendInteractiveTo: (orgId, a) => (viaMeta(a) ? metaChannels.sendInteractiveTo(orgId, a) : whatsapp.sendInteractiveTo(orgId, a)),
    typingFor: (orgId, a) => (viaMeta(a) || !whatsapp.typingFor ? Promise.resolve() : whatsapp.typingFor(orgId, a)),
  };
  const flowEmail = createFlowEmail({ pool, apiKey: config.resendApiKey, platformFrom: config.mailFrom, sendingDomain: config.resendSendingDomain, unsubSecret: config.unsubscribeSecret, publicBaseUrl: config.publicBaseUrl || '', fetchImpl });
  flows = createFlowRuntime({ pool, whatsapp: waRouted, email: flowEmail, llm, payments, pixel, notifier });
  whatsapp.setInboundHandler(flows.onInbound);
  const bulk = createBulk({ pool, whatsapp: waRouted, email: flowEmail, flows });
  const flowAdmin = createFlowAdmin({ pool, copilot: createCopilot({ pool, llm }) });
  const mcp = createMcp({ pool, flowAdmin });
  const postback = createPostback({ pool, flows });
  const invites = createInvites({ pool, auth, mailer });
  const storage = createStorage({ dir: config.storageDir || '/var/lib/kobly-storage', canAccessOrg: async (user, org) => { try { return (await whatsapp.resolveOrg(user, org)).role !== 'Suporte'; } catch { return false; } } });
  const unsub = createUnsubscribe({ pool, secret: config.unsubscribeSecret });
  const workspaceSettings = createWorkspaceSettings({ pool });
  const inbox = createInbox({ pool, whatsapp: waRouted, flows });
  const team = createTeam({ pool, auth, mailer });
  const tracking = createTracking({ pool, utmify });
  const products = createProducts({ pool });
  const platforms = createPlatforms({ pool, secretKey: secretKeyBuf, publicBaseUrl: config.publicBaseUrl || '', fetchImpl });
  const metaAds = createMetaAds({ pool, secretKey: secretKeyBuf, fetchImpl, graphBase: config.metaAdsGraphBase,
    appId: config.metaAdsAppId, appSecret: config.metaAdsAppSecret, configId: config.metaAdsConfigId, publicBaseUrl: config.publicBaseUrl, siteUrl: config.siteUrl });
  const googleAds = createGoogleAds({ pool, secretKey: secretKeyBuf, fetchImpl, clientId: config.googleAdsClientId, clientSecret: config.googleAdsClientSecret,
    loginCustomerId: config.googleAdsLoginCustomerId, apiVersion: config.googleAdsApiVersion,
    publicBaseUrl: config.publicBaseUrl || '', siteUrl: config.siteUrl });
  const voice = createVoice({ pool, secretKey: secretKeyBuf, aiKeys, storage, publicBaseUrl: config.publicBaseUrl || '', fetchImpl, base: config.elevenlabsBase });
  const functions = createFunctions({ pool, config, auth, mailer, whatsapp, invites, flowAdmin, payments, pixel, notifier, mcpTokens: { handle: mcp.handleTokens }, workspaceSettings, inbox, team, tracking, products, aiKeys, metaAds, googleAds, voice, metaChannels, platforms, uazapi, bulk, dashboard: createDashboard({ pool }), pipeline: createPipeline({ pool }) });
  // Por IP (escritórios compartilham IP, então o teto é alto); o freio por conta fica em auth.js.
  const loginLimit = createLimiter({ max: config.loginPerMin ?? 60, windowMs: 60_000 });
  const signupLimit = createLimiter({ max: config.signupPerMin ?? 20, windowMs: 60_000 });

  const clientIp = (req) => (config.trustProxy && (req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress || 'unknown';

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (config.allowedOrigins || []).includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, accept, prefer, range, range-unit, accept-profile, content-profile, x-client-info, apikey, x-kobly-token, x-kobly-signature');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'content-range, content-profile, preference-applied');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const bearer = (req) => { const m = /^Bearer (.+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : null; };

  const routes = {
    'POST /auth/login': async (req, res, body) => {
      if (!loginLimit(clientIp(req))) throw new AuthError(429, 'rate_limited', 'Muitas tentativas');
      send(res, 200, await auth.login(body.email, body.password));
    },
    'POST /auth/signup': async (req, res, body) => {
      if (!signupLimit(clientIp(req))) throw new AuthError(429, 'rate_limited', 'Muitas tentativas');
      send(res, 200, await auth.signup(body.email, body.password, body.nome, body.redirect_to));
    },
    'POST /auth/refresh': async (req, res, body) => send(res, 200, await auth.refresh(body.refresh_token)),
    'POST /auth/logout': async (req, res, body) => { await auth.logout(body.refresh_token); send(res, 200, { ok: true }); },
    'GET /auth/user': async (req, res) => send(res, 200, auth.userView(await auth.userFromAccessToken(bearer(req)))),
    'POST /auth/recover': async (req, res, body) => {
      if (!signupLimit(clientIp(req))) throw new AuthError(429, 'rate_limited', 'Muitas tentativas');
      await auth.requestRecovery(body.email, body.redirect_to); send(res, 200, { ok: true });
    },
    'POST /auth/reset': async (req, res, body) => send(res, 200, await auth.resetPassword(body.token, body.password)),
    'POST /auth/confirm': async (req, res, body) => { await auth.confirmEmail(body.token); send(res, 200, { ok: true }); },
    'POST /auth/password': async (req, res, body) => {
      const u = await auth.userFromAccessToken(bearer(req));
      await auth.changePassword(u, body.password); send(res, 200, { ok: true });
    },
    'GET /health': async (req, res) => { await pool.query('select 1'); send(res, 200, { ok: true }); },
  };

  // /rest/v1/* → PostgREST (o JWT é validado lá; o banco aplica a RLS).
  async function proxyRest(req, res, url) {
    if (!config.postgrestUrl) throw new AuthError(503, 'rest_unavailable', 'Serviço de dados indisponível');
    const target = config.postgrestUrl.replace(/\/$/, '') + url.pathname.replace(/^\/rest\/v1/, '') + url.search;
    const headers = {};
    for (const h of FORWARD_REQ) if (req.headers[h]) headers[h] = req.headers[h];
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const body = hasBody ? await readBody(req, MAX_PROXY_BODY) : undefined;
    let up;
    try { up = await fetchImpl(target, { method: req.method, headers, body: hasBody && body.length ? body : undefined }); }
    catch { throw new AuthError(502, 'rest_unreachable', 'Serviço de dados não respondeu'); }
    res.statusCode = up.status;
    for (const h of FORWARD_RES) { const v = up.headers.get(h); if (v) res.setHeader(h, v); }
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await up.arrayBuffer()));
  }

  const server = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/rest/v1' || path.startsWith('/rest/v1/')) return await proxyRest(req, res, url);
      const wm = /^\/webhooks\/whatsapp\/([0-9a-f-]{36})$/.exec(path);
      if (wm) {
        if (req.method === 'GET') {
          const challenge = await whatsapp.verifyWebhook(wm[1], url.searchParams.get('hub.mode'), url.searchParams.get('hub.verify_token'), url.searchParams.get('hub.challenge'));
          res.statusCode = challenge === null ? 403 : 200; res.setHeader('Content-Type', 'text/plain'); return res.end(challenge === null ? 'forbidden' : challenge);
        }
        if (req.method === 'POST') {
          const raw = await readBody(req, MAX_PROXY_BODY);
          const r = await whatsapp.receiveWebhook(wm[1], raw, req.headers['x-hub-signature-256']);
          const { status: st, ...counts } = r;
          return send(res, st, st === 200 ? { ok: true, ...counts } : { code: 'rejected' });
        }
      }
      // Instagram Direct e Messenger: verificação (GET) e mensagens (POST, assinadas com o segredo do app)
      if (path === '/webhooks/meta-messaging') {
        if (req.method === 'GET') { const v = metaChannels.verify(Object.fromEntries(url.searchParams)); res.statusCode = v.status; res.setHeader('Content-Type', 'text/plain'); return res.end(v.body); }
        if (req.method === 'POST') { const r = await metaChannels.receiveWebhook(await readBody(req, 1024 * 1024), req.headers['x-hub-signature-256']); return send(res, r.status, { ok: r.status === 200 }); }
      }
      // Aviso da Uazapi (WhatsApp por QR Code): a URL identifica a instância; o token no corpo prova a origem.
      const uz = /^\/webhooks\/uazapi\/([0-9a-f-]{36})$/.exec(path);
      if (uz && req.method === 'POST') {
        const r = await uazapi.receiveWebhook(uz[1], (await readBody(req, 1024 * 1024)).toString('utf8'));
        return send(res, r.status, { ok: r.status === 200 });
      }
      // MCP da Kobly (assistentes de IA): token próprio da empresa no Authorization; só rascunhos.
      if (path === '/mcp') {
        if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'POST'); return res.end(); }
        const r = await mcp.handleHttp(bearer(req), (await readBody(req, 1024 * 1024)).toString('utf8'));
        if (r.body === null) { res.statusCode = r.status; return res.end(); }
        return send(res, r.status, r.body);
      }
      // Aviso do gateway de pagamento: o token na URL só identifica a credencial; a confirmação é checada na API do gateway.
      const pm = /^\/webhooks\/payments\/([a-z]+)\/([A-Za-z0-9_-]{20,64})$/.exec(path);
      if (pm && req.method === 'POST') {
        const r = await payments.receiveWebhook(pm[1], pm[2], (await readBody(req, 256 * 1024)).toString('utf8'), (charge) => flows.onPaymentConfirmed(charge));
        return send(res, r.status, r.body);
      }
      const sp = /^\/storage\/v1\/object\/(?:(public)\/)?([a-z-]+)\/([^/]+)\/([^/]+)$/.exec(path);
      if (sp) {
        if (sp[1] && req.method === 'GET') {
          const f = await storage.read(sp[2], sp[3], decodeURIComponent(sp[4]));
          if (!f) return send(res, 404, { code: 'not_found', message: 'Not found' });
          res.statusCode = 200; res.setHeader('Content-Type', f.type); res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'public, max-age=300'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          if (f.download) res.setHeader('Content-Disposition', 'attachment');
          return res.end(f.body);
        }
        if (!sp[1] && req.method === 'POST') {
          const user = await auth.userFromAccessToken(bearer(req));
          return send(res, 200, await storage.upload(user, sp[2], sp[3], decodeURIComponent(sp[4]), await readBody(req, storage.maxFor(sp[2]) + 1024)));
        }
      }
      // Volta do login "Conectar com Facebook" (Facebook Ads): o "state" assinado diz de qual empresa é.
      if (path === '/oauth/google/callback' && req.method === 'GET') {
        const html = await googleAds.oauthCallback(Object.fromEntries(url.searchParams));
        res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer'); return res.end(html);
      }
      if (path === '/oauth/meta/callback' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        const html = metaChannels.ownsState(q.state) ? await metaChannels.oauthCallback(q) : await metaAds.oauthCallback(q);
        res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer'); return res.end(html);
      }
      if (path === '/functions/v1/unsubscribe' && (req.method === 'GET' || req.method === 'POST')) {
        const raw = req.method === 'POST' ? (await readBody(req, 16 * 1024)).toString('utf8') : '';
        const r = await unsub.handle(req.method, url.searchParams.get('token') || '', raw, url.searchParams.get('confirm') === '1');
        res.statusCode = r.status; res.setHeader('Content-Type', r.type); res.setHeader('Cache-Control', 'no-store'); return res.end(r.body);
      }
      if (path === '/functions/v1/postback-receiver' && req.method === 'POST') {
        const sig = url.searchParams.get('signature');
        const r = await postback.receive(tokenFrom(req.headers, url.searchParams), (await readBody(req, MAX_PROXY_BODY)).toString('utf8'), sig ? { ...req.headers, 'x-kiwify-signature': sig } : req.headers);
        return send(res, r.status, r.body);
      }
      const fm = /^\/functions\/v1\/([a-z0-9-]+)$/.exec(path);
      // foto do perfil do WhatsApp vai em base64 na rota uazapi: limite maior só ali
      if (fm) return await functions.handle(fm[1], req, res, { readJson: (r) => readJson(r, fm[1] === 'uazapi' || fm[1] === 'bulk-send' ? 2 * 1024 * 1024 : MAX_BODY), readBody, send, bearer, clientIp });
      const handler = routes[`${req.method} ${path}`];
      if (!handler) return send(res, 404, { code: 'not_found', message: 'Not found' });
      const body = req.method === 'POST' ? await readJson(req) : {};
      await handler(req, res, body);
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, { code: e.code, error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
      console.error('[kobly-api]', e && e.message);
      send(res, 500, { code: 'internal', message: 'Erro interno' });
    }
  });
  const engine = createEngine({ pool, whatsapp });
  return { server, auth, engine, flows, bulk };
}
