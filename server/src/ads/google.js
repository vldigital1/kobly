// Rota POST /functions/v1/google-ads: Google Ads com as vendas que a Kobly rastreou — mesmo formato do
// gerenciador do Facebook (dashboard, contas, campanhas, grupos de anúncios e anúncios; ligar/pausar e orçamento).
// "Conectar com Google": oauth_start → accounts.google.com → GET /oauth/google/callback guarda o refresh token
// (cifrado) por 30 min em google_ads_oauth até o cliente escolher as contas. Contas dentro de uma MCC usam o
// login-customer-id da MCC. A API exige o developer token da Kobly (GOOGLE_ADS_DEVELOPER_TOKEN).
// Rastreio pela UTM com os ValueTrack do Google: utm_campaign={campaignid}, utm_medium={adgroupid}, utm_content={creative}.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';
import { adsSettings, attribute, koblyFacts, periodOf, profitOf, sourceOk, utmKeys } from './manager.js';

const SCOPE = 'https://www.googleapis.com/auth/adwords';
const STATE_TTL_MS = 15 * 60_000;
const CACHE_MS = 60_000;
const DURING = { today: 'TODAY', yesterday: 'YESTERDAY', last_7d: 'LAST_7_DAYS', last_14d: 'LAST_14_DAYS', last_30d: 'LAST_30_DAYS', this_month: 'THIS_MONTH', last_month: 'LAST_MONTH' };
const PRESETS = new Set([...Object.keys(DURING), 'maximum']);
const CID = /^[0-9]{6,12}$/;
const OBJ = /^[0-9]{1,25}$/;
const METRICS = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.average_cpm, metrics.conversions, metrics.conversions_value';
const LEVELS = {
  campaign: {
    from: 'campaign', id: (r) => r.campaign.id, utm: 'utm_campaign', where: "campaign.status != 'REMOVED'",
    attrs: 'campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, campaign_budget.explicitly_shared',
    map: (r) => ({ id: r.campaign.id, name: r.campaign.name || `Campanha ${r.campaign.id}`, raw_status: r.campaign.status, objective: r.campaign.advertisingChannelType || null,
      daily_budget: r.campaignBudget && r.campaignBudget.amountMicros != null ? Number(r.campaignBudget.amountMicros) : null, shared_budget: !!(r.campaignBudget && r.campaignBudget.explicitlyShared),
      campaign_id: r.campaign.id, campaign_name: r.campaign.name }),
  },
  adset: {
    from: 'ad_group', id: (r) => r.adGroup.id, utm: 'utm_medium', where: "ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    attrs: 'ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status',
    map: (r) => ({ id: r.adGroup.id, name: r.adGroup.name || `Grupo ${r.adGroup.id}`, raw_status: r.adGroup.status, parent_paused: r.campaign.status === 'PAUSED',
      campaign_id: r.campaign.id, campaign_name: r.campaign.name }),
  },
  ad: {
    from: 'ad_group_ad', id: (r) => r.adGroupAd.ad.id, utm: 'utm_content', where: "ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
    attrs: 'ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status',
    map: (r) => ({ id: r.adGroupAd.ad.id, name: r.adGroupAd.ad.name || `${String(r.adGroupAd.ad.type || 'Anúncio').replace(/_/g, ' ').toLowerCase()} ${r.adGroupAd.ad.id}`,
      raw_status: r.adGroupAd.status, parent_paused: r.adGroup.status === 'PAUSED' || r.campaign.status === 'PAUSED',
      adset_id: r.adGroup.id, adset_name: r.adGroup.name, campaign_id: r.campaign.id, campaign_name: r.campaign.name }),
  },
};

// métricas do Google no mesmo formato das do Facebook (micros → moeda; CTR em %)
export function googleMetrics(m) {
  const x = m || {};
  const spend = (Number(x.costMicros) || 0) / 1e6, impressions = Number(x.impressions) || 0, clicks = Number(x.clicks) || 0;
  return { spend, impressions, reach: 0, clicks, ctr: impressions ? clicks / impressions * 100 : 0, cpc: clicks ? spend / clicks : 0, cpm: impressions ? spend / impressions * 1000 : 0,
    compras_meta: Number(x.conversions) || 0, receita_meta: Number(x.conversionsValue) || 0, leads_meta: 0, conversas: 0 };
}
const sumMetrics = (list) => {
  const t = list.reduce((a, m) => { for (const k of Object.keys(a)) a[k] += m[k] || 0; return a; }, googleMetrics(null));
  return { ...t, ctr: t.impressions ? t.clicks / t.impressions * 100 : 0, cpc: t.clicks ? t.spend / t.clicks : 0, cpm: t.impressions ? t.spend / t.impressions * 1000 : 0 };
};
const statusOf = (raw, parentPaused) => (raw === 'ENABLED' ? (parentPaused ? 'CAMPAIGN_PAUSED' : 'ACTIVE') : raw === 'PAUSED' ? 'PAUSED' : raw || 'UNKNOWN');

