// API pública: chave da empresa (só em hash), validar, listar números e fluxos, disparar um fluxo com variáveis.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/public_api.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPublicApi } from '../src/publicapi/service.js';
import { createFlowRuntime } from '../src/flows/runtime.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
let pool, api;
const A = {};

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const flows = createFlowRuntime({ pool, whatsapp: {}, autoKick: false });
  api = createPublicApi({ pool, flows });
  A.org = (await pool.query(`insert into public.organizations (nome) values ('Loja API ${stamp}') returning id`)).rows[0].id;
  A.outra = (await pool.query(`insert into public.organizations (nome) values ('Outra ${stamp}') returning id`)).rows[0].id;
  await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status, phone) values ($1,'Vendas',$2,'x','connected','5511999990000')`, [A.org, `api-${stamp}`]);
  A.camp = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,'Pós-venda','Ativa') returning id`, [A.org])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [A.camp, A.org])).rows[0].id;
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`,
    [A.org, f, JSON.stringify({ version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: {} }] })]);
  A.campOutra = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'De outra') returning id`, [A.outra])).rows[0].id;
});
after(async () => { if (!skip) await pool.end(); });

const call = (method, path, key, body) => api.handleHttp(method, path, key ? { authorization: `Bearer ${key}` } : {}, body ? JSON.stringify(body) : '');

test('chave: criar (aparece uma vez), validar, listar números e fluxos, revogar', { skip }, async () => {
  await assert.rejects(api.handleKeys({ orgId: A.org, role: 'Suporte' }, { action: 'create' }), /não pode/);
  const k = await api.handleKeys({ orgId: A.org, role: 'Cliente' }, { action: 'create', label: 'Checkout X' });
  assert.match(k.key, /^kbk_/); A.key = k.key;
  const list = await api.handleKeys({ orgId: A.org, role: 'Cliente' }, { action: 'list' });
  assert.equal(list.keys.length, 1); assert.equal(JSON.stringify(list).includes(k.key), false, 'a chave não volta na lista');
  assert.equal((await call('GET', '/me', 'kbk_errada_errada_errada_errada_errada')).status, 401);
  const me = await call('GET', '/me', A.key);
  assert.equal(me.status, 200); assert.equal(me.body.organization.id, A.org);
  const inst = await call('GET', '/instances', A.key);
  assert.equal(inst.body.instances[0].telefone, '5511999990000'); assert.equal(inst.body.instances[0].conectado, true);
  const fl = await call('GET', '/flows', A.key);
  assert.deepEqual(fl.body.flows.map((f) => f.nome), ['Pós-venda']);
  assert.equal((await api.handleHttp('GET', '/me', { 'x-api-key': A.key }, '')).status, 200, 'também aceita X-Api-Key');
});

test('disparar fluxo: cria o lead, guarda as variáveis e não repete quem já está no fluxo', { skip }, async () => {
  const bad = await call('POST', `/flows/${A.camp}/trigger`, A.key, { phone: '123' });
  assert.equal(bad.status, 422);
  const r = await call('POST', `/flows/${A.camp}/trigger`, A.key, { phone: '(11) 98765-4321', name: 'Maria', email: 'maria@x.test', variables: { produto: 'Curso X', valor: 97 } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true);
  const lead = (await pool.query(`select nome, telefone, email from public.leads where id = $1`, [r.body.lead_id])).rows[0];
  assert.deepEqual(lead, { nome: 'Maria', telefone: '5511987654321', email: 'maria@x.test' });
  const ex = (await pool.query(`select variables from public.flow_executions where lead_id = $1`, [r.body.lead_id])).rows[0];
  assert.equal(ex.variables.produto, 'Curso X'); assert.equal(ex.variables.valor, '97'); assert.equal(ex.variables.evento_tipo, 'API');
  const again = await call('POST', `/flows/${A.camp}/trigger`, A.key, { phone: '5511987654321' });
  assert.equal(again.status, 409); assert.equal(again.body.lead_id, r.body.lead_id);
  assert.equal((await call('POST', `/flows/${A.campOutra}/trigger`, A.key, { phone: '5511900000000' })).status, 404, 'fluxo de outra empresa');
  assert.equal((await call('POST', `/flows/${A.camp}/trigger`, A.key, { phone: '5511900000001', variables: { 'Nome Ruim': 1 } })).status, 422);
  const k = (await api.handleKeys({ orgId: A.org, role: 'Cliente' }, { action: 'list' })).keys[0];
  await api.handleKeys({ orgId: A.org, role: 'Cliente' }, { action: 'revoke', id: k.id });
  assert.equal((await call('GET', '/me', A.key)).status, 401, 'chave revogada para de funcionar');
});
