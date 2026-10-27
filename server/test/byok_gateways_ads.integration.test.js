// Chave de IA por empresa, gateways de Pix (Mercado Pago/Woovi) e Facebook Ads contra um Postgres de TESTE.
// Só a rede (provedores de IA, Mercado Pago, Woovi, Graph API) é simulada.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/byok_gateways_ads.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { createAiKeys } from '../src/ai/router.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
let pool, server, base;
const A = {}, B = {};
const net = [];
const mp = { payments: new Map() };

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const auth = (init.headers || {}).Authorization;
  net.push({ host: u.hostname, path: u.pathname, auth });
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  const no = (status, body) => ({ ok: false, status, headers: { get: () => null }, json: async () => body });
  if (u.hostname === 'api.openai.com') {
    if (auth !== 'Bearer sk-openai-valida-123') return no(401, { error: { message: 'Incorrect API key' } });
    if (u.pathname === '/v1/models') return ok({ data: [{ id: 'gpt-modelo-b' }, { id: 'gpt-modelo-a' }] });
    if (u.pathname === '/v1/chat/completions') return ok({ choices: [{ message: { content: '{"saida":"compra"}' } }] });
  }
  if (u.hostname === 'api.mercadopago.com') {
    if (auth !== 'Bearer APP_USR-teste-mp') return no(401, { message: 'invalid access token' });
    if (u.pathname === '/users/me') return ok({ id: 1 });
    if (u.pathname === '/v1/payments' && init.method === 'POST') {
      const b = JSON.parse(init.body); const id = 9000 + mp.payments.size;
      mp.payments.set(String(id), { status: 'pending', amount: b.transaction_amount });
      return ok({ id, status: 'pending', transaction_amount: b.transaction_amount, point_of_interaction: { transaction_data: { qr_code: '000201BR.GOV.BCB.PIX', ticket_url: 'https://mp.test/t' } } });
    }
    const m = /^\/v1\/payments\/(\d+)$/.exec(u.pathname);
    if (m) { const p = mp.payments.get(m[1]); return ok({ id: Number(m[1]), status: p.status, transaction_amount: p.amount }); }
  }
  if (u.hostname === 'graph.facebook.com') {
    if (u.pathname.endsWith('/oauth/access_token')) {
      assert.equal(u.searchParams.get('client_secret'), 'segredo-app-fb');
      if (u.searchParams.get('code')) return u.searchParams.get('code') === 'codigo-bom' ? ok({ access_token: 'curto-123' }) : no(400, { error: { code: 100, message: 'Invalid code' } });
      return ok({ access_token: `EAAB-token-ads-${stamp}` });
    }
    if (u.pathname.endsWith('/me') && auth === `Bearer EAAB-token-ads-${stamp}`) return ok({ name: 'Dona da Loja' });
    if (auth !== `Bearer EAAB-token-ads-${stamp}`) return no(400, { error: { code: 190, message: 'Invalid OAuth access token.' } });
    if (u.pathname.endsWith('/me/adaccounts')) return ok({ data: [{ account_id: '1234567890', name: 'Loja BR', currency: 'BRL', account_status: 1 }] });
    if (u.pathname.endsWith('/act_1234567890')) return ok({ name: 'Loja BR', currency: 'BRL', account_status: 1 });
    if (u.pathname.endsWith('/act_1234567890/insights')) {
      assert.equal(u.searchParams.get('level'), 'campaign');
      assert.equal(u.searchParams.get('access_token'), null, 'token não vai na URL');
      return ok({ data: [
        { campaign_id: '111', campaign_name: 'black-friday', spend: '200.00', impressions: '5000', clicks: '100', ctr: '2', cpc: '2', account_currency: 'BRL', actions: [{ action_type: 'omni_purchase', value: '2' }], action_values: [{ action_type: 'omni_purchase', value: '194' }] },
        { campaign_id: '222', campaign_name: 'sem-utm', spend: '50', impressions: '800', clicks: '10', ctr: '1.25', cpc: '5' },
      ] });
    }
  }
  throw new Error('rede não esperada: ' + url);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const fn = async (name, body, token) => { const r = await post(`/functions/v1/${name}`, body, token); const j = await r.json(); return { status: r.status, ...j }; };
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
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'),
    publicBaseUrl: 'https://api.kobly.test', metaAdsGraphBase: 'https://graph.facebook.com/v26.0', aiApiKey: 'chave-da-plataforma',
    metaAppId: '1234', metaAppSecret: 'segredo-app-fb', siteUrl: 'https://app.kobly.test' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, nome] of [[A, 'Empresa BYOK A'], [B, 'Empresa BYOK B']]) {
    const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
    who.token = s.session.access_token; who.userId = s.session.user.id;
    who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
  }
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('IA da empresa: chave conferida, cifrada, ativa e usada só pela própria empresa', { skip }, async () => {
  assert.equal((await fn('ai-keys', { action: 'connect', provider: 'openai', api_key: 'sk-openai-errada-000' }, A.token)).status, 400);
  const c = await fn('ai-keys', { action: 'connect', provider: 'openai', api_key: 'sk-openai-valida-123', model: 'gpt-modelo-a' }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c));
  assert.deepEqual(c.models, ['gpt-modelo-a', 'gpt-modelo-b']); assert.equal(c.key.is_active, true, 'a 1ª chave já fica ativa'); assert.equal(c.key.key_hint, '…-123');
  assert.equal((await fn('ai-keys', { action: 'connect', provider: 'openai', api_key: 'sk-openai-valida-123', model: 'nao-existe' }, A.token)).status, 422);
  await assert.rejects(asUser(A.userId, `select key_enc from public.ai_credentials`), /permission denied/);
  const raw = (await pool.query(`select key_enc from public.ai_credentials where organization_id = $1`, [A.orgId])).rows[0].key_enc;
  assert.equal(raw.includes('sk-openai'), false);
  assert.equal((await fn('ai-keys', { action: 'list' }, B.token)).keys.length, 0);
  assert.equal((await fn('ai-keys', { action: 'remove', id: c.key.id }, B.token)).status, 404);

  // o motor usa a chave da empresa; sem chave e sem reserva da plataforma, a IA fica desligada
  const keys = createAiKeys({ pool, secretKey: KEY, fetchImpl: fakeFetch, platform: { apiKey: 'chave-da-plataforma' }, allowPlatform: false });
  const n = net.length;
  assert.equal(await (await keys.forOrg(A.orgId)).classify({ text: 'quero', outputs: [{ key: 'compra', description: 'x' }] }), 'compra');
  assert.equal(net.slice(n).find((x) => x.path === '/v1/chat/completions').auth, 'Bearer sk-openai-valida-123');
  await assert.rejects((await keys.forOrg(B.orgId)).classify({ text: 'x', outputs: [] }), /cadastre a chave/);
  assert.ok((await pool.query(`select last_used_at from public.ai_credentials where id = $1`, [c.key.id])).rows[0].last_used_at, 'uso registrado');
  const comReserva = createAiKeys({ pool, secretKey: KEY, fetchImpl: fakeFetch, platform: { apiKey: 'chave-da-plataforma' }, allowPlatform: true });
  assert.equal((await comReserva.forOrg(B.orgId)).configured, true, 'com AI_PLATFORM_FALLBACK a empresa sem chave usa a da plataforma');

  assert.equal((await fn('ai-keys', { action: 'set_model', id: c.key.id, model: 'gpt-modelo-b' }, A.token)).status, 200);
  assert.equal((await fn('ai-keys', { action: 'list' }, A.token)).keys[0].model, 'gpt-modelo-b');
});