export function createGoogleAds({ pool, secretKey, fetchImpl = globalThis.fetch, clientId = '', clientSecret = '', developerToken = '', loginCustomerId = '',
  apiVersion = 'v26', publicBaseUrl = '', siteUrl = '', now = () => new Date(),
  oauthBase = 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl = 'https://oauth2.googleapis.com/token', apiBase = 'https://googleads.googleapis.com' }) {
  const cache = new Map();
  const tokens = new Map(); // hash do refresh token → { at, exp }
  const fail = (msg) => { throw new AuthError(422, 'validation_failed', msg); };
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'ads_unconfigured', 'Indisponível neste ambiente (chave de segurança ausente).'); };
  const enabled = () => !!(clientId && clientSecret && developerToken && publicBaseUrl && secretKey);
  const needOn = () => { if (!enabled()) throw new AuthError(503, 'google_ads_off', 'O Google Ads ainda não foi ativado pela Kobly (faltam as chaves do Google no servidor).'); };
  const redirectUri = () => `${publicBaseUrl}/oauth/google/callback`;
  async function cached(key, force, fn) {
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    const v = await fn(); cache.set(key, { at: Date.now(), v }); return v;
  }
  const dropCache = (id) => { for (const k of cache.keys()) if (k.startsWith(`${id}:`)) cache.delete(k); };

  async function postForm(url, form) {
    let res;
    try { res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20000) }); }
    catch { throw new AuthError(502, 'google_unreachable', 'O Google não respondeu agora.'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j.error === 'invalid_grant') throw new AuthError(400, 'google_bad_token', 'O acesso ao Google Ads expirou ou foi removido. Conecte a conta de novo.');
      throw new AuthError(502, 'google_error', `Google: ${j.error_description || j.error || `HTTP ${res.status}`}`);
    }
    return j;
  }
  async function accessToken(refresh) {
    const k = createHash('sha256').update(refresh).digest('hex');
    const hit = tokens.get(k);
    if (hit && hit.exp > Date.now() + 60_000) return hit.at;
    const j = await postForm(tokenUrl, { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: clientSecret });
    tokens.set(k, { at: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
    return j.access_token;
  }
  async function api(at, path, { body, login } = {}) {
    let res;
    const headers = { Authorization: `Bearer ${at}`, 'developer-token': developerToken, 'Content-Type': 'application/json' };
    const lid = login || loginCustomerId;
    if (lid) headers['login-customer-id'] = String(lid).replace(/-/g, '');
    try { res = await fetchImpl(`${apiBase}/${apiVersion}${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); }
    catch { throw new AuthError(502, 'google_unreachable', 'O Google Ads não respondeu agora.'); }
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (j && j.error) || {};
      const det = ((e.details || []).find((d) => d.errors) || {}).errors || [];
      const code = det[0] && det[0].errorCode ? Object.values(det[0].errorCode)[0] : '';
      const msg = (det[0] && det[0].message) || e.message || `HTTP ${res.status}`;
      if (res.status === 401) throw new AuthError(400, 'google_bad_token', 'O acesso ao Google Ads expirou ou foi removido. Conecte a conta de novo.');
      if (code === 'DEVELOPER_TOKEN_NOT_APPROVED' || code === 'DEVELOPER_TOKEN_PROHIBITED') throw new AuthError(400, 'google_dev_token', 'O token de desenvolvedor da Kobly no Google ainda está em modo de teste: ele só acessa contas de teste até o Google aprovar o acesso básico.');
      if (code === 'USER_PERMISSION_DENIED' || code === 'CUSTOMER_NOT_ENABLED' || res.status === 403) throw new AuthError(400, 'google_permission', `Google Ads: ${msg}`);
      if (res.status === 429 || code === 'RESOURCE_EXHAUSTED') throw new AuthError(429, 'google_rate_limited', 'O Google limitou as consultas por alguns minutos.');
      throw new AuthError(502, 'google_error', `Google Ads: ${msg}`);
    }
    return j || {};
  }
  async function search(at, cid, query, login) {
    const rows = [];
    let pageToken;
    for (let i = 0; i < 10; i++) {
      const j = await api(at, `/customers/${cid}/googleAds:search`, { body: { query, ...(pageToken ? { pageToken } : {}) }, login });
      rows.push(...(j.results || []));
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
    return rows;
  }

  // ---- login com Google ----
  const sign = (p) => createHmac('sha256', secretKey).update(`google-oauth:${p}`).digest('base64url');
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
  async function oauthCallback(q) {
    const page = (ok, msg) => {
      const data = JSON.stringify({ kobly: 'google-oauth', ok, message: msg });
      return `<!doctype html><meta charset="utf-8"><title>Kobly</title><body style="font-family:system-ui;background:#0d0d0d;color:#f6f6f6;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:340px;padding:16px"><div style="width:48px;height:48px;border-radius:12px;background:#ff6201;margin:0 auto 16px"></div><p>${msg}</p><p style="opacity:.6;font-size:13px">Pode fechar esta janela.</p></div>
<script>try{window.opener&&window.opener.postMessage(${data},${JSON.stringify(siteUrl || '*')})}catch(e){}setTimeout(function(){window.close()},${ok ? 800 : 5000})</script></body>`;
    };
    const st = readState(q.state);
    if (!st) return page(false, 'Este link de login expirou. Volte para a Kobly e clique em "Conectar com Google" de novo.');
    if (q.error || !q.code) return page(false, 'Você cancelou o login do Google. Nada foi conectado.');
    if (!String(q.scope || SCOPE).includes(SCOPE)) return page(false, 'Para conectar, marque a permissão do Google Ads na tela do Google e tente de novo.');
    try {
      const j = await postForm(tokenUrl, { grant_type: 'authorization_code', code: String(q.code), client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri() });
      if (!j.refresh_token) return page(false, 'O Google não liberou o acesso permanente. Remova a Kobly em myaccount.google.com/permissions e conecte de novo.');
      await pool.query(`insert into public.google_ads_oauth (organization_id, token_enc, expires_at) values ($1,$2, now() + interval '30 minutes')
        on conflict (organization_id) do update set token_enc = excluded.token_enc, expires_at = excluded.expires_at, created_at = now()`, [st.o, encrypt(j.refresh_token, secretKey)]);
      return page(true, 'Google conectado! Voltando para a Kobly…');
    } catch { return page(false, 'O Google não confirmou o login. Tente de novo em alguns instantes.'); }
  }
  const pendingToken = async (orgId) => {
    const r = (await pool.query(`select token_enc from public.google_ads_oauth where organization_id = $1 and expires_at > now()`, [orgId])).rows[0];
    if (!r) throw new AuthError(410, 'google_oauth_expired', 'O login com o Google expirou. Clique em "Conectar com Google" de novo.');
    return decrypt(r.token_enc, secretKey);
  };
  // contas que o login enxerga: as diretas e, nas MCCs, as contas de cliente (com o login-customer-id da MCC)
  async function discover(refresh) {
    const at = await accessToken(refresh);
    const j = await api(at, '/customers:listAccessibleCustomers', {});
    const ids = (j.resourceNames || []).map((r) => r.split('/')[1]).filter((x) => CID.test(x)).slice(0, 30);
    const out = new Map();
    for (const id of ids) {
      try {
        const [c] = await search(at, id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.test_account FROM customer LIMIT 1', id);
        if (!c) continue;
        if (!c.customer.manager) { out.set(id, { customer_id: id, name: c.customer.descriptiveName || id, currency: c.customer.currencyCode, login_customer_id: null, test: !!c.customer.testAccount }); continue; }
        const kids = await search(at, id, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.test_account FROM customer_client WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED'", id);
        for (const k of kids) {
          const cc = k.customerClient;
          if (cc.manager || out.has(String(cc.id))) continue;
          out.set(String(cc.id), { customer_id: String(cc.id), name: cc.descriptiveName || String(cc.id), currency: cc.currencyCode, login_customer_id: id, test: !!cc.testAccount, via: c.customer.descriptiveName || id });
        }
      } catch (e) { if (e.code === 'google_dev_token' || e.code === 'google_bad_token') throw e; /* conta desativada ou sem acesso: pula */ }
    }
    return [...out.values()];
  }

  // ---- contas salvas ----
  const own = async (orgId, id) => {
    const r = (await pool.query(`select * from public.google_ads_accounts where id::text = $1 and organization_id = $2`, [String(id || ''), orgId])).rows[0];
    if (!r) throw new AuthError(404, 'not_found', 'Conta do Google Ads não encontrada.');
    return r;
  };
  async function accountsOf(orgId, id) {
    if (id && id !== 'all') return [await own(orgId, id)];
    return (await pool.query(`select * from public.google_ads_accounts where organization_id = $1 order by created_at`, [orgId])).rows;
  }
  const atOf = (a) => { needKey(); return accessToken(decrypt(a.token_enc, secretKey)); };
  const markErr = (a, e) => { if (e && ['google_bad_token', 'google_permission', 'google_dev_token'].includes(e.code)) pool.query(`update public.google_ads_accounts set status = 'error', last_error = $2 where id = $1`, [a.id, e.message]).catch(() => {}); };
  const markOk = (a) => pool.query(`update public.google_ads_accounts set status = 'connected', last_error = null, last_sync_at = now() where id = $1 and (status <> 'connected' or last_sync_at is null or last_sync_at < now() - interval '1 minute')`, [a.id]).catch(() => {});
  function dateClause(preset) {
    if (DURING[preset]) return `segments.date DURING ${DURING[preset]}`;
    const d = now(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `segments.date BETWEEN '2015-01-01' AND '${today}'`;
  }

  async function listLevel(a, level, preset, force) {
    const L = LEVELS[level];
    return cached(`${a.id}:${level}:${preset}`, force, async () => {
      try {
        const at = await atOf(a);
        const [attrs, mets] = await Promise.all([
          search(at, a.customer_id, `SELECT ${L.attrs} FROM ${L.from} WHERE ${L.where}`, a.login_customer_id),
          search(at, a.customer_id, `SELECT ${L.attrs.split(',')[0]}, ${METRICS} FROM ${L.from} WHERE ${L.where} AND ${dateClause(preset)}`, a.login_customer_id),
        ]);
        const byId = new Map();
        for (const r of mets) { const id = String(L.id(r)); byId.set(id, [...(byId.get(id) || []), googleMetrics(r.metrics)]); }
        markOk(a);
        return attrs.map((r) => {
          const b = L.map(r);
          const st = statusOf(b.raw_status, b.parent_paused);
          return { ...b, id: String(b.id), campaign_id: b.campaign_id && String(b.campaign_id), adset_id: b.adset_id && String(b.adset_id),
            status: b.raw_status === 'ENABLED' ? 'ACTIVE' : 'PAUSED', effective_status: st, lifetime_budget: null,
            account_id: a.id, account_name: a.name, currency: a.currency, ...sumMetrics(byId.get(String(b.id)) || []) };
        });
      } catch (e) { markErr(a, e); throw e; }
    });
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar campanhas.'); };
    const preset = PRESETS.has(body.date_preset) ? body.date_preset : 'today';
    switch (body.action) {
      case 'oauth_status': return { enabled: enabled() };
      case 'oauth_start': {
        editor(); needOn();
        const u = new URL(oauthBase);
        for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: makeState(orgId) })) u.searchParams.set(k, v);
        return { url: u.toString() };
      }
      case 'oauth_accounts': { editor(); needOn(); return { accounts: await discover(await pendingToken(orgId)) }; }
      case 'oauth_connect': {
        editor(); needOn();
        const want = [...new Set((Array.isArray(body.customer_ids) ? body.customer_ids : []).map((x) => String(x).replace(/-/g, '')))];
        if (!want.length) fail('Escolha pelo menos uma conta do Google Ads.');
        if (want.length > 25) fail('Escolha até 25 contas de cada vez.');
        const refresh = await pendingToken(orgId);
        const found = new Map((await discover(refresh)).map((c) => [c.customer_id, c])); // só contas que o login realmente enxerga
        const accounts = [];
        for (const id of want) {
          const c = found.get(id);
          if (!c) fail(`A conta ${id} não está acessível por este login do Google.`);
          const r = await pool.query(`insert into public.google_ads_accounts (organization_id, customer_id, login_customer_id, name, currency, token_enc, status, last_error)
              values ($1,$2,$3,$4,$5,$6,'connected',null)
            on conflict (organization_id, customer_id) do update set login_customer_id = excluded.login_customer_id, name = excluded.name, currency = excluded.currency,
              token_enc = excluded.token_enc, status = 'connected', last_error = null
            returning id, customer_id, name, currency, status`, [orgId, id, c.login_customer_id, c.name, c.currency || null, encrypt(refresh, secretKey)]);
          accounts.push(r.rows[0]);
        }
        await pool.query(`delete from public.google_ads_oauth where organization_id = $1`, [orgId]);
        return { accounts };
      }
      case 'accounts': return { enabled: enabled(), accounts: (await pool.query(`select id, customer_id, login_customer_id, name, currency, status, last_error, last_sync_at from public.google_ads_accounts where organization_id = $1 order by created_at`, [orgId])).rows };
      case 'disconnect': {
        editor();
        const a = await own(orgId, body.id);
        await pool.query(`delete from public.google_ads_accounts where id = $1`, [a.id]);
        dropCache(a.id);
        return { ok: true };
      }
      case 'entities': {
        const level = LEVELS[body.level] ? body.level : 'campaign';
        const accs = await accountsOf(orgId, body.id);
        const items = (await Promise.all(accs.map((a) => listLevel(a, level, preset, !!body.force)))).flat();
        const att = attribute(items, await koblyFacts(pool, orgId, periodOf(preset, now())), LEVELS[level].utm, 'google');
        const s = await adsSettings(pool, orgId);
        return { date_preset: preset, fetched_at: now().toISOString(), level,
          items: items.map((it) => { const k = att.get(it.id); return { ...it, kobly: k, ...profitOf({ faturamento: k.faturamento, gasto: it.spend, vendas: k.vendas, leads: k.leads, conversas: 0 }, s), budget_unit: 1e6 }; }) };
      }
      case 'accounts_overview': {
        const accs = await accountsOf(orgId, 'all');
        const facts = await koblyFacts(pool, orgId, periodOf(preset, now()));
        const s = await adsSettings(pool, orgId);
        const out = [];
        for (const a of accs) {
          try {
            const camps = await listLevel(a, 'campaign', preset, !!body.force);
            const att = attribute(camps, facts, 'utm_campaign', 'google');
            const tot = [...att.values()].reduce((t, k) => ({ vendas: t.vendas + k.vendas, faturamento: t.faturamento + k.faturamento, leads: t.leads + k.leads }), { vendas: 0, faturamento: 0, leads: 0 });
            const m = sumMetrics(camps);
            out.push({ id: a.id, ad_account_id: a.customer_id.replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3'), name: a.name, currency: a.currency, ativa: true,
              campanhas_ativas: camps.filter((c) => c.effective_status === 'ACTIVE').length,
              ...m, ...profitOf({ faturamento: tot.faturamento, gasto: m.spend, vendas: tot.vendas, leads: tot.leads, conversas: 0 }, s), erro: null });
          } catch (e) { out.push({ id: a.id, ad_account_id: a.customer_id, name: a.name, currency: a.currency, erro: e.message }); }
        }
        return { date_preset: preset, fetched_at: now().toISOString(), accounts: out };
      }
      case 'dashboard': {
        const accs = await accountsOf(orgId, body.id || 'all');
        const facts = await koblyFacts(pool, orgId, periodOf(preset, now()));
        const s = await adsSettings(pool, orgId);
        const porDia = new Map(), dias = [], camps = [];
        for (const a of accs) {
          const rows = await cached(`${a.id}:daily:${preset}`, !!body.force, async () => {
            try { return await search(await atOf(a), a.customer_id, `SELECT segments.date, ${METRICS} FROM customer WHERE ${dateClause(preset)}`, a.login_customer_id); }
            catch (e) { markErr(a, e); throw e; }
          });
          for (const r of rows) {
            const m = googleMetrics(r.metrics); dias.push(m);
            const dia = r.segments.date;
            const x = porDia.get(dia) || { dia, gasto: 0, vendas_meta: 0, faturamento_meta: 0, vendas: 0, faturamento: 0 };
            x.gasto += m.spend; x.vendas_meta += m.compras_meta; x.faturamento_meta += m.receita_meta;
            porDia.set(dia, x);
          }
          camps.push(...await listLevel(a, 'campaign', preset, !!body.force));
        }
        const meta = sumMetrics(dias);
        const att = attribute(camps, facts, 'utm_campaign', 'google');
        let vendas = 0, faturamento = 0, leads = 0, recuperadas = 0, receitaRec = 0;
        for (const k of att.values()) { vendas += k.vendas; faturamento += k.faturamento; leads += k.leads; recuperadas += k.recuperadas; receitaRec += k.receita_recuperada; }
        const keys = new Set(camps.flatMap((c) => [String(c.id), c.name.trim().toLowerCase()]));
        for (const f of facts) {
          if (!f.venda_em || !sourceOk(f.utm_source, 'google') || !utmKeys(f.utm_campaign).some((k) => keys.has(k))) continue;
          const d = new Date(f.venda_em); const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const x = porDia.get(dia) || { dia, gasto: 0, vendas_meta: 0, faturamento_meta: 0, vendas: 0, faturamento: 0 };
          x.vendas += f.aprovadas + f.recuperadas; x.faturamento += f.receita_checkout + f.receita_recuperada;
          porDia.set(dia, x);
        }
        return {
          date_preset: preset, fetched_at: now().toISOString(), currency: (accs[0] && accs[0].currency) || 'BRL', contas: accs.length, settings: s, meta,
          sistema: { ...profitOf({ faturamento, gasto: meta.spend, vendas, leads, conversas: 0 }, s), recuperadas, receita_recuperada: receitaRec },
          meta_ads: profitOf({ faturamento: meta.receita_meta, gasto: meta.spend, vendas: meta.compras_meta, leads, conversas: 0 }, s),
          serie: [...porDia.values()].sort((x, y) => (x.dia < y.dia ? -1 : 1)),
        };
      }
      case 'set_status': {
        editor();
        const a = await own(orgId, body.id);
        if (!['ACTIVE', 'PAUSED'].includes(body.status)) fail('Situação inválida.');
        const id = String(body.object_id || ''), level = LEVELS[body.level] ? body.level : 'campaign';
        if (!OBJ.test(id) || (level === 'ad' && !OBJ.test(String(body.parent_id || '')))) fail('Item inválido.');
        const cid = a.customer_id;
        const [svc, res] = level === 'campaign' ? ['campaigns', `customers/${cid}/campaigns/${id}`]
          : level === 'adset' ? ['adGroups', `customers/${cid}/adGroups/${id}`] : ['adGroupAds', `customers/${cid}/adGroupAds/${body.parent_id}~${id}`];
        try { await api(await atOf(a), `/customers/${cid}/${svc}:mutate`, { body: { operations: [{ update: { resourceName: res, status: body.status === 'ACTIVE' ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }] }, login: a.login_customer_id }); }
        catch (e) { markErr(a, e); throw e; }
        dropCache(a.id);
        return { ok: true, effective_status: body.status };
      }
      case 'set_budget': {
        editor();
        const a = await own(orgId, body.id);
        const id = String(body.object_id || '');
        if (!OBJ.test(id)) fail('Item inválido.');
        const v = Number(String(body.value).replace(',', '.'));
        if (!Number.isFinite(v) || v <= 0 || v > 10_000_000) fail('Digite um orçamento válido.');
        const at = await atOf(a);
        const [c] = await search(at, a.customer_id, `SELECT campaign.id, campaign_budget.resource_name, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${id}`, a.login_customer_id);
        if (!c || !c.campaignBudget) fail('O orçamento no Google fica na campanha. Escolha uma campanha.');
        if (c.campaignBudget.explicitlyShared) fail('Esta campanha usa um orçamento compartilhado com outras. Mude no Google Ads para não afetar as demais.');
        const micros = Math.round(v * 100) * 10_000; // centavos inteiros
        try { await api(at, `/customers/${a.customer_id}/campaignBudgets:mutate`, { body: { operations: [{ update: { resourceName: c.campaignBudget.resourceName, amountMicros: String(micros) }, updateMask: 'amount_micros' }] }, login: a.login_customer_id }); }
        catch (e) { markErr(a, e); throw e; }
        dropCache(a.id);
        return { ok: true, daily_budget: micros };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle, oauthCallback };
}
