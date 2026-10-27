// Gerenciador de anúncios: dashboard, contas, campanhas/conjuntos/anúncios com as vendas rastreadas pela UTM,
// ligar/pausar, orçamento e taxas. Só a Graph API é simulada.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/ads_manager.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { utmKeys, profitOf, periodOf } from '../src/ads/manager.js';
import { waitMinutes } from '../src/ads/meta.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
const TOKEN = `EAAB-gerenciador-${stamp}`;
const ACT = '7777777777';
let pool, server, base;
const A = {}, B = {};
const posts = [];
const state = { camp1: 'ACTIVE', budget: 5000, writeAllowed: true };

const ins = (spend, compras, receita, extra = {}) => ({ data: [{ spend: String(spend), impressions: '1000', reach: '800', clicks: '50', ctr: '5', cpc: '1', cpm: '10',
  actions: [{ action_type: 'omni_purchase', value: String(compras) }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '20' }],
  action_values: [{ action_type: 'omni_purchase', value: String(receita) }], ...extra }] });
async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  const no = (status, body) => ({ ok: false, status, headers: { get: () => null }, json: async () => body });
  if (u.hostname !== 'graph.facebook.com') throw new Error('rede não esperada: ' + url);
  if ((init.headers || {}).Authorization !== `Bearer ${TOKEN}`) return no(400, { error: { code: 190, message: 'Invalid OAuth access token.' } });
  const p = u.pathname.replace('/v26.0', '');
  if (init.method === 'POST') {
    if (!state.writeAllowed) return no(403, { error: { code: 200, message: 'Requires ads_management permission' } });
    const f = new URLSearchParams(init.body);
    posts.push({ path: p, form: Object.fromEntries(f) });
    if (f.get('status')) state.camp1 = f.get('status');
    if (f.get('daily_budget')) state.budget = Number(f.get('daily_budget'));
    return ok({ success: true });
  }
  if (p === `/act_${ACT}`) return ok({ name: 'Conta Loja', currency: 'BRL', account_status: 1, amount_spent: '15000', insights: ins(150, 3, 300) });
  if (p === `/act_${ACT}/campaigns`) {
    assert.match(u.searchParams.get('fields'), /insights\.date_preset\(/);
    return ok({ data: [
      { id: '1201', name: 'Black Friday', status: state.camp1, effective_status: state.camp1, daily_budget: String(state.budget), insights: ins(100, 2, 200) },
      { id: '1202', name: 'Remarketing', status: 'PAUSED', effective_status: 'PAUSED', insights: ins(50, 1, 100) },
    ] });
  }
  if (p === `/act_${ACT}/adsets`) return ok({ data: [{ id: '2301', name: 'Público quente', status: 'ACTIVE', effective_status: 'ACTIVE', campaign_id: '1201', campaign: { name: 'Black Friday' }, insights: ins(100, 2, 200) }] });
  if (p === `/act_${ACT}/ads`) return ok({ data: [{ id: '3401', name: 'Vídeo 1', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '2301', adset: { name: 'Público quente' }, campaign_id: '1201', campaign: { name: 'Black Friday' }, creative: { thumbnail_url: 'https://x/t.jpg' }, insights: ins(100, 2, 200) }] });
  if (p === `/act_${ACT}/insights`) {
    assert.equal(u.searchParams.get('time_increment'), '1');
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
    return ok({ data: [{ ...ins(60, 1, 100).data[0], date_start: d(1) }, { ...ins(90, 2, 200).data[0], date_start: d(0) }] });
  }
  if (p === '/1201') return ok({ account_id: ACT, daily_budget: String(state.budget), name: 'Black Friday' });
  if (p === '/2301') return ok({ account_id: ACT, name: 'Público quente' });
  if (p === '/9999') return ok({ account_id: '1111111111', daily_budget: '100' });
  throw new Error('caminho não esperado: ' + p);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const fn = async (body, token) => { const r = await post('/functions/v1/meta-ads', body, token); const j = await r.json(); return { status: r.status, ...j }; };
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
  const config = { jwtSecret: 'segredo-jwt-ads', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'), metaAdsGraphBase: 'https://graph.facebook.com/v26.0' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, nome] of [[A, 'Loja Ads A'], [B, 'Loja Ads B']]) {
    const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
    who.token = s.session.access_token; who.userId = s.session.user.id;
    who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
  }
  A.acc = (await fn({ action: 'connect', access_token: TOKEN, ad_account_id: ACT }, A.token)).account.id;
  // vendas rastreadas: lead da Black Friday com "nome|id" nas UTMs; outro com o ID só no anúncio
  const lead = async (utm, email) => (await pool.query(`insert into public.leads (organization_id, email, nome, utm) values ($1,$2,'L',$3::jsonb) returning id`, [A.orgId, email, JSON.stringify(utm)])).rows[0].id;
  const l1 = await lead({ utm_campaign: 'Black Friday|1201', utm_medium: 'Público quente|2301', utm_content: 'Vídeo 1|3401' }, `a${stamp}@x.test`);
  const l2 = await lead({ utm_campaign: '1201', utm_content: '3401' }, `b${stamp}@x.test`);
  await lead({ utm_campaign: 'outra-coisa' }, `c${stamp}@x.test`);
  await pool.query(`insert into public.webhook_events (organization_id, provider, tipo_evento, lead_id, valor_produto, id_webhook) values ($1,'kiwify','Compra Aprovada',$2,197,$3)`, [A.orgId, l1, `bf-${stamp}`]);
  await pool.query(`insert into public.flow_sales (organization_id, lead_id, amount) values ($1,$2,97)`, [A.orgId, l2]);
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('quanto esperar quando o Facebook limita', () => {
  const h = (o) => ({ get: (k) => o[k] || null });
  assert.equal(waitMinutes(h({ 'x-business-use-case-usage': JSON.stringify({ 123: [{ type: 'ads_management', estimated_time_to_regain_access: 7 }] }) })), 7);
  assert.equal(waitMinutes(h({ 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 290 }) })), 5);
  assert.equal(waitMinutes(h({})), 0); assert.equal(waitMinutes(null), 0);
});

