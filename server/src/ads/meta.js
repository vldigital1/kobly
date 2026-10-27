// Rota POST /functions/v1/meta-ads: campanhas do Facebook/Instagram Ads em tempo real, lado a lado com
// o que a Kobly mediu (leads, compras e vendas recuperadas pelo fluxo) para a mesma campanha.
// Casamento: utm_campaign do lead = nome OU id da campanha (use utm_campaign={{campaign.name}} nos anúncios).
// Marketing API: GET /me/adaccounts e GET /act_{id}/insights?level=campaign (permissão ads_read).
// O token fica cifrado; vai no cabeçalho Authorization, nunca na URL.
// "Conectar com Facebook": oauth_start devolve o link do login (janelinha); o Facebook volta em
// GET /oauth/meta/callback, o token de longa duração fica em meta_ads_oauth e o cliente escolhe as contas.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';
import { createAdsManager, MANAGER_ACTIONS } from './manager.js';

const PRESETS = { today: 0, yesterday: 1, last_7d: 7, last_14d: 14, last_30d: 30, this_month: 31 };
const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const LEAD = ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped'];
const CACHE_MS = 60_000;
const OAUTH_SCOPES = 'ads_read,ads_management,business_management';
const STATE_TTL_MS = 15 * 60_000;

// quanto falta para o Facebook liberar de novo (cabeçalhos de uso que ele manda junto com o erro de limite)
export function waitMinutes(headers) {
  const get = (k) => { try { return headers && headers.get ? headers.get(k) : null; } catch { return null; } };
  let min = 0;
  try {
    const buc = JSON.parse(get('x-business-use-case-usage') || '{}');
    for (const list of Object.values(buc)) for (const u of list || []) min = Math.max(min, Number(u.estimated_time_to_regain_access) || 0);
  } catch { /* cabeçalho estranho */ }
  try {
    const acc = JSON.parse(get('x-ad-account-usage') || '{}');
    if (acc.reset_time_duration) min = Math.max(min, Math.ceil(Number(acc.reset_time_duration) / 60));
  } catch { /* cabeçalho estranho */ }
  return min;
}

// valor da primeira ação encontrada na ordem de preferência (a Meta repete a compra em vários tipos)
export function actionValue(list, types) {
  for (const t of types) { const a = (list || []).find((x) => x.action_type === t); if (a) return Number(a.value) || 0; }
  return 0;
}
export function normalizeInsight(r) {
  const spend = Number(r.spend) || 0;
  const compras = actionValue(r.actions, PURCHASE), receita = actionValue(r.action_values, PURCHASE);
  return {
    campaign_id: r.campaign_id, campaign_name: r.campaign_name || '', spend, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0,
    reach: Number(r.reach) || 0, ctr: Number(r.ctr) || 0, cpc: Number(r.cpc) || 0, currency: r.account_currency || null,
    leads_meta: actionValue(r.actions, LEAD), compras_meta: compras, receita_meta: receita,
    roas_meta: spend > 0 ? receita / spend : null,
  };
}

