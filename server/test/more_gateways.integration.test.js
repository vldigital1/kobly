// PushinPay e SyncPay no bloco Cobrança e postbacks de Cakto e PerfectPay contra um Postgres de TESTE.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/more_gateways.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { createPayments } from '../src/payments/service.js';
import { createPushinPay, createSyncPay } from '../src/payments/pix_br.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
let pool, server, base;
const A = {};
const pushin = new Map();

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const no = (status, body) => ({ ok: false, status, json: async () => body });
  if (u.hostname === 'api.pushinpay.com.br') {
    if (init.headers.Authorization !== 'Bearer pushin-token-valido') return no(401, { message: 'Unauthenticated.' });
    if (u.pathname === '/api/pix/cashIn') { const id = `pp-${pushin.size + 1}`; pushin.set(id, { status: 'created', value: JSON.parse(init.body).value }); return ok({ id, qr_code: '00020101PUSHIN', status: 'created', value: JSON.parse(init.body).value }); }
    const m = /^\/api\/transactions\/(.+)$/.exec(u.pathname);
    if (m) { const t = pushin.get(m[1]); return t ? ok({ id: m[1], ...t }) : no(404, []); }
  }
  if (u.hostname === 'api.syncpayments.com.br') {
    if (u.pathname.endsWith('/auth-token')) return JSON.parse(init.body).client_secret === 'sync-secret-ok' ? ok({ access_token: 'AT', expires_in: 3600 }) : no(401, { error: 'invalid_client' });
  }
  throw new Error('rede não esperada: ' + url);
}
const post = (path, body, token, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
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
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'), publicBaseUrl: 'https://api.kobly.test' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await (await post('/auth/signup', { email: `gw${stamp}@kobly.test`, password: 'senha-forte-123', nome: 'Empresa GW' })).json();
  A.token = s.session.access_token; A.userId = s.session.user.id;
  A.orgId = (await asUser(A.userId, `select (public.create_own_org($1)).id as id`, ['Empresa GW'])).rows[0].id;
  A.pbk = (await pool.query(`insert into public.postback_tokens (organization_id, nome) values ($1,'Checkout') returning token`, [A.orgId])).rows[0].token;
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('PushinPay: conecta com o token, cobra e o aviso (em formulário) confirma pela consulta', { skip }, async () => {
  assert.equal((await fn('payment-integrations', { action: 'connect', provider: 'pushinpay', client_secret: 'pushin-token-errado' }, A.token)).status, 400);
  const c = await fn('payment-integrations', { action: 'connect', provider: 'pushinpay', client_secret: 'pushin-token-valido' }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c));
  assert.equal((await fn('payment-integrations', { action: 'connect', provider: 'syncpay', client_id: 'cid-1', client_secret: 'sync-secret-errado' }, A.token)).status, 400);
  assert.equal((await fn('payment-integrations', { action: 'connect', provider: 'syncpay', client_id: 'cid-1', client_secret: 'sync-secret-ok' }, A.token)).status, 200);

  const lead = (await pool.query(`insert into public.leads (organization_id, email, nome) values ($1,$2,'Ana') returning id`, [A.orgId, `pp${stamp}@x.test`])).rows[0].id;
  const pays = createPayments({ pool, providers: { pushinpay: createPushinPay({ fetchImpl: fakeFetch }), syncpay: createSyncPay({ fetchImpl: fakeFetch }) }, secretKey: KEY, publicBaseUrl: 'https://api.kobly.test' });
  const ch = await pays.createCharge({ ex: { id: null, organization_id: A.orgId, campaign_id: null, lead_id: lead }, nodeRef: 'pg', integrationId: c.integration.id, currency: 'BRL', method: 'PIX', amount: 45.9, payer: { name: 'Ana' }, description: 'Guia', externalId: `pp-${stamp}` });
  assert.deepEqual([ch.transaction_id, ch.payment_code, Number(ch.amount)], ['pp-1', '00020101PUSHIN', 45.9]);
  const tok = (await pool.query(`select webhook_token from public.payment_integrations where id = $1`, [c.integration.id])).rows[0].webhook_token;
  const aviso = (status) => fetch(`${base}/webhooks/payments/pushinpay/${tok}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `id=pp-1&status=${status}&value=4590` });
  assert.equal((await aviso('created')).status, 200);
  assert.equal((await pool.query(`select status from public.payment_charges where id = $1`, [ch.id])).rows[0].status, 'pending');
  pushin.get('pp-1').status = 'paid';
  assert.equal((await aviso('paid')).status, 200);
  assert.equal((await pool.query(`select status, paid_amount from public.payment_charges where id = $1`, [ch.id])).rows[0].status, 'confirmed');
});

test('Postback: Cakto e PerfectPay viram eventos e leads (com UTM)', { skip }, async () => {
  const cakto = { secret: 'abc', event: 'pix_gerado', data: { id: `ck-${stamp}`, status: 'waiting_payment', amount: 97, paymentMethod: 'pix', checkoutUrl: 'https://pay.cakto.com.br/X?utm_source=instagram&utm_campaign=lancamento',
    customer: { name: 'Bia Souza', email: `bia${stamp}@x.test`, phone: '11977776666' }, product: { name: 'Mentoria' } } };
  const r1 = await (await post(`/functions/v1/postback-receiver?token=${A.pbk}`, cakto)).json();
  assert.equal(r1.ok, true); assert.equal(r1.ignored, undefined, JSON.stringify(r1));
  const ev = (await pool.query(`select tipo_evento, valor_produto, produto, utm from public.webhook_events where organization_id = $1 and email = $2`, [A.orgId, `bia${stamp}@x.test`])).rows[0];
  assert.deepEqual([ev.tipo_evento, Number(ev.valor_produto), ev.produto, ev.utm], ['Pix Gerado', 97, 'Mentoria', { utm_source: 'instagram', utm_campaign: 'lancamento' }]);
  const perfect = { token: 'x', code: `PPC${stamp}`, sale_amount: 197, payment_type_enum: 1, sale_status_enum: 2, sale_status_detail: 'approved',
    customer: { full_name: 'Caio Reis', email: `caio${stamp}@x.test`, phone_area_code: '21', phone_number: '966665555' }, product: { name: 'Curso' }, metadata: { utm_source: 'google' } };
  const r2 = await (await post(`/functions/v1/postback-receiver?token=${A.pbk}`, perfect)).json();
  assert.equal(r2.ignored, undefined, JSON.stringify(r2));
  const lead = (await pool.query(`select nome, telefone, ultimo_evento, utm from public.leads where organization_id = $1 and email = $2`, [A.orgId, `caio${stamp}@x.test`])).rows[0];
  assert.deepEqual([lead.nome, lead.telefone, lead.ultimo_evento, lead.utm], ['Caio Reis', '21966665555', 'Compra Aprovada', { utm_source: 'google' }]);
  // reentrega do mesmo evento não duplica
  const again = await (await post(`/functions/v1/postback-receiver?token=${A.pbk}`, perfect)).json();
  assert.equal(again.deduped, true);
});