test('Mercado Pago: conecta com o token, cobra Pix no fluxo e o aviso confirma pela consulta', { skip }, async () => {
  assert.equal((await fn('payment-integrations', { action: 'connect', provider: 'mercadopago', client_secret: 'token-errado-123' }, A.token)).status, 400);
  const c = await fn('payment-integrations', { action: 'connect', provider: 'mercadopago', client_secret: 'APP_USR-teste-mp' }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c)); assert.equal(c.integration.provider, 'mercadopago');
  const list = await fn('payment-integrations', { action: 'list' }, A.token);
  assert.deepEqual(list.providers.map((p) => p.id).sort(), ['mercadopago', 'pushinpay', 'syncpay', 'woovi', 'xpag', 'zenith']);

  // a validação do fluxo avisa quando o bloco pede moeda/método que o Mercado Pago não cobra
  const camp = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'MP') returning id`, [A.orgId])).rows[0].id;
  const g = (currency, method) => ({ version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'pg' } },
    { ref: 'pg', type: 'payment', data: { integration_id: c.integration.id, currency, method, amount: '50' }, next: { charge_created: 'fim' } },
    { ref: 'fim', type: 'end', data: {}, next: {} }] });
  assert.ok((await fn('flow-graph', { action: 'validate', campaign_id: camp, graph: g('MXN', 'SPEI') }, A.token)).warnings.some((w) => /só cobra Pix/.test(w)));
  assert.equal((await fn('flow-graph', { action: 'validate', campaign_id: camp, graph: g('BRL', 'PIX') }, A.token)).warnings.length, 0);

  // cobrança (como o bloco faria) e aviso do Mercado Pago → consulta → confirmada
  const lead = (await pool.query(`insert into public.leads (organization_id, email, nome) values ($1,$2,'Ana') returning id`, [A.orgId, `mp${stamp}@x.test`])).rows[0].id;
  const exec = { id: null, organization_id: A.orgId, campaign_id: camp, lead_id: lead };
  const { createPayments } = await import('../src/payments/service.js');
  const { createMercadoPago, createWoovi } = await import('../src/payments/pix_br.js');
  const pays = createPayments({ pool, providers: { mercadopago: createMercadoPago({ fetchImpl: fakeFetch }), woovi: createWoovi({ fetchImpl: fakeFetch }) }, secretKey: KEY, publicBaseUrl: 'https://api.kobly.test' });
  const ch = await pays.createCharge({ ex: exec, nodeRef: 'pg', integrationId: c.integration.id, currency: 'BRL', method: 'PIX', amount: 50, payer: { name: 'Ana', email: `mp${stamp}@x.test` }, description: 'Guia', externalId: `kb-${stamp}` });
  assert.equal(ch.payment_code, '000201BR.GOV.BCB.PIX'); assert.equal(ch.status, 'pending');
  await assert.rejects(pays.createCharge({ ex: exec, nodeRef: 'pg', integrationId: c.integration.id, currency: 'MXN', method: 'SPEI', amount: 50, payer: {}, externalId: `kb2-${stamp}` }), /não cobra SPEI/);
  const tok = (await pool.query(`select webhook_token from public.payment_integrations where id = $1`, [c.integration.id])).rows[0].webhook_token;
  const aviso = (n) => fetch(`${base}/webhooks/payments/mercadopago/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: n, type: 'payment', action: 'payment.updated', data: { id: ch.transaction_id } }) });
  assert.equal((await aviso(1)).status, 200);
  assert.equal((await pool.query(`select status from public.payment_charges where id = $1`, [ch.id])).rows[0].status, 'pending', 'aviso sem pagamento real não confirma');
  mp.payments.get(ch.transaction_id).status = 'approved';
  assert.equal((await aviso(2)).status, 200);
  assert.equal((await pool.query(`select status from public.payment_charges where id = $1`, [ch.id])).rows[0].status, 'confirmed');
});