export function createMetaAds({ pool, secretKey, fetchImpl = globalThis.fetch, graphBase = 'https://graph.facebook.com/v26.0', now = () => new Date(),
  appId = '', appSecret = '', publicBaseUrl = '', siteUrl = '', configId = '' }) {
  const cache = new Map();
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'ads_unconfigured', 'Indisponível neste ambiente (chave de segurança ausente).'); };
  const fail = (msg) => { throw new AuthError(422, 'validation_failed', msg); };

  // GET com os parâmetros na URL; POST (alterar campanha) com o formulário no corpo
  async function graph(token, path, query = {}, method = 'GET') {
    const url = new URL(graphBase.replace(/\/$/, '') + path);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let body;
    if (method === 'POST') { body = new URLSearchParams(query).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res;
    try { res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(20000) }); }
    catch { throw new AuthError(502, 'meta_unreachable', 'O Facebook não respondeu agora.'); }
    const j = await res.json().catch(() => null);
    if (!res.ok || (j && j.error)) {
      const e = (j && j.error) || {};
      if (e.code === 190) throw new AuthError(400, 'meta_bad_token', 'O token do Facebook expirou ou foi revogado. Gere outro (usuário do sistema, permissão ads_read).');
      if ([4, 17, 32, 613, 80000, 80004].includes(e.code)) {
        const min = waitMinutes(res.headers);
        const quando = min ? `Tente de novo em uns ${min} minuto${min > 1 ? 's' : ''}.` : 'Tente de novo em alguns minutos.';
        const extra = e.error_user_msg ? ` (${e.error_user_msg})` : '';
        throw new AuthError(429, 'meta_rate_limited', `O Facebook limitou as consultas desta conta de anúncios. ${quando}${extra} Isso diminui quando o app da Kobly for aprovado na análise do Facebook.`);
      }
      if (e.code === 10 || e.code === 200 || e.code === 100) throw new AuthError(400, 'meta_permission', `Facebook: ${e.message || 'sem permissão para esta conta de anúncios (precisa de ads_read).'}`);
      throw new AuthError(502, 'meta_error', `Facebook: ${e.message || `HTTP ${res.status}`}`);
    }
    return j || {};
  }
  const own = async (orgId, id) => {
    const r = (await pool.query(`select * from public.meta_ads_accounts where id::text = $1 and organization_id = $2`, [String(id || ''), orgId])).rows[0];
    if (!r) throw new AuthError(404, 'not_found', 'Conta de anúncios não encontrada.');
    return r;
  };
  const manager = createAdsManager({ pool, graph, own, tokenOf: (a) => { needKey(); return decrypt(a.token_enc, secretKey); }, now });
  const cleanToken = (t) => { const s = String(t || '').trim(); if (s.length < 20) fail('Cole o token de acesso do Facebook (permissão ads_read).'); return s; };
  const cleanAct = (v) => { const s = String(v || '').replace(/^act_/, '').trim(); if (!/^[0-9]{5,25}$/.test(s)) fail('Conta de anúncios inválida.'); return s; };

  async function saveAccount(orgId, token, act) {
    const a = await graph(token, `/act_${act}`, { fields: 'name,currency,account_status' });
    const r = await pool.query(`insert into public.meta_ads_accounts (organization_id, ad_account_id, name, currency, token_enc, token_hint, status, last_error)
      values ($1,$2,$3,$4,$5,$6,'connected',null)
      on conflict (organization_id, ad_account_id) do update set name = excluded.name, currency = excluded.currency, token_enc = excluded.token_enc, token_hint = excluded.token_hint, status = 'connected', last_error = null
      returning id, ad_account_id, name, currency, token_hint, status`, [orgId, act, a.name || '', a.currency || null, encrypt(token, secretKey), `…${token.slice(-4)}`]);
    return r.rows[0];
  }

  // Login com Facebook: o "state" leva a empresa e a validade, assinado com a chave do serviço
  const oauthOn = () => !!(appId && appSecret && publicBaseUrl && secretKey);
  const redirectUri = () => `${publicBaseUrl}/oauth/meta/callback`;
  const sign = (p) => createHmac('sha256', secretKey).update(`meta-oauth:${p}`).digest('base64url');
  function makeState(orgId) {
    const p = Buffer.from(JSON.stringify({ o: orgId, e: Date.now() + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
    return `${p}.${sign(p)}`;
  }
  function readState(state) {
    const [p, sig] = String(state || '').split('.');
    if (!p || !sig || !secretKey) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(p));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try { const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return j.e > Date.now() && typeof j.o === 'string' ? j : null; } catch { return null; }
  }
  const pendingToken = async (orgId) => {
    const r = (await pool.query(`select token_enc, user_name from public.meta_ads_oauth where organization_id = $1 and expires_at > now()`, [orgId])).rows[0];
    if (!r) throw new AuthError(410, 'meta_oauth_expired', 'O login com o Facebook expirou. Clique em "Conectar com Facebook" de novo.');
    return { token: decrypt(r.token_enc, secretKey), userName: r.user_name };
  };
  const listAccounts = async (token) => {
    const j = await graph(token, '/me/adaccounts', { fields: 'name,account_id,currency,account_status', limit: '100' });
    return (j.data || []).map((a) => ({ ad_account_id: a.account_id, name: a.name, currency: a.currency, active: a.account_status === 1 }));
  };

  // GET /oauth/meta/callback — o Facebook volta aqui; a página avisa a janela da Kobly e fecha sozinha
  async function oauthCallback(q) {
    const page = (ok, msg) => {
      const origin = JSON.stringify(siteUrl || '*');
      const data = JSON.stringify({ kobly: 'meta-oauth', ok, message: msg });
      return `<!doctype html><meta charset="utf-8"><title>Kobly</title><body style="font-family:system-ui;background:#0d0d0d;color:#f6f6f6;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:340px;padding:16px"><div style="width:48px;height:48px;border-radius:12px;background:#ff6201;margin:0 auto 16px"></div><p>${msg}</p><p style="opacity:.6;font-size:13px">Pode fechar esta janela.</p></div>
<script>try{window.opener&&window.opener.postMessage(${data},${origin})}catch(e){}setTimeout(function(){window.close()},${ok ? 800 : 5000})</script></body>`;
    };
    const st = readState(q.state);
    if (!st) return page(false, 'Este link de login expirou. Volte para a Kobly e clique em "Conectar com Facebook" de novo.');
    if (q.error || !q.code) return page(false, 'Você cancelou o login do Facebook. Nada foi conectado.');
    try {
      const short = await graph(null, '/oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri(), code: String(q.code) });
      const long = await graph(null, '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }).catch(() => ({}));
      const token = long.access_token || short.access_token;
      if (!token) throw new Error('sem token');
      const me = await graph(token, '/me', { fields: 'name' }).catch(() => ({}));
      await pool.query(`insert into public.meta_ads_oauth (organization_id, token_enc, user_name, expires_at) values ($1,$2,$3, now() + interval '30 minutes')
        on conflict (organization_id) do update set token_enc = excluded.token_enc, user_name = excluded.user_name, expires_at = excluded.expires_at, created_at = now()`,
        [st.o, encrypt(token, secretKey), me.name || null]);
      return page(true, 'Facebook conectado! Voltando para a Kobly…');
    } catch {
      return page(false, 'O Facebook não confirmou o login. Tente de novo em alguns instantes.');
    }
  }

  // Kobly no mesmo período: leads por utm_campaign (nome ou id), compras do checkout e vendas do fluxo
  async function koblyByCampaign(orgId, days) {
    const since = new Date(now()); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days === 0 ? 0 : days));
    const { rows } = await pool.query(`
      select lower(l.utm->>'utm_campaign') as chave, count(distinct l.id)::int as leads,
             count(distinct e.lead_id) filter (where e.tipo_evento = 'Compra Aprovada')::int as aprovadas,
             coalesce(sum(e.valor_produto) filter (where e.tipo_evento = 'Compra Aprovada'), 0)::float as receita_checkout,
             (select count(*)::int from public.flow_sales s where s.organization_id = $1 and s.created_at >= $2 and s.lead_id = any(array_agg(l.id))) as recuperadas,
             (select coalesce(sum(s.amount), 0)::float from public.flow_sales s where s.organization_id = $1 and s.created_at >= $2 and s.lead_id = any(array_agg(l.id))) as receita_recuperada
        from public.leads l left join public.webhook_events e on e.lead_id = l.id and e.organization_id = $1 and e.created_at >= $2
       where l.organization_id = $1 and l.utm->>'utm_campaign' is not null and (l.created_at >= $2 or e.id is not null)
       group by 1`, [orgId, since.toISOString()]);
    return new Map(rows.map((r) => [r.chave, r]));
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar contas de anúncios.'); };
    switch (body.action) {
      case 'discover': { // lista as contas de anúncios que o token enxerga (o token ainda não é salvo)
        editor();
        return { accounts: await listAccounts(cleanToken(body.access_token)) };
      }
      case 'oauth_status': return { enabled: oauthOn() };
      case 'oauth_start': {
        editor();
        if (!oauthOn()) throw new AuthError(503, 'meta_oauth_off', 'O login com Facebook ainda não foi ativado pela Kobly. Use a opção de colar o token.');
        const ver = (/\/(v[0-9.]+)\/?$/.exec(graphBase) || [null, 'v26.0'])[1];
        const u = new URL(`https://www.facebook.com/${ver}/dialog/oauth`);
        u.searchParams.set('client_id', appId); u.searchParams.set('redirect_uri', redirectUri());
        u.searchParams.set('state', makeState(orgId)); u.searchParams.set('response_type', 'code');
        // app do tipo empresa (Login do Facebook para Empresas): as permissões vêm da configuração criada no painel
        if (configId) u.searchParams.set('config_id', configId); else u.searchParams.set('scope', OAUTH_SCOPES);
        return { url: u.toString() };
      }
      case 'oauth_accounts': {
        editor();
        const p = await pendingToken(orgId);
        return { user_name: p.userName, accounts: await listAccounts(p.token) };
      }
      case 'oauth_connect': {
        editor(); needKey();
        const ids = [...new Set((Array.isArray(body.ad_account_ids) ? body.ad_account_ids : []).map(cleanAct))];
        if (!ids.length) fail('Escolha pelo menos uma conta de anúncios.');
        if (ids.length > 25) fail('Escolha até 25 contas de cada vez.');
        const p = await pendingToken(orgId);
        const accounts = [];
        for (const act of ids) accounts.push(await saveAccount(orgId, p.token, act));
        await pool.query(`delete from public.meta_ads_oauth where organization_id = $1`, [orgId]);
        return { accounts };
      }
      case 'connect': {
        editor(); needKey();
        const token = cleanToken(body.access_token), act = cleanAct(body.ad_account_id);
        return { account: await saveAccount(orgId, token, act) };
      }
      case 'accounts': return { accounts: (await pool.query(`select id, ad_account_id, name, currency, token_hint, status, last_error, last_sync_at from public.meta_ads_accounts where organization_id = $1 order by created_at`, [orgId])).rows };
      case 'disconnect': {
        editor();
        const a = await own(orgId, body.id);
        await pool.query(`delete from public.meta_ads_accounts where id = $1`, [a.id]);
        return { ok: true };
      }
      case 'insights': {
        needKey();
        const a = await own(orgId, body.id);
        const preset = Object.prototype.hasOwnProperty.call(PRESETS, body.date_preset) ? body.date_preset : 'today';
        const key = `${a.id}:${preset}`;
        const hit = cache.get(key);
        let campaigns, fetchedAt;
        if (hit && Date.now() - hit.at < CACHE_MS && !body.force) ({ campaigns, fetchedAt } = hit);
        else {
          try {
            const j = await graph(decrypt(a.token_enc, secretKey), `/act_${a.ad_account_id}/insights`, {
              level: 'campaign', date_preset: preset, limit: '200',
              fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,reach,actions,action_values,purchase_roas,account_currency',
            });
            campaigns = (j.data || []).map(normalizeInsight);
            fetchedAt = now().toISOString();
            cache.set(key, { at: Date.now(), campaigns, fetchedAt });
            await pool.query(`update public.meta_ads_accounts set status = 'connected', last_error = null, last_sync_at = now() where id = $1`, [a.id]);
          } catch (e) {
            if (e.code === 'meta_bad_token' || e.code === 'meta_permission') await pool.query(`update public.meta_ads_accounts set status = 'error', last_error = $2 where id = $1`, [a.id, e.message]).catch(() => {});
            throw e;
          }
        }
        const kobly = await koblyByCampaign(orgId, PRESETS[preset]);
        const rows = campaigns.map((c) => {
          const k = kobly.get(String(c.campaign_name).toLowerCase()) || kobly.get(String(c.campaign_id)) || null;
          const receitaKobly = k ? k.receita_checkout + k.receita_recuperada : 0;
          return { ...c, kobly: k ? { leads: k.leads, aprovadas: k.aprovadas, recuperadas: k.recuperadas, receita_checkout: k.receita_checkout, receita_recuperada: k.receita_recuperada } : null,
            roas_kobly: c.spend > 0 && k ? receitaKobly / c.spend : null };
        }).sort((x, y) => y.spend - x.spend);
        const tot = rows.reduce((t, r) => ({ spend: t.spend + r.spend, receita_meta: t.receita_meta + r.receita_meta, compras_meta: t.compras_meta + r.compras_meta,
          recuperadas: t.recuperadas + (r.kobly ? r.kobly.recuperadas : 0), receita_recuperada: t.receita_recuperada + (r.kobly ? r.kobly.receita_recuperada : 0) }),
          { spend: 0, receita_meta: 0, compras_meta: 0, recuperadas: 0, receita_recuperada: 0 });
        return { date_preset: preset, fetched_at: fetchedAt, currency: a.currency, campaigns: rows, totals: tot };
      }
      default:
        if (MANAGER_ACTIONS.has(body.action)) return manager.handle(ctx, body);
        throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle, oauthCallback };
}
