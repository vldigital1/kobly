// Plataformas de venda com página própria e Zenith contra um Postgres de TESTE. Só as APIs externas são simuladas.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/platforms.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
let pool, server, base;
const A = {}, B = {};
const net = [];

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  net.push({ host: u.hostname, path: u.pathname, method: init.method || 'GET', body: init.body });
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const no = (status, body) => ({ ok: false, status, json: async () => body });
  if (u.hostname === 'public-api.kiwify.com') {
    if (u.pathname === '/v1/oauth/token') return String(init.body).includes('client_secret=kiwi-secret') ? ok({ access_token: 'KT', expires_in: 86400 }) : no(401, { error: 'auth_error' });
    if (u.pathname === '/v1/webhooks' && init.method === 'POST') return ok({ id: 'kw-hook-1', ...JSON.parse(init.body) });
    if (u.pathname.startsWith('/v1/webhooks/') && init.method === 'DELETE') return ok({});
  }
  if (u.hostname === 'api.cakto.com.br') {
    if (u.pathname === '/public_api/token/') return ok({ access_token: 'CT', expires_in: 36000 });
    if (u.pathname === '/public_api/products/') return ok({ results: [{ id: 'prod-1' }] });
    if (u.pathname === '/public_api/webhook/') return ok({ id: 55, fields: { secret: 'cakto-secret-123' } });
  }
  if (u.hostname === 'api.zenithworld.com.br') {
    if (init.headers['X-API-Secret'] !== 'zen-secret') return no(401, { message: 'unauthorized' });
    if (u.pathname === '/integrations/payment-methods') return ok({ methods: [{ code: 'spei' }] });
    if (u.pathname === '/integrations/webhooks/endpoints') return ok({ id: 'we_1' });
  }
  throw new Error('rede não esperada: ' + url);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const fn = async (name, body, token) => { const r = await post(`/functions/v1/${name}`, body, token); const j = await r.json(); return { status: r.status, ...j }; };
const pb = (url, body, extra = '') => post(url.replace('https://api.kobly.test', '') + extra, body);
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
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'), publicBaseUrl: 'https://api.kobly.test' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, nome] of [[A, 'Empresa PL A'], [B, 'Empresa PL B']]) {
    const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
    who.token = s.session.access_token; who.userId = s.session.user.id;
    who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
  }
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('Kiwify pela API: cria o webhook na conta e só aceita aviso com a assinatura certa', { skip }, async () => {
  assert.equal((await fn('platforms', { action: 'connect_api', platform: 'kiwify', client_id: 'c', client_secret: 'errado', account_id: 'acc' }, A.token)).status, 400);
  assert.equal((await pool.query(`select count(*)::int n from public.postback_tokens where organization_id = $1 and platform = 'kiwify'`, [A.orgId])).rows[0].n, 0, 'falha não deixa conexão pela metade');
  const c = await fn('platforms', { action: 'connect_api', platform: 'kiwify', client_id: 'c', client_secret: 'kiwi-secret', account_id: 'acc' }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c)); assert.match(c.url, /^https:\/\/api\.kobly\.test\/functions\/v1\/postback-receiver\?token=pbk_/);
  const sent = JSON.parse(net.filter((x) => x.path === '/v1/webhooks').at(-1).body);
  assert.equal(sent.url, c.url); assert.equal(sent.products, 'all');
  const secret = (await pool.query(`select platform_secret from public.postback_tokens where id = $1`, [c.id])).rows[0].platform_secret;
  assert.equal(secret, sent.token, 'a chave de validação é a mesma enviada à Kiwify');
  await assert.rejects(asUser(A.userId, `select credentials_enc from public.platform_api_credentials`), /permission denied/);

  const body = JSON.stringify({ order_id: `kw-${stamp}`, order_status: 'waiting_payment', webhook_event_type: 'pix_created', payment_method: 'pix', Customer: { full_name: 'Ana', email: `kw${stamp}@x.test`, mobile: '5511' }, Product: { product_name: 'Guia' }, Commissions: { charge_amount: 9700 } });
  const sig = createHmac('sha1', secret).update(body).digest('hex');
  assert.equal((await pb(c.url, body)).status, 401, 'sem assinatura');
  assert.equal((await pb(c.url, body, `&signature=${'0'.repeat(40)}`)).status, 401, 'assinatura errada');
  const okr = await pb(c.url, body, `&signature=${sig}`);
  assert.equal(okr.status, 200);
  const ev = (await pool.query(`select tipo_evento, valor_produto from public.webhook_events where organization_id = $1 and email = $2`, [A.orgId, `kw${stamp}@x.test`])).rows[0];
  assert.deepEqual([ev.tipo_evento, Number(ev.valor_produto)], ['Pix Gerado', 97]);
  const list = await fn('platforms', { action: 'list' }, A.token);
  const row = list.connections.find((x) => x.id === c.id);
  assert.equal(row.via_api, true); assert.equal(row.events_count, 1); assert.ok(row.last_event_at);
  assert.equal((await fn('platforms', { action: 'list' }, B.token)).connections.length, 0, 'outra empresa não vê');

  // vetor oficial da documentação da Kiwify (token kiwify-token-de-teste)
  await pool.query(`update public.postback_tokens set platform_secret = 'kiwify-token-de-teste' where id = $1`, [c.id]);
  const doc = '{"order_id":"9b1c2d3e-0000-4000-8000-000000000001","order_status":"paid","webhook_event_type":"order_approved"}';
  assert.equal((await pb(c.url, doc, '&signature=bf18f352a4f981b91dfa3f6d8742a81080ab8c86')).status, 200, 'assinatura do exemplo oficial é aceita');

  const d = await fn('platforms', { action: 'disconnect', id: c.id }, A.token);
  assert.equal(d.remote_removed, true);
  assert.ok(net.some((x) => x.method === 'DELETE' && x.path === '/v1/webhooks/kw-hook-1'), 'webhook removido da conta Kiwify');
  assert.equal((await pb(c.url, body, `&signature=${sig}`)).status, 401, 'URL desativada');
});

