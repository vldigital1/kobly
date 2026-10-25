// Rota POST /functions/v1/platforms: plataformas de venda com página própria em Integrações.
// Cada conexão é um postback_token (a URL que a plataforma chama) marcado com a plataforma e a chave
// de validação dela (ver 0079 e verifyPlatformProof em ingest/postback.js).
//   API (Kiwify, Cakto): a pessoa cola as credenciais de API; a Kobly cria o webhook NA CONTA dela,
//     com a URL da conexão e a chave de validação, e guarda as credenciais cifradas para remover depois.
//   Manual (Hotmart, Kirvano, PerfectPay, Payt): a Kobly mostra a URL e o passo a passo; a pessoa cola a
//     chave de validação que a plataforma mostra (hottok, token, integration_key).
// Ações: list | connect_manual | connect_api | update_secret | disconnect.
import { randomBytes } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

const UUID = /^[0-9a-f-]{36}$/i;
export const PLATFORMS = {
  hotmart: { label: 'Hotmart', mode: 'manual' },
  kiwify: { label: 'Kiwify', mode: 'api' },
  cakto: { label: 'Cakto', mode: 'api' },
  kirvano: { label: 'Kirvano', mode: 'manual' },
  perfectpay: { label: 'PerfectPay', mode: 'manual' },
  payt: { label: 'Payt', mode: 'manual' },
};
// Gatilhos de venda/recuperação (sem os de assinatura que a Kobly não usa)
export const KIWIFY_TRIGGERS = ['boleto_gerado', 'pix_gerado', 'carrinho_abandonado', 'compra_recusada', 'compra_aprovada', 'compra_reembolsada', 'chargeback', 'subscription_canceled'];
export const CAKTO_EVENTS = ['checkout_abandonment', 'purchase_approved', 'purchase_refused', 'pix_gerado', 'boleto_gerado', 'chargeback', 'refund', 'subscription_canceled'];

async function http(fetchImpl, url, init, label) {
  let res;
  try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) }); }
  catch { throw new AuthError(502, 'platform_unreachable', `${label} não respondeu agora.`); }
  let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401 || res.status === 403) throw new AuthError(400, 'platform_bad_credentials', `${label}: credenciais recusadas. Confira e gere de novo se preciso.`);
  if (!res.ok) throw new AuthError(502, 'platform_error', `${label}: ${(j && (j.message || j.detail || j.error)) || `HTTP ${res.status}`}`);
  return j || {};
}

