// Pipeline e Leads: cartão com foto, etiquetas e última mensagem; tabela com filtros e páginas; números do topo;
// ficha com linha do tempo; planilha; etiqueta em lote.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/pipeline_leads.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPipeline } from '../src/workspace/pipeline.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
let pool, pipe;
const A = {};
const ctx = () => ({ orgId: A.orgId, role: 'Cliente' });

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  pipe = createPipeline({ pool });
  A.orgId = (await pool.query(`insert into public.organizations (nome) values ('Loja Pipeline') returning id`)).rows[0].id;
  A.inst = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,'Vendas',$2,'x','connected') returning id`, [A.orgId, `pl-${Date.now()}`])).rows[0].id;
  const lead = async (nome, tel, utm, valor) => (await pool.query(`insert into public.leads (organization_id, nome, telefone, utm, valor_compra, avatar_url) values ($1,$2,$3,$4,$5,$6) returning id`,
    [A.orgId, nome, tel, utm ? JSON.stringify({ utm_source: utm }) : null, valor, nome === 'Ana' ? 'https://pps.whatsapp.net/ana.jpg' : null])).rows[0].id;
  A.ana = await lead('Ana', '5511911110001', 'whatsapp', null);
  A.bia = await lead('Bia', '5511911110002', 'facebook', 197);
  A.caio = await lead('Caio', '5511911110003', null, null);
  await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, instance_id, wa_message_id, from_phone, lead_id, msg_type, body, received_at) values ($1,$2,$3,'5511911110001',$4,'audio','[áudio]', now())`, [A.orgId, A.inst, `pl-a-${Date.now()}`, A.ana]);
  await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, created_at) values ($1,$2,'5511911110002','fluxo','Oi Bia!', now())`, [A.orgId, A.bia]);
  A.tag = (await pool.query(`insert into public.tags (organization_id, nome) values ($1,'VIP') returning id`, [A.orgId])).rows[0].id;
  await pool.query(`insert into public.lead_tags (lead_id, tag_id) values ($1,$2)`, [A.ana, A.tag]);
});
after(async () => { if (skip) return; await pool.end(); });

test('pipeline: cartão com foto, etiquetas, origem e a última mensagem; filtro por número de WhatsApp', { skip }, async () => {
  const b = await pipe.handle(ctx(), {}, { action: 'board' });
  const ana = b.columns.respondeu.leads.find((l) => l.id === A.ana);
  assert.equal(ana.avatar_url, 'https://pps.whatsapp.net/ana.jpg');
  assert.deepEqual(ana.tags.map((t) => t.nome), ['VIP']);
  assert.deepEqual(ana.ultima_msg, { body: '[áudio]', tipo: 'audio', de: 'lead' });
  assert.equal(ana.origem, 'whatsapp');
  assert.equal(b.columns.contato.leads.find((l) => l.id === A.bia).ultima_msg.de, 'fluxo');
  const only = await pipe.handle(ctx(), {}, { action: 'board', instance_id: A.inst });
  assert.equal(Object.values(only.columns).reduce((n, c) => n + c.total, 0), 1, 'só quem conversou por esse número');
});

test('leads: etapa, origem, etiqueta, ordem e páginas; números do topo', { skip }, async () => {
  assert.equal((await pipe.handle(ctx(), {}, { action: 'leads' })).total, 3);
  assert.deepEqual((await pipe.handle(ctx(), {}, { action: 'leads', stage: 'novo' })).leads.map((l) => l.nome), ['Caio']);
  assert.deepEqual((await pipe.handle(ctx(), {}, { action: 'leads', origem: 'facebook' })).leads.map((l) => l.nome), ['Bia']);
  assert.deepEqual((await pipe.handle(ctx(), {}, { action: 'leads', origem: '_sem' })).leads.map((l) => l.nome), ['Caio']);
  assert.deepEqual((await pipe.handle(ctx(), {}, { action: 'leads', tag_id: A.tag })).leads.map((l) => l.nome), ['Ana']);
  assert.equal((await pipe.handle(ctx(), {}, { action: 'leads', order: 'valor' })).leads[0].nome, 'Bia');
  const p2 = await pipe.handle(ctx(), {}, { action: 'leads', order: 'nome', limit: 10, offset: 2 });
  assert.deepEqual(p2.leads.map((l) => l.nome), ['Caio']); assert.equal(p2.total, 3);
  const s = await pipe.handle(ctx(), {}, { action: 'stats' });
  assert.equal(s.total, 3); assert.equal(s.novos7, 3); assert.equal(s.responderam, 1);
  assert.deepEqual(s.origens.map((o) => o.origem).sort(), ['_sem', 'facebook', 'whatsapp']);
});

test('ficha: dados, contagens e linha do tempo; planilha; etiqueta em lote', { skip }, async () => {
  const d = await pipe.handle(ctx(), {}, { action: 'detail', lead_id: A.ana });
  assert.equal(d.lead.nome, 'Ana'); assert.equal(d.counts.recebidas, 1);
  assert.deepEqual(d.timeline.map((t) => t.kind).sort(), ['criado', 'recebida']);
  await assert.rejects(pipe.handle({ orgId: A.orgId, role: 'Cliente' }, {}, { action: 'detail', lead_id: '00000000-0000-0000-0000-000000000000' }), /não encontrado/);
  const csv = await pipe.handle(ctx(), {}, { action: 'export', lead_ids: [A.bia] });
  assert.equal(csv.count, 1); assert.match(csv.csv, /^Nome;Telefone/); assert.match(csv.csv, /Bia;5511911110002/);
  const r = await pipe.handle(ctx(), {}, { action: 'tag_bulk', lead_ids: [A.bia, A.caio], tag_id: A.tag });
  assert.equal(r.changed, 2);
  assert.equal((await pipe.handle(ctx(), {}, { action: 'leads', tag_id: A.tag })).total, 3);
  await pipe.handle(ctx(), {}, { action: 'tag_bulk', lead_ids: [A.caio], tag_id: A.tag, remove: true });
  assert.equal((await pipe.handle(ctx(), {}, { action: 'leads', tag_id: A.tag })).total, 2);
  await assert.rejects(pipe.handle({ orgId: A.orgId, role: 'Suporte' }, {}, { action: 'tag_bulk', lead_ids: [A.bia], tag_id: A.tag }), /não pode/);
});