test('Facebook Ads: conta conectada com o token cifrado e campanhas ao lado das vendas da Kobly', { skip }, async () => {
  const token = `EAAB-token-ads-${stamp}`;
  assert.equal((await fn('meta-ads', { action: 'discover', access_token: 'EAAB-token-invalido-000000' }, A.token)).status, 400);
  const d = await fn('meta-ads', { action: 'discover', access_token: token }, A.token);
  assert.deepEqual(d.accounts, [{ ad_account_id: '1234567890', name: 'Loja BR', currency: 'BRL', active: true }]);
  const c = await fn('meta-ads', { action: 'connect', access_token: token, ad_account_id: 'act_1234567890' }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c));
  await assert.rejects(asUser(A.userId, `select token_enc from public.meta_ads_accounts`), /permission denied/);
  assert.equal((await fn('meta-ads', { action: 'insights', id: c.account.id }, B.token)).status, 404, 'outra empresa não lê');

  // leads da Kobly que vieram da campanha (utm_campaign = nome) e uma venda recuperada pelo fluxo
  const l1 = (await pool.query(`insert into public.leads (organization_id, email, nome, utm) values ($1,$2,'L1','{"utm_campaign":"Black-Friday"}') returning id`, [A.orgId, `fb1${stamp}@x.test`])).rows[0].id;
  await pool.query(`insert into public.leads (organization_id, email, nome, utm) values ($1,$2,'L2','{"utm_campaign":"black-friday"}')`, [A.orgId, `fb2${stamp}@x.test`]);
  await pool.query(`insert into public.flow_sales (organization_id, lead_id, amount, currency) values ($1,$2,97,'BRL')`, [A.orgId, l1]);
  const r = await fn('meta-ads', { action: 'insights', id: c.account.id, date_preset: 'today' }, A.token);
  assert.equal(r.status, 200, JSON.stringify(r));
  const bf = r.campaigns.find((x) => x.campaign_id === '111');
  assert.deepEqual([bf.spend, bf.compras_meta, bf.receita_meta], [200, 2, 194]);
  assert.deepEqual([bf.kobly.leads, bf.kobly.recuperadas, bf.kobly.receita_recuperada], [2, 1, 97]);
  assert.equal(bf.roas_kobly.toFixed(3), '0.485');
  assert.equal(r.campaigns.find((x) => x.campaign_id === '222').kobly, null);
  assert.deepEqual([r.totals.spend, r.totals.recuperadas], [250, 1]);
  const n = net.length;
  await fn('meta-ads', { action: 'insights', id: c.account.id, date_preset: 'today' }, A.token);
  assert.equal(net.length, n, 'cache de 1 minuto: não chama o Facebook de novo');
  assert.equal((await fn('meta-ads', { action: 'insights', id: c.account.id, date_preset: 'today', force: true }, A.token)).status, 200);
  assert.equal(net.length, n + 1);
});

