// Várias conexões por empresa: dois números da API Oficial, Chat ao vivo separado por rede e por conexão,
// resposta pelo mesmo número da conversa e Gatilho do fluxo só para as conexões marcadas.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/multi_connections.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { createFlowRuntime } from '../src/flows/runtime.js';
import { validateGraph } from '../src/flows/graph.js';
import { parseConnKey } from '../src/workspace/connections.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const APP_SECRET = 'segredo-app-multi';
const stamp = String(Date.now());
const WABA_A = `71${stamp}`.slice(0, 15), PID_A = `72${stamp}`.slice(0, 15);
const WABA_B = `73${stamp}`.slice(0, 15), PID_B = `74${stamp}`.slice(0, 15);
let pool, server, base;
const A = {}, sentGraph = [];

const fakeGraph = {
  getPhoneNumber: async (pid) => ({ display_phone_number: pid === PID_A ? '+55 11 90000-0001' : '+55 11 90000-0002', verified_name: pid === PID_A ? 'Loja Centro' : 'Loja Norte', quality_rating: 'GREEN' }),
  getWaba: async (id) => ({ id, name: 'Loja' }),
  subscribeApp: async () => ({ success: true }),
  listTemplates: async () => [],
  sendText: async (pid, tok, a) => { sentGraph.push({ pid, ...a }); return { messages: [{ id: `wamid.out.${sentGraph.length}` }] }; },
};
const post = (path, body, token, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const fn = async (name, body) => { const r = await post(`/functions/v1/${name}`, body, A.token); return { status: r.status, ...(await r.json()) }; };
const webhook = (waba, pid, from, id, text) => {
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'messages', value: { metadata: { phone_number_id: pid },
    contacts: [{ profile: { name: 'Cliente' }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return post('/webhooks/whatsapp-app', payload, null, { 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}` });
};

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-multi', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'),
    publicBaseUrl: 'https://api.kobly.test', metaAdsAppId: '1550449143065379', metaAdsAppSecret: APP_SECRET, metaWaConfigId: '987654321', metaMsgVerifyToken: 'senha-webhook' };
  ({ server } = createApp({ pool, config, graph: fakeGraph, fetchImpl: async (u) => { throw new Error('rede não esperada: ' + u); } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await (await post('/auth/signup', { email: `multi${stamp}@kobly.test`, password: 'senha-forte-123', nome: 'Loja Multi' })).json();
  A.token = s.session.access_token; A.userId = s.session.user.id;
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role kobly_authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.userId, role: 'kobly_authenticated' })]);
    A.orgId = (await c.query(`select (public.create_own_org('Loja Multi')).id as id`)).rows[0].id; await c.query('commit');
  } finally { c.release(); }
});
after(async () => { if (skip) return; server.close(); await pool.end(); });

test('chave de conexão e validação do Gatilho', () => {
  assert.deepEqual(parseConnKey('uazapi:11111111-1111-1111-1111-111111111111'), { kind: 'uazapi', id: '11111111-1111-1111-1111-111111111111' });
  assert.equal(parseConnKey('whatsapp:x'), null);
  const g = (connections) => ({ version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { source: 'message', mode: 'any', connections }, next: { default: 't' } },
    { ref: 't', type: 'send_text', data: { text: 'oi' }, next: {} }] });
  assert.equal(validateGraph(g(['oficial:11111111-1111-1111-1111-111111111111'])).ok, true);
  assert.ok(validateGraph(g(['qualquer'])).errors.some((e) => /conexões inválidas/.test(e)));
});

test('dois números oficiais: cada conversa fica no seu número e a resposta sai por ele; Chat ao vivo filtra por rede e conexão', { skip }, async () => {
  const a = await fn('whatsapp-account', { action: 'connect', waba_id: WABA_A, phone_number_id: PID_A, access_token: 'token-numero-a-0123456789' });
  const b = await fn('whatsapp-account', { action: 'connect', waba_id: WABA_B, phone_number_id: PID_B, access_token: 'token-numero-b-0123456789' });
  assert.equal(a.status, 200, JSON.stringify(a)); assert.equal(b.status, 200, JSON.stringify(b));
  const st = await fn('whatsapp-account', { action: 'status' });
  assert.equal(st.accounts.length, 2, 'os dois números ficam conectados');
  const accA = st.accounts.find((x) => x.phone_number_id === PID_A), accB = st.accounts.find((x) => x.phone_number_id === PID_B);
  // cada número recebe de um cliente diferente
  assert.equal((await webhook(WABA_A, PID_A, '5511911110001', `wamid.a.${stamp}`, 'Oi pelo centro')).status, 200);
  assert.equal((await webhook(WABA_B, PID_B, '5511922220002', `wamid.b.${stamp}`, 'Oi pelo norte')).status, 200);
  const all = await fn('inbox', { action: 'list' });
  const ca = all.conversations.find((x) => x.telefone === '5511911110001'), cb = all.conversations.find((x) => x.telefone === '5511922220002');
  assert.equal(ca.conn_kind, 'oficial'); assert.equal(ca.conn_id, accA.id);
  assert.equal(cb.conn_kind, 'oficial'); assert.equal(cb.conn_id, accB.id);
  assert.ok(all.conexoes.some((x) => x.key === `oficial:${accA.id}` && x.nome === 'Loja Centro'));
  const soB = await fn('inbox', { action: 'list', conexao: `oficial:${accB.id}` });
  assert.deepEqual(soB.conversations.map((x) => x.telefone), ['5511922220002']);
  assert.equal((await fn('inbox', { action: 'list', rede: 'instagram' })).conversations.length, 0);
  assert.equal((await fn('inbox', { action: 'list', rede: 'whatsapp' })).conversations.length, 2);
  // responder pelo chat sai pelo número em que a pessoa escreveu
  const r = await fn('inbox', { action: 'send', lead_id: cb.lead_id, text: 'Olá do norte' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(sentGraph.at(-1).pid, PID_B);
  const out = (await pool.query(`select account_id from public.whatsapp_outbound_messages where lead_id = $1 order by created_at desc limit 1`, [cb.lead_id])).rows[0];
  assert.equal(out.account_id, accB.id);
  // desconectar um número não derruba o outro
  await fn('whatsapp-account', { action: 'disconnect', account_id: accA.id });
  assert.deepEqual((await fn('whatsapp-account', { action: 'status' })).accounts.map((x) => x.phone_number_id), [PID_B]);
});

test('Gatilho só vale para as conexões marcadas e a execução fala pela conexão em que começou', { skip }, async () => {
  const org = (await pool.query(`insert into public.organizations (nome) values ('Chips') returning id`)).rows[0].id;
  const inst = async (label) => (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,$2,$3,'x','connected') returning id`, [org, label, `${label}-${stamp}`])).rows[0].id;
  const i1 = await inst('chip1'), i2 = await inst('chip2');
  const sent = [];
  const flows = createFlowRuntime({ pool, autoKick: false, whatsapp: { freeTextAllowed: async () => true, sendTextTo: async (o, a) => { sent.push(a); return { ok: true, id: `x${sent.length}`, to: a.to, channel: 'uazapi', instanceId: a.via && a.via.id }; } } });
  const graph = { version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { source: 'message', mode: 'any', connections: [`uazapi:${i1}`] }, next: { default: 't' } },
    { ref: 't', type: 'send_text', data: { text: 'Bem-vindo ao chip 1' }, next: {} }] };
  const camp = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,'Chip 1','Ativa') returning id`, [org])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [camp, org])).rows[0].id;
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`, [org, f, JSON.stringify(graph)]);
  const inbound = (instanceId, from, id) => flows.onInbound({ orgId: org, accountId: null, instanceId, message: { id, from, type: 'text', text: { body: 'oi' } }, contacts: [] });
  await inbound(i2, '5521933330003', `m2-${stamp}`); // chegou pelo chip 2: não começa
  await inbound(i1, '5521944440004', `m1-${stamp}`); // chegou pelo chip 1: começa
  const ex = (await pool.query(`select variables from public.flow_executions where campaign_id = $1`, [camp])).rows;
  assert.equal(ex.length, 1);
  assert.equal(ex[0].variables._conexao, `uazapi:${i1}`);
  await flows.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].via, { kind: 'uazapi', id: i1 });
  assert.equal(sent[0].to, '5521944440004');
  // disparo/checkout (não começou por mensagem) fala pela 1ª conexão de WhatsApp marcada
  const lead = (await pool.query(`insert into public.leads (organization_id, nome, telefone) values ($1,'Ana','5521955550005') returning id`, [org])).rows[0].id;
  const r = await flows.startForLead({ orgId: org, campaignId: camp, leadId: lead });
  assert.equal(r.started !== false, true, JSON.stringify(r));
  const v = (await pool.query(`select variables from public.flow_executions where campaign_id = $1 and lead_id = $2`, [camp, lead])).rows[0].variables;
  assert.equal(v._conexao, `uazapi:${i1}`);
});