test('UTM "nome|id", período e lucro', () => {
  assert.deepEqual(utmKeys('Black Friday|1201'), ['black friday|1201', 'black friday', '1201']);
  assert.deepEqual(utmKeys(''), []);
  const p = periodOf('last_7d', new Date(2026, 9, 26, 15));
  assert.equal(p.since.getDate(), 20); assert.equal(p.until, null);
  const y = periodOf('yesterday', new Date(2026, 9, 26, 15));
  assert.deepEqual([y.since.getDate(), y.until.getDate()], [25, 26]);
  const r = profitOf({ faturamento: 1000, gasto: 300, vendas: 4, leads: 40, conversas: 10 }, { imposto_pct: 6, taxa_gateway_pct: 4, custo_produto_pct: 0, custo_por_venda: 5 });
  assert.equal(r.despesas, 120); assert.equal(r.lucro, 580); assert.equal(r.ticket_medio, 250);
  assert.equal(r.margem.toFixed(2), "58.00"); assert.equal(r.taxa_conversao, 10); assert.equal(r.cpa, 75); assert.equal(r.custo_por_conversa, 30);
});

test('campanhas, conjuntos e anúncios com as vendas da Kobly casadas pela UTM', { skip }, async () => {
  const c = await fn({ action: 'entities', level: 'campaign', id: 'all', date_preset: 'last_7d' }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c));
  const bf = c.items.find((x) => x.id === '1201');
  assert.deepEqual([bf.spend, bf.compras_meta, bf.vendas, bf.faturamento], [100, 2, 2, 294], 'checkout + recuperada, pelo nome|id e pelo ID');
  assert.equal(bf.roas.toFixed(2), '2.94'); assert.equal(bf.daily_budget, 5000); assert.equal(bf.budget_unit, 100);
  assert.equal(c.items.find((x) => x.id === '1202').vendas, 0);
  const ad = (await fn({ action: 'entities', level: 'ad', date_preset: 'last_7d' }, A.token)).items[0];
  assert.deepEqual([ad.vendas, ad.campaign_name, ad.adset_name], [2, 'Black Friday', 'Público quente']);
  const st = (await fn({ action: 'entities', level: 'adset', date_preset: 'last_7d' }, A.token)).items[0];
  assert.equal(st.vendas, 1, 'só o lead com utm_medium casa o conjunto');
  assert.equal((await fn({ action: 'entities', level: 'campaign', id: A.acc }, B.token)).status, 404, 'outra empresa não vê');
});

