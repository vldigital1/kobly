// Disparo em massa no servidor: fluxo, mensagem de WhatsApp e e-mail; filtro e lista colada; ritmo e cancelamento.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/bulk.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBulk, parseManualList } from '../src/bulk/service.js';
import { createFlowRuntime } from '../src/flows/runtime.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
let pool, bulk;
const A = {};
const zap = [], mails = [];
const whatsapp = { sendTextTo: async (org, a) => { zap.push(a); return { ok: true, id: `w${zap.length}` }; }, freeTextAllowed: async () => true };
const email = { send: async (org, a) => { mails.push(a); return { ok: true, id: `e${mails.length}` }; } };

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const flows = createFlowRuntime({ pool, whatsapp, email, autoKick: false });
  bulk = createBulk({ pool, whatsapp, email, flows });
  A.org = (await pool.query(`insert into public.organizations (nome) values ('Loja Disparo') returning id`)).rows[0].id;
  A.tag = (await pool.query(`insert into public.tags (organization_id, nome) values ($1,'VIP') returning id`, [A.org])).rows[0].id;
  A.l1 = (await pool.query(`insert into public.leads (organization_id, nome, telefone, email) values ($1,'Ana Souza','5511911110000',$2) returning id`, [A.org, `ana${stamp}@x.test`])).rows[0].id;
  A.l2 = (await pool.query(`insert into public.leads (organization_id, nome, telefone, whatsapp_opt_out) values ($1,'Bia','5511922220000',true) returning id`, [A.org])).rows[0].id;
  await pool.query(`insert into public.lead_tags (lead_id, tag_id) values ($1,$2)`, [A.l1, A.tag]);
  A.camp = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'Fluxo boas-vindas') returning id`, [A.org])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [A.camp, A.org])).rows[0].id;
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`,
    [A.org, f, JSON.stringify({ version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: {} }] })]);
  A.email = (await pool.query(`insert into public.emails (organization_id, titulo, assunto, corpo_html) values ($1,'Novidade','Oi {{primeiro_nome}}','<p>Olá {{nome}}</p>') returning id`, [A.org])).rows[0].id;
});
after(async () => { if (skip) return; await pool.end(); });

const ctx = () => ({ orgId: A.org, role: 'Cliente' });
const run = async () => { for (let i = 0; i < 5; i++) await pool.query(`update public.bulk_send_recipients set run_at = now() where status = 'pendente'`).then(() => bulk.tick(50)); };

test('lista colada: nome, telefone e e-mail em qualquer ordem; repetidos e linhas sem contato saem', () => {
  const l = parseManualList('Carla, (11) 98888-7777, carla@x.com\nbia@x.com; Bia\n11988887777\nsó um nome\n+52 55 1234 5678');
  assert.deepEqual(l, [
    { nome: 'Carla', telefone: '5511988887777', email: 'carla@x.com' },
    { nome: 'Bia', telefone: '', email: 'bia@x.com' },
    { nome: '', telefone: '525512345678', email: '' },
  ]);
});

test('mensagem de WhatsApp para uma etiqueta: variáveis, ritmo e quem pediu para sair fica de fora', { skip }, async () => {
  assert.equal((await bulk.handle(ctx(), {}, { action: 'estimate', modo: 'whatsapp', filtro: {} })).total, 1, 'Bia pediu para não receber');
  const r = await bulk.handle(ctx(), {}, { action: 'create', modo: 'whatsapp', texto: 'Oi {{primeiro_nome}}!', filtro: { tag_ids: [A.tag] }, rate_por_min: 30 });
  assert.equal(r.total, 1);
  await run();
  assert.deepEqual(zap.at(-1), { to: '5511911110000', text: 'Oi Ana!' });
  const st = await bulk.handle(ctx(), {}, { action: 'status', id: r.id });
  assert.equal(st.status, 'concluido'); assert.equal(st.enviados, 1);
});

test('fluxo para uma lista colada: cria o lead novo e coloca no fluxo publicado', { skip }, async () => {
  const r = await bulk.handle(ctx(), {}, { action: 'create', modo: 'fluxo', campaign_id: A.camp, origem: 'manual', lista: `Ana, 11911110000\nCarlos Lima, 11933334444, carlos${stamp}@x.test` });
  assert.equal(r.total, 2);
  await run();
  const ex = (await pool.query(`select count(*)::int as n from public.flow_executions where campaign_id = $1`, [A.camp])).rows[0].n;
  assert.equal(ex, 2, 'Ana (já existia) e Carlos (criado)');
  assert.equal((await pool.query(`select count(*)::int as n from public.leads where organization_id = $1 and nome = 'Carlos Lima'`, [A.org])).rows[0].n, 1);
  const again = await bulk.handle(ctx(), {}, { action: 'create', modo: 'fluxo', campaign_id: A.camp, origem: 'manual', lista: '11911110000' });
  await run();
  assert.equal((await bulk.handle(ctx(), {}, { action: 'status', id: again.id })).pulados, 1, 'quem já está no fluxo não entra de novo');
});

test('e-mail escolhido, fluxo não publicado recusado, cancelar para o resto', { skip }, async () => {
  const r = await bulk.handle(ctx(), {}, { action: 'create', modo: 'email', email_id: A.email, filtro: {} });
  await run();
  assert.equal(mails.at(-1).subject, 'Oi Ana'); assert.match(mails.at(-1).html, /Olá Ana Souza/);
  const naoPub = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'Rascunho') returning id`, [A.org])).rows[0].id;
  await assert.rejects(bulk.handle(ctx(), {}, { action: 'create', modo: 'fluxo', campaign_id: naoPub, filtro: {} }), /ainda não foi publicado/);
  const longo = await bulk.handle(ctx(), {}, { action: 'create', modo: 'whatsapp', texto: 'x', origem: 'manual', lista: '11900000001\n11900000002\n11900000003', rate_por_min: 1 });
  await bulk.handle(ctx(), {}, { action: 'cancel', id: longo.id });
  const st = await bulk.handle(ctx(), {}, { action: 'status', id: longo.id });
  assert.equal(st.status, 'cancelado'); assert.equal(st.pulados, 3);
  assert.equal((await bulk.handle(ctx(), {}, { action: 'list' })).sends.length >= 4, true);
  await assert.rejects(bulk.handle({ orgId: A.org, role: 'Suporte' }, {}, { action: 'create', modo: 'whatsapp', texto: 'x', filtro: {} }), /não pode disparar/);
  assert.ok(r.id);
});
