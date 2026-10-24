// Equipe/convites, trava do atendente, Produtos, UTM no postback e envio à UTMify contra um Postgres
// de TESTE com o esquema do Kobly. Só a rede (UTMify) é simulada.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/team_tracking.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { createUtmify, UTMIFY_URL } from '../src/tracking/utmify.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
let pool, server, base;
const utmifyCalls = [];
const A = {}, B = {}, AT = {};
const stamp = Date.now();

async function fakeFetch(url, init = {}) {
  if (String(url) === UTMIFY_URL) {
    const tok = init.headers['x-api-token'];
    utmifyCalls.push({ tok, body: JSON.parse(init.body) });
    if (tok !== 'utmify-token-valido-123456') return { ok: false, status: 404, json: async () => ({ message: 'API_CREDENTIAL_NOT_FOUND' }) };
    return { ok: true, status: 200, json: async () => ({ OK: true }) };
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
async function signup(who, nome) {
  const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
  who.token = s.session.access_token; who.userId = s.session.user.id;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'), publicBaseUrl: 'https://api.kobly.test' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, nome] of [[A, 'Empresa TT A'], [B, 'Empresa TT B']]) {
    await signup(who, nome);
    who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
  }
  // atendente da empresa A (montado pelo servidor, como o convite faria)
  await signup(AT, 'Atendente TT');
  await pool.query(`update public.profiles set organization_id = $2, team_role = 'atendente' where auth_id = $1`, [AT.userId, A.orgId]);
  A.pbk = (await pool.query(`insert into public.postback_tokens (organization_id, nome) values ($1,'Checkout') returning token`, [A.orgId])).rows[0].token;
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('equipe: convite, papel, trava do atendente e remoção', { skip }, async () => {
  const list = await fn('team', { action: 'list' }, A.token);
  assert.equal(list.can_manage, true);
  assert.deepEqual(list.members.map((m) => [m.dono, m.team_role]).sort(), [[false, 'atendente'], [true, 'admin']]);
  const atId = list.members.find((m) => !m.dono).id;

  const inv = await fn('team', { action: 'invite', email: `novo${stamp}@kobly.test`, nome: 'Novo', team_role: 'admin' }, A.token);
  assert.equal(inv.status, 200, JSON.stringify(inv)); assert.match(inv.access_link, /type=recovery&token=/, 'sem provedor de e-mail, o link volta para repassar');
  const novo = (await fn('team', { action: 'list' }, A.token)).members.find((m) => m.email === `novo${stamp}@kobly.test`);
  assert.equal(novo.convite_pendente, true); assert.equal(novo.team_role, 'admin');
  assert.equal((await fn('team', { action: 'invite', email: `empresattb${stamp}@kobly.test` }, A.token)).status, 409, 'e-mail de outra empresa não é puxado');
  assert.equal((await fn('team', { action: 'invite', email: `x${stamp}@kobly.test` }, B.token)).status, 200, 'B convida na própria empresa');
  assert.equal((await fn('team', { action: 'set_role', profile_id: atId, team_role: 'admin' }, B.token)).status, 404, 'B não mexe na equipe de A');

  // atendente: conversa sim, configura não (inclusive pelo PostgREST no próprio perfil)
  assert.equal((await fn('inbox', { action: 'list' }, AT.token)).status, 200);
  assert.equal((await fn('workspace-settings', { action: 'get' }, AT.token)).status, 200);
  assert.equal((await fn('workspace-settings', { action: 'upsert', kind: 'global_var', item: { key: 'x', value: '1' } }, AT.token)).status, 403);
  assert.equal((await fn('payment-integrations', { action: 'list' }, AT.token)).status, 403);
  assert.equal((await fn('team', { action: 'invite', email: `y${stamp}@kobly.test` }, AT.token)).status, 403);
  await asUser(AT.userId, `update public.profiles set team_role = 'admin' where auth_id = auth.uid()`).catch(() => {});
  assert.equal((await pool.query(`select team_role from public.profiles where auth_id = $1`, [AT.userId])).rows[0].team_role, 'atendente', 'ninguém se promove sozinho');

  const dono = list.members.find((m) => m.dono).id;
  assert.equal((await fn('team', { action: 'remove', profile_id: dono }, A.token)).status, 409, 'dono não sai');
  assert.equal((await fn('team', { action: 'set_role', profile_id: atId, team_role: 'admin' }, A.token)).status, 200);
  assert.equal((await fn('payment-integrations', { action: 'list' }, AT.token)).status, 200, 'promovido a admin, configura');
  assert.equal((await fn('team', { action: 'remove', profile_id: atId }, A.token)).status, 200);
  assert.equal((await fn('inbox', { action: 'list', org_id: A.orgId }, AT.token)).status, 403, 'removido perde o acesso na hora');
});

test('produtos: catálogo com apelidos, números por produto e sugestões do checkout', { skip }, async () => {
  for (const [ev, prod, val] of [['pix_generated', 'Guia MX', 45], ['payment_approved', 'GUIA-MX-01', 45], ['pix_generated', 'Curso Novo', 197]]) {
    const r = await post(`/functions/v1/postback-receiver?token=${A.pbk}`, { event: ev, email: `p${prod.length}${val}@cliente.test`, name: 'Cliente', product: prod, value: val });
    assert.equal(r.status, 200);
  }
  let l = await fn('products', { action: 'list' }, A.token);
  assert.deepEqual(l.seen.map((s) => s.nome).sort(), ['Curso Novo', 'GUIA-MX-01', 'Guia MX']);
  const up = await fn('products', { action: 'upsert', item: { nome: 'Guia MX', aliases: ['GUIA-MX-01'], preco: '45,00', moeda: 'mxn' } }, A.token);
  assert.equal(up.status, 200, JSON.stringify(up)); assert.equal(up.item.moeda, 'MXN'); assert.equal(Number(up.item.preco), 45);
  assert.equal((await fn('products', { action: 'upsert', item: { nome: 'guia mx' } }, A.token)).status, 409);
  assert.equal((await fn('products', { action: 'upsert', item: { nome: 'X', checkout_url: 'http://inseguro' } }, A.token)).status, 422);
  l = await fn('products', { action: 'list' }, A.token);
  const g = l.products.find((p) => p.nome === 'Guia MX');
  assert.equal(g.eventos_abandono, 1); assert.equal(g.aprovadas, 1, 'apelido casa com o ID do checkout');
  assert.deepEqual(l.seen.map((s) => s.nome), ['Curso Novo']);
  assert.equal((await fn('products', { action: 'list' }, B.token)).products.length, 0);
  assert.equal((await asUser(B.userId, `select id from public.products`)).rowCount, 0, 'RLS');
});

test('trackeamento: UTM do postback no lead (1º toque) e relatório por origem', { skip }, async () => {
  const email = `utm${stamp}@cliente.test`;
  await post(`/functions/v1/postback-receiver?token=${A.pbk}`, { event: 'pix_generated', email, name: 'Ana', value: 97, TrackingParameters: { utm_source: 'facebook', utm_campaign: 'black' } });
  await post(`/functions/v1/postback-receiver?token=${A.pbk}`, { event: 'payment_approved', email, name: 'Ana', value: 97, utm_source: 'google' });
  const lead = (await pool.query(`select utm from public.leads where organization_id = $1 and email = $2`, [A.orgId, email])).rows[0];
  assert.deepEqual(lead.utm, { utm_source: 'facebook', utm_campaign: 'black' }, 'lead guarda o primeiro toque');
  assert.equal((await pool.query(`select count(*)::int n from public.webhook_events where organization_id = $1 and utm->>'utm_source' = 'google'`, [A.orgId])).rows[0].n, 1, 'evento guarda o seu próprio UTM');
  const rep = await fn('tracking', { action: 'report', group_by: 'utm_source', days: 30 }, A.token);
  const fb = rep.rows.find((r) => r.origem === 'facebook');
  assert.deepEqual([fb.leads, fb.abandonos, fb.aprovadas, fb.receita_checkout], [1, 1, 1, 97]);
  assert.ok(rep.rows.some((r) => r.origem === '(sem UTM)'));
  assert.equal((await fn('tracking', { action: 'report', group_by: 'drop table' }, A.token)).group_by, 'utm_source', 'agrupamento fora da lista vira utm_source');
});

test('UTMify: credencial testada ao conectar; cobrança do fluxo vira pedido e depois pago', { skip }, async () => {
  assert.equal((await fn('tracking', { action: 'connect_utmify', token: 'token-errado-1234567890' }, A.token)).status, 400);
  const ok = await fn('tracking', { action: 'connect_utmify', token: 'utmify-token-valido-123456' }, A.token);
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(utmifyCalls.at(-1).body.isTest, true, 'conexão manda pedido de teste (não grava na UTMify)');
  await assert.rejects(asUser(A.userId, `select token_enc from public.tracking_integrations`), /permission denied/);
  assert.equal((await fn('tracking', { action: 'get' }, A.token)).integrations[0].token_hint, '…3456');

  const lead = (await pool.query(`select id from public.leads where organization_id = $1 and utm is not null limit 1`, [A.orgId])).rows[0];
  const integ = (await pool.query(`insert into public.payment_integrations (organization_id, provider, label, client_id, secret_enc, webhook_token) values ($1,'xpag','t','cid','x',$2) returning id`, [A.orgId, `wh${stamp}`])).rows[0];
  const charge = (await pool.query(`insert into public.payment_charges (organization_id, integration_id, lead_id, provider, external_id, currency, method, amount) values ($1,$2,$3,'xpag',$4,'MXN','SPEI',45) returning *`,
    [A.orgId, integ.id, lead.id, `ext${stamp}`])).rows[0];
  const utmify = createUtmify({ pool, secretKey: KEY, fetchImpl: fakeFetch });
  assert.equal((await utmify.onCharge(charge, 'waiting_payment')).ok, true);
  const o = utmifyCalls.at(-1).body;
  assert.equal(o.orderId, `kobly-${charge.id}`); assert.equal(o.status, 'waiting_payment'); assert.equal(o.trackingParameters.utm_source, 'facebook');
  assert.equal(o.commission.currency, 'MXN'); assert.equal(o.isTest, undefined);
  await utmify.onCharge({ ...charge, status: 'confirmed', confirmed_at: new Date(), paid_amount: 45 }, 'paid');
  assert.equal(utmifyCalls.at(-1).body.status, 'paid');
  assert.equal((await pool.query(`select tracking_status from public.payment_charges where id = $1`, [charge.id])).rows[0].tracking_status, 'paid');
  // empresa sem UTMify: nada sai
  const n = utmifyCalls.length;
  assert.equal((await utmify.onCharge({ ...charge, organization_id: B.orgId }, 'paid')).skipped, 'sem UTMify');
  assert.equal(utmifyCalls.length, n);
});