// ---- Kiwify: public-api.kiwify.com/v1 (OAuth client_credentials + x-kiwify-account-id) ----------
export function createKiwifyApi({ base = 'https://public-api.kiwify.com/v1', fetchImpl = globalThis.fetch } = {}) {
  async function token(c) {
    const r = await http(fetchImpl, `${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret }).toString() }, 'Kiwify');
    if (!r.access_token) throw new AuthError(400, 'platform_bad_credentials', 'Kiwify: credenciais recusadas.');
    return r.access_token;
  }
  const headers = async (c) => ({ Authorization: `Bearer ${await token(c)}`, 'x-kiwify-account-id': c.account_id, 'Content-Type': 'application/json' });
  return {
    async createWebhook(c, { url, secret }) {
      const r = await http(fetchImpl, `${base}/webhooks`, { method: 'POST', headers: await headers(c), body: JSON.stringify({ name: 'Kobly — recuperação', url, products: 'all', triggers: KIWIFY_TRIGGERS, token: secret }) }, 'Kiwify');
      return { remoteId: r.id || null, secret };
    },
    async deleteWebhook(c, id) { await http(fetchImpl, `${base}/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE', headers: await headers(c) }, 'Kiwify'); },
  };
}

// ---- Cakto: api.cakto.com.br/public_api (OAuth client_credentials) -------------------------------
export function createCaktoApi({ base = 'https://api.cakto.com.br/public_api', fetchImpl = globalThis.fetch } = {}) {
  async function token(c) {
    const r = await http(fetchImpl, `${base}/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret }).toString() }, 'Cakto');
    if (!r.access_token) throw new AuthError(400, 'platform_bad_credentials', 'Cakto: credenciais recusadas.');
    return r.access_token;
  }
  return {
    // a Cakto exige a lista de produtos no webhook: entram todos os produtos da conta
    async createWebhook(c, { url }) {
      const auth = { Authorization: `Bearer ${await token(c)}` };
      const p = await http(fetchImpl, `${base}/products/`, { headers: auth }, 'Cakto');
      const products = (Array.isArray(p) ? p : (p.results || p.data || [])).map((x) => x && x.id).filter(Boolean);
      if (!products.length) throw new AuthError(422, 'platform_no_products', 'Cakto: crie ao menos um produto na sua conta antes de conectar.');
      const r = await http(fetchImpl, `${base}/webhook/`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Kobly — recuperação', url, products, events: CAKTO_EVENTS, status: 'active' }) }, 'Cakto');
      const secret = r.fields && r.fields.secret;
      return { remoteId: r.id != null ? String(r.id) : null, secret: secret || null };
    },
    async deleteWebhook(c, id) { await http(fetchImpl, `${base}/webhook/${encodeURIComponent(id)}/`, { method: 'DELETE', headers: { Authorization: `Bearer ${await token(c)}` } }, 'Cakto'); },
  };
}

export function createPlatforms({ pool, secretKey, publicBaseUrl = '', fetchImpl = globalThis.fetch, apis = null }) {
  const remote = apis || { kiwify: createKiwifyApi({ fetchImpl }), cakto: createCaktoApi({ fetchImpl }) };
  const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };
  const urlOf = (token) => `${String(publicBaseUrl).replace(/\/$/, '')}/functions/v1/postback-receiver?token=${token}`;
  const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  async function newToken(orgId, platform, label, { secret = null, hottok = null } = {}) {
    const r = await pool.query(`insert into public.postback_tokens (organization_id, nome, platform, platform_secret, hottok) values ($1,$2,$3,$4,$5) returning id, token`,
      [orgId, label || PLATFORMS[platform].label, platform, secret, hottok]);
    return r.rows[0];
  }
  async function own(orgId, id) {
    if (!UUID.test(String(id || ''))) fail('Conexão inválida.');
    const r = (await pool.query(`select t.*, c.credentials_enc, c.remote_webhook_id from public.postback_tokens t left join public.platform_api_credentials c on c.postback_token_id = t.id
      where t.id = $1 and t.organization_id = $2 and t.platform is not null`, [id, orgId])).rows[0];
    if (!r) throw new AuthError(404, 'not_found', 'Conexão não encontrada.');
    return r;
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar integrações.'); };
    switch (body.action) {
      case 'list': {
        const { rows } = await pool.query(`
          select t.id, t.platform, t.nome as label, t.token, t.ativo, t.created_at, t.last_event_at, t.events_count,
                 (t.platform_secret is not null or t.hottok is not null) as tem_chave, (c.id is not null) as via_api
            from public.postback_tokens t left join public.platform_api_credentials c on c.postback_token_id = t.id
           where t.organization_id = $1 and t.platform is not null and t.ativo order by t.created_at`, [orgId]);
        return { connections: rows.map(({ token, ...r }) => ({ ...r, url: urlOf(token) })) };
      }
      case 'connect_manual': {
        editor();
        const platform = String(body.platform || '');
        if (!PLATFORMS[platform]) fail('Plataforma desconhecida.');
        const secret = clean(body.secret, 300) || null;
        const t = await newToken(orgId, platform, clean(body.label, 60), platform === 'hotmart' ? { hottok: secret } : { secret });
        return { ok: true, id: t.id, url: urlOf(t.token) };
      }
      case 'connect_api': {
        editor();
        if (!secretKey) throw new AuthError(503, 'platforms_unconfigured', 'Indisponível neste ambiente (chave de segurança ausente).');
        const platform = String(body.platform || '');
        if (PLATFORMS[platform] && PLATFORMS[platform].mode !== 'api') fail(`${PLATFORMS[platform].label} se conecta colando a URL no painel dela.`);
        if (!remote[platform]) fail('Plataforma desconhecida.');
        const cred = { client_id: clean(body.client_id), client_secret: clean(body.client_secret, 400), account_id: clean(body.account_id) };
        if (!cred.client_id || !cred.client_secret || (platform === 'kiwify' && !cred.account_id)) fail(platform === 'kiwify' ? 'Informe Client ID, Client Secret e Account ID.' : 'Informe Client ID e Client Secret.');
        const verifier = platform === 'kiwify' ? randomBytes(16).toString('hex') : null;
        const t = await newToken(orgId, platform, clean(body.label, 60), { secret: verifier });
        try {
          const w = await remote[platform].createWebhook(cred, { url: urlOf(t.token), secret: verifier });
          await pool.query(`update public.postback_tokens set platform_secret = $2 where id = $1`, [t.id, w.secret || verifier]);
          await pool.query(`insert into public.platform_api_credentials (organization_id, postback_token_id, platform, credentials_enc, remote_webhook_id) values ($1,$2,$3,$4,$5)`,
            [orgId, t.id, platform, encrypt(JSON.stringify(cred), secretKey), w.remoteId]);
          return { ok: true, id: t.id, url: urlOf(t.token), webhook_created: true };
        } catch (e) {
          await pool.query(`delete from public.postback_tokens where id = $1`, [t.id]).catch(() => {}); // nada fica pela metade
          throw e;
        }
      }
      case 'update_secret': {
        editor();
        const c = await own(orgId, body.id);
        if (c.credentials_enc) fail('Esta conexão foi criada pela API: a chave é da própria plataforma.');
        const secret = clean(body.secret, 300) || null;
        await pool.query(c.platform === 'hotmart' ? `update public.postback_tokens set hottok = $2 where id = $1` : `update public.postback_tokens set platform_secret = $2 where id = $1`, [c.id, secret]);
        return { ok: true };
      }
      case 'disconnect': {
        editor();
        const c = await own(orgId, body.id);
        let remoteRemoved = null;
        if (c.credentials_enc && c.remote_webhook_id && secretKey && remote[c.platform]) {
          try { await remote[c.platform].deleteWebhook(JSON.parse(decrypt(c.credentials_enc, secretKey)), c.remote_webhook_id); remoteRemoved = true; }
          catch { remoteRemoved = false; } // a URL é desativada de qualquer jeito: avisos que chegarem depois são recusados
        }
        await pool.query(`update public.postback_tokens set ativo = false where id = $1`, [c.id]);
        await pool.query(`delete from public.platform_api_credentials where postback_token_id = $1`, [c.id]);
        return { ok: true, remote_removed: remoteRemoved };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
