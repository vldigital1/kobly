// Google Ads: login com Google (MCC com conta de cliente), campanhas/grupos/anúncios com as vendas rastreadas
// pela UTM, dashboard, pausar/ativar e orçamento. Só o Google é simulado.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/google_ads.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { googleMetrics } from '../src/ads/google.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
const MCC = '1112223333', CLI = '4445556666';
let pool, server, base;
const A = {}, B = {};
const calls = [];
const st = { camp: 'ENABLED', budget: 50_000_000 };

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const h = init.headers || {};
  const ok = (b) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => b });
  const no = (s, b) => ({ ok: false, status: s, headers: { get: () => null }, json: async () => b });
  if (u.hostname === 'oauth2.googleapis.com') {
    const f = new URLSearchParams(init.body);
    assert.equal(f.get('client_secret'), 'segredo-google');
    if (f.get('grant_type') === 'authorization_code') return f.get('code') === 'codigo-bom' ? ok({ access_token: 'ya29.x', refresh_token: `1//refresh-${stamp}`, expires_in: 3599 }) : no(400, { error: 'invalid_grant' });
    if (f.get('grant_type') === 'refresh_token') return f.get('refresh_token') === `1//refresh-${stamp}` ? ok({ access_token: 'ya29.novo', expires_in: 3599 }) : no(400, { error: 'invalid_grant' });
  }
  if (u.hostname !== 'googleads.googleapis.com') throw new Error('rede não esperada: ' + url);
  assert.equal(h['developer-token'], undefined);
  assert.ok(u.pathname.startsWith('/v26/'));
  if (h.Authorization !== 'Bearer ya29.novo') return no(401, { error: { message: 'UNAUTHENTICATED' } });
  const p = u.pathname.slice(4);
  if (p === '/customers:listAccessibleCustomers') return ok({ resourceNames: [`customers/${MCC}`] });
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ path: p, login: h['login-customer-id'], body });
  const q = body.query || '';
  if (p === `/customers/${MCC}/googleAds:search`) {
    if (/FROM customer_client/.test(q)) return ok({ results: [{ customerClient: { id: CLI, descriptiveName: 'Loja Google', currencyCode: 'BRL', manager: false } }] });
    return ok({ results: [{ customer: { id: MCC, descriptiveName: 'MCC Agência', manager: true } }] });
  }
  if (p === `/customers/${CLI}/googleAds:search`) {
    assert.equal(h['login-customer-id'], MCC, 'conta de cliente usa a MCC no cabeçalho');
    const met = (c, i, k, conv, val) => ({ costMicros: String(c), impressions: String(i), clicks: String(k), conversions: conv, conversionsValue: val });
    if (/FROM customer WHERE/.test(q)) return ok({ results: [{ segments: { date: '2026-10-25' }, metrics: met(30_000_000, 1000, 40, 1, 100) }, { segments: { date: '2026-10-26' }, metrics: met(70_000_000, 2000, 60, 2, 200) }] });
    if (/campaign_budget.resource_name/.test(q)) return ok({ results: [{ campaign: { id: '9001' }, campaignBudget: { resourceName: `customers/${CLI}/campaignBudgets/77`, explicitlyShared: false } }] });
    if (/FROM campaign WHERE/.test(q)) {
      if (/metrics/.test(q)) return ok({ results: [{ campaign: { id: '9001' }, metrics: met(100_000_000, 3000, 100, 3, 300) }] });
      return ok({ results: [
        { campaign: { id: '9001', name: 'Search Marca', status: st.camp, advertisingChannelType: 'SEARCH' }, campaignBudget: { amountMicros: String(st.budget), explicitlyShared: false } },
        { campaign: { id: '9002', name: 'Black Friday', status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX' }, campaignBudget: { amountMicros: '20000000' } }] });
    }
    if (/FROM ad_group WHERE/.test(q)) {
      if (/metrics/.test(q)) return ok({ results: [{ adGroup: { id: '8001' }, metrics: met(100_000_000, 3000, 100, 3, 300) }] });
      return ok({ results: [{ adGroup: { id: '8001', name: 'Termos de marca', status: 'ENABLED' }, campaign: { id: '9001', name: 'Search Marca', status: st.camp } }] });
    }
    if (/FROM ad_group_ad WHERE/.test(q)) {
      if (/metrics/.test(q)) return ok({ results: [] });
      return ok({ results: [{ adGroupAd: { status: 'ENABLED', ad: { id: '7001', type: 'RESPONSIVE_SEARCH_AD' } }, adGroup: { id: '8001', name: 'Termos de marca', status: 'ENABLED' }, campaign: { id: '9001', name: 'Search Marca', status: st.camp } }] });
    }
  }
  if (p === `/customers/${CLI}/campaigns:mutate`) { st.camp = body.operations[0].update.status; return ok({ results: [{}] }); }
  if (p === `/customers/${CLI}/adGroupAds:mutate`) return ok({ results: [{}] });
  if (p === `/customers/${CLI}/campaignBudgets:mutate`) { st.budget = Number(body.operations[0].update.amountMicros); return ok({ results: [{}] }); }
  throw new Error('caminho não esperado: ' + p + ' ' + q);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const fn = async (body, token) => { const r = await post('/functions/v1/google-ads', body, token); const j = await r.json(); return { http: r.status, ...j }; };
async function asUser(userId, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role kobly_authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'kobly_authenticated' })]);
    const r = await c.query(sql, params); await c.query('commit'); return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-gads', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'),
    publicBaseUrl: 'https://api.kobly.test', siteUrl: 'https://app.kobly.test',
    googleAdsClientId: 'cliente.apps.googleusercontent.com', googleAdsClientSecret: 'segredo-google', googleAdsApiVersion: 'v26' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, nome] of [[A, 'Loja GAds A'], [B, 'Loja GAds B']]) {
    const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
    who.token = s.session.access_token; who.userId = s.session.user.id;
    who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
  }
  // venda do Google (pelo ID do ValueTrack) e venda do Facebook com o mesmo nome de campanha, que não pode entrar
  const lead = async (utm, email) => (await pool.query(`insert into public.leads (organization_id, email, nome, utm) values ($1,$2,'L',$3::jsonb) returning id`, [A.orgId, email, JSON.stringify(utm)])).rows[0].id;
  const g = await lead({ utm_source: 'google', utm_campaign: '9001', utm_medium: '8001', utm_content: '7001' }, `g${stamp}@x.test`);
  const f = await lead({ utm_source: 'FB', utm_campaign: 'Search Marca' }, `f${stamp}@x.test`);
  await pool.query(`insert into public.webhook_events (organization_id, provider, tipo_evento, lead_id, valor_produto, id_webhook) values ($1,'kiwify','Compra Aprovada',$2,250,$3), ($1,'kiwify','Compra Aprovada',$4,999,$5)`, [A.orgId, g, `g-${stamp}`, f, `f-${stamp}`]);
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('métricas do Google no formato da Kobly', () => {
  const m = googleMetrics({ costMicros: '12500000', impressions: '1000', clicks: '50', conversions: 2, conversionsValue: 300 });
  assert.deepEqual([m.spend, m.ctr, m.cpc, m.cpm, m.compras_meta, m.receita_meta], [12.5, 5, 0.25, 12.5, 2, 300]);
});