test('Cakto pela API e plataformas pela URL (Payt, PerfectPay, Hotmart, Kirvano)', { skip }, async () => {
  const ck = await fn('platforms', { action: 'connect_api', platform: 'cakto', client_id: 'c', client_secret: 's' }, A.token);
  assert.equal(ck.status, 200, JSON.stringify(ck));
  const cakto = (secret) => ({ secret, event: 'purchase_approved', data: { id: `ck-${stamp}`, amount: 50, paymentMethod: 'pix', customer: { name: 'Cris', email: `ck${stamp}@x.test` }, product: { name: 'P' } } });
  assert.equal((await pb(ck.url, cakto('outro'))).status, 401);
  assert.equal((await pb(ck.url, cakto('cakto-secret-123'))).status, 200);

  const payt = await fn('platforms', { action: 'connect_manual', platform: 'payt', secret: 'ik-payt' }, A.token);
  const paytBody = (k) => ({ integration_key: k, transaction_id: `pt-${stamp}`, status: 'paid', customer: { name: 'D', email: `pt${stamp}@x.test` }, product: { name: 'P' }, transaction: { payment_method: 'pix', payment_status: 'paid', total_price: 9700 } });
  assert.equal((await pb(payt.url, paytBody('outra'))).status, 401);
  assert.equal((await pb(payt.url, paytBody('ik-payt'))).status, 200);

  const pp = await fn('platforms', { action: 'connect_manual', platform: 'perfectpay' }, A.token);
  const ppBody = { token: 'tok-pp', code: `PP${stamp}`, sale_amount: 10, sale_status_enum: 2, customer: { full_name: 'E', email: `pp${stamp}@x.test` }, product: { name: 'P' } };
  assert.equal((await pb(pp.url, ppBody)).status, 200, 'sem chave cadastrada aceita pela URL');
  assert.equal((await fn('platforms', { action: 'update_secret', id: pp.id, secret: 'tok-certo' }, A.token)).status, 200);
  assert.equal((await pb(pp.url, { ...ppBody, code: `PP2${stamp}` })).status, 401, 'com a chave salva, token diferente é recusado');

  const hm = await fn('platforms', { action: 'connect_manual', platform: 'hotmart', secret: 'hottok-123' }, A.token);
  assert.equal((await pool.query(`select hottok, platform_secret from public.postback_tokens where id = $1`, [hm.id])).rows[0].hottok, 'hottok-123', 'Hotmart usa o hottok de sempre');

  const kv = await fn('platforms', { action: 'connect_manual', platform: 'kirvano' }, A.token);
  const kvr = await (await pb(kv.url, { event: 'PIX_GENERATED', sale_id: `kv-${stamp}`, total_price: 'R$ 97,00', customer: { name: 'F', email: `kv${stamp}@x.test` }, products: [{ name: 'Curso' }] })).json();
  assert.equal(kvr.ignored, undefined, JSON.stringify(kvr));
  assert.equal((await fn('platforms', { action: 'connect_api', platform: 'kirvano', client_id: 'x', client_secret: 'y' }, A.token)).status, 422);
  const all = (await fn('platforms', { action: 'list' }, A.token)).connections.map((x) => x.platform).sort();
  assert.deepEqual(all, ['cakto', 'hotmart', 'kirvano', 'payt', 'perfectpay']);
});

test('Zenith: conecta, confere a chave e registra o webhook da Kobly', { skip }, async () => {
  assert.equal((await fn('payment-integrations', { action: 'connect', provider: 'zenith', client_id: 'pk_test', client_secret: 'errada-123', sandbox: true }, A.token)).status, 400);
  const z = await fn('payment-integrations', { action: 'connect', provider: 'zenith', client_id: 'pk_test', client_secret: 'zen-secret', sandbox: true }, A.token);
  assert.equal(z.status, 200, JSON.stringify(z)); assert.equal(z.integration.sandbox, true);
  const reg = net.filter((x) => x.path === '/integrations/webhooks/endpoints').at(-1);
  assert.match(JSON.parse(reg.body).url, /^https:\/\/api\.kobly\.test\/webhooks\/payments\/zenith\/[A-Za-z0-9_-]{20,}$/);
  assert.ok(net.some((x) => x.path === '/integrations/payment-methods'), 'credencial conferida antes');
});