test('dashboard: métricas do sistema e da Meta, com taxas e série por dia', { skip }, async () => {
  assert.equal((await fn({ action: 'save_settings', imposto_pct: 10, taxa_gateway_pct: 0, custo_produto_pct: 0, custo_por_venda: 0 }, A.token)).status, 200);
  assert.equal((await fn({ action: 'save_settings', imposto_pct: 140, taxa_gateway_pct: 0, custo_produto_pct: 0, custo_por_venda: 0 }, A.token)).status, 422);
  const d = await fn({ action: 'dashboard', date_preset: 'last_7d', force: true }, A.token);
  assert.equal(d.status, 200, JSON.stringify(d));
  assert.equal(d.meta.spend, 150); assert.equal(d.meta.conversas, 40);
  assert.deepEqual([d.sistema.vendas, d.sistema.faturamento], [2, 294]);
  assert.equal(d.sistema.lucro.toFixed(2), (294 - 150 - 29.4).toFixed(2), 'imposto de 10% sai do lucro');
  assert.equal(d.sistema.custo_por_conversa, 150 / 40);
  assert.deepEqual([d.meta_ads.vendas, d.meta_ads.faturamento], [3, 300]);
  assert.equal(d.serie.length, 2); assert.equal(d.serie.reduce((s, x) => s + x.vendas, 0), 2);
  const o = await fn({ action: 'accounts_overview', date_preset: 'last_7d' }, A.token);
  assert.equal(o.accounts[0].name, 'Conta Loja'); assert.equal(o.accounts[0].vendas, 2); assert.equal(o.accounts[0].campanhas_ativas, 1);
});

test('pausar, ativar e editar orçamento; item de outra conta e sem permissão recusados', { skip }, async () => {
  const p = await fn({ action: 'set_status', id: A.acc, object_id: '1201', status: 'PAUSED' }, A.token);
  assert.equal(p.status, 200, JSON.stringify(p)); assert.equal(state.camp1, 'PAUSED');
  assert.deepEqual(posts.at(-1), { path: '/1201', form: { status: 'PAUSED' } });
  assert.equal((await fn({ action: 'entities', level: 'campaign', date_preset: 'last_7d' }, A.token)).items.find((x) => x.id === '1201').status, 'PAUSED', 'cache limpo depois da mudança');
  const b = await fn({ action: 'set_budget', id: A.acc, object_id: '1201', value: '75,50' }, A.token);
  assert.equal(b.status, 200, JSON.stringify(b)); assert.equal(state.budget, 7550);
  assert.match((await fn({ action: 'set_budget', id: A.acc, object_id: '2301', value: '10' }, A.token)).message, /nível de cima/);
  assert.equal((await fn({ action: 'set_status', id: A.acc, object_id: '9999', status: 'PAUSED' }, A.token)).status, 404);
  assert.equal((await fn({ action: 'set_status', id: A.acc, object_id: '1201', status: 'DELETED' }, A.token)).status, 422);
  assert.equal((await fn({ action: 'set_status', id: A.acc, object_id: '1201', status: 'ACTIVE' }, B.token)).status, 404, 'outra empresa não mexe');
  state.writeAllowed = false;
  assert.match((await fn({ action: 'set_status', id: A.acc, object_id: '1201', status: 'ACTIVE' }, A.token)).message, /ads_management/);
});