test('Conectar com Google: login, MCC com conta de cliente e escolha das contas', { skip }, async () => {
  const s = await fn({ action: 'oauth_start' }, A.token);
  assert.equal(s.http, 200, JSON.stringify(s));
  const u = new URL(s.url);
  assert.equal(u.hostname, 'accounts.google.com');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/adwords');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://api.kobly.test/oauth/google/callback');
  const back = async (q) => (await fetch(base + '/oauth/google/callback?' + new URLSearchParams(q))).text();
  const state = u.searchParams.get('state');
  assert.match(await back({ state: state + 'x', code: 'codigo-bom' }), /expirou/);
  assert.match(await back({ state, error: 'access_denied' }), /cancelou/);
  const okPage = await back({ state, code: 'codigo-bom', scope: 'https://www.googleapis.com/auth/adwords' });
  assert.match(okPage, /Google conectado/); assert.doesNotMatch(okPage, /refresh/);
  await assert.rejects(asUser(A.userId, `select token_enc from public.google_ads_oauth`), /permission denied/);
  assert.equal((await fn({ action: 'oauth_accounts' }, B.token)).http, 410, 'outra empresa não usa o login');
  const ac = await fn({ action: 'oauth_accounts' }, A.token);
  assert.deepEqual(ac.accounts.map((x) => [x.customer_id, x.login_customer_id]), [[CLI, MCC]], 'mostra a conta de cliente, não a MCC');
  assert.match((await fn({ action: 'oauth_connect', customer_ids: ['9999999999'] }, A.token)).message, /não está acessível/);
  const c = await fn({ action: 'oauth_connect', customer_ids: ['444-555-6666'] }, A.token);
  assert.equal(c.http, 200, JSON.stringify(c)); assert.equal(c.accounts[0].name, 'Loja Google');
  A.acc = c.accounts[0].id;
  await assert.rejects(asUser(A.userId, `select token_enc from public.google_ads_accounts`), /permission denied/);
});