test('Conectar com Facebook: janelinha de login, troca do código e escolha das contas', { skip }, async () => {
  const st = await fn('meta-ads', { action: 'oauth_start' }, B.token);
  assert.equal(st.status, 200, JSON.stringify(st));
  const u = new URL(st.url);
  assert.equal(u.hostname, 'www.facebook.com'); assert.equal(u.pathname, '/v26.0/dialog/oauth');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://api.kobly.test/oauth/meta/callback');
  assert.match(u.searchParams.get('scope'), /ads_read/);
  const state = u.searchParams.get('state');
  const back = async (q) => (await fetch(base + '/oauth/meta/callback?' + new URLSearchParams(q))).text();
  assert.match(await back({ state: state.slice(0, -2) + 'xx', code: 'codigo-bom' }), /expirou/, 'state adulterado não vale');
  assert.match(await back({ state, error: 'access_denied' }), /cancelou/);
  assert.equal((await fn('meta-ads', { action: 'oauth_accounts' }, B.token)).status, 410, 'sem login ainda');
  const ok = await back({ state, code: 'codigo-bom' });
  assert.match(ok, /Facebook conectado/); assert.ok(ok.includes('postMessage({"kobly":"meta-oauth","ok":true'), 'avisa a janela da Kobly'); assert.ok(ok.includes('"https://app.kobly.test"'), 'só para o site da Kobly');
  assert.doesNotMatch(ok, /EAAB/, 'o token não aparece na página');
  await assert.rejects(asUser(B.userId, `select token_enc from public.meta_ads_oauth`), /permission denied/);
  assert.equal((await fn('meta-ads', { action: 'oauth_accounts' }, A.token)).status, 410, 'outra empresa não usa o login');
  const ac = await fn('meta-ads', { action: 'oauth_accounts' }, B.token);
  assert.equal(ac.user_name, 'Dona da Loja'); assert.equal(ac.accounts[0].ad_account_id, '1234567890');
  const c = await fn('meta-ads', { action: 'oauth_connect', ad_account_ids: ['1234567890'] }, B.token);
  assert.equal(c.status, 200, JSON.stringify(c)); assert.equal(c.accounts[0].name, 'Loja BR');
  assert.equal((await fn('meta-ads', { action: 'accounts' }, B.token)).accounts.length, 1);
  assert.equal((await pool.query(`select count(*)::int as n from public.meta_ads_oauth where organization_id = $1`, [B.orgId])).rows[0].n, 0, 'login usado é apagado');
});