test('campanhas, grupos e anúncios com as vendas do Google (e só as do Google)', { skip }, async () => {
  const c = await fn({ action: 'entities', level: 'campaign', date_preset: 'last_7d' }, A.token);
  assert.equal(c.http, 200, JSON.stringify(c));
  const sm = c.items.find((x) => x.id === '9001');
  assert.deepEqual([sm.spend, sm.compras_meta, sm.vendas, sm.faturamento, sm.status, sm.daily_budget / sm.budget_unit], [100, 3, 1, 250, 'ACTIVE', 50], 'a venda do Facebook de mesmo nome fica de fora');
  assert.equal(c.items.find((x) => x.id === '9002').spend, 0, 'campanha sem gasto também aparece');
  const g = (await fn({ action: 'entities', level: 'adset', date_preset: 'last_7d' }, A.token)).items[0];
  assert.deepEqual([g.name, g.vendas, g.campaign_name], ['Termos de marca', 1, 'Search Marca']);
  const ad = (await fn({ action: 'entities', level: 'ad', date_preset: 'last_7d' }, A.token)).items[0];
  assert.deepEqual([ad.id, ad.vendas, ad.adset_id], ['7001', 1, '8001']);
  const d = await fn({ action: 'dashboard', date_preset: 'last_7d' }, A.token);
  assert.equal(d.meta.spend, 100); assert.equal(d.serie.reduce((s, x) => s + x.gasto, 0), 100); assert.equal(d.serie.reduce((s, x) => s + x.vendas, 0), 1);
  assert.deepEqual([d.sistema.vendas, d.sistema.faturamento, d.meta_ads.vendas], [1, 250, 3]);
  const o = await fn({ action: 'accounts_overview', date_preset: 'last_7d' }, A.token);
  assert.equal(o.accounts[0].ad_account_id, '444-555-6666'); assert.equal(o.accounts[0].campanhas_ativas, 1);
  assert.equal((await fn({ action: 'entities', id: A.acc }, B.token)).http, 404);
});

test('pausar campanha e anúncio, mudar orçamento', { skip }, async () => {
  const p = await fn({ action: 'set_status', id: A.acc, level: 'campaign', object_id: '9001', status: 'PAUSED' }, A.token);
  assert.equal(p.http, 200, JSON.stringify(p)); assert.equal(st.camp, 'PAUSED');
  assert.equal(calls.at(-1).body.operations[0].update.resourceName, `customers/${CLI}/campaigns/9001`);
  assert.equal((await fn({ action: 'entities', level: 'campaign', date_preset: 'last_7d' }, A.token)).items.find((x) => x.id === '9001').status, 'PAUSED');
  await fn({ action: 'set_status', id: A.acc, level: 'ad', object_id: '7001', parent_id: '8001', status: 'PAUSED' }, A.token);
  assert.equal(calls.at(-1).body.operations[0].update.resourceName, `customers/${CLI}/adGroupAds/8001~7001`);
  const b = await fn({ action: 'set_budget', id: A.acc, object_id: '9001', value: '75,5' }, A.token);
  assert.equal(b.http, 200, JSON.stringify(b)); assert.equal(st.budget, 75_500_000);
  assert.equal((await fn({ action: 'set_status', id: A.acc, level: 'campaign', object_id: '9001', status: 'ACTIVE' }, B.token)).http, 404);
});
