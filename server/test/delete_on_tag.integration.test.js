// "Apagar mensagem ao aplicar etiqueta": o envio por QR Code guarda o id; a etiqueta (pelo fluxo ou à mão) dispara a exclusão.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/delete_on_tag.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createFlowRuntime } from '../src/flows/runtime.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
let pool, flows;
const A = {};
const sent = [], deleted = [];
let failDelete = false;

const whatsapp = {
  freeTextAllowed: async () => true,
  sendTextTo: async (orgId, a) => { sent.push(a); return { ok: true, id: `uaz-${sent.length}`, to: a.to, channel: 'uazapi', instanceId: A.inst }; },
  sendMediaTo: async (orgId, a) => { sent.push(a); return { ok: true, id: `uaz-${sent.length}`, to: a.to, channel: 'uazapi', instanceId: A.inst }; },
  deleteMessage: async (orgId, a) => { if (failDelete) throw new Error('Uazapi fora do ar'); deleted.push(a.messageId); return { ok: true }; },
};

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  flows = createFlowRuntime({ pool, whatsapp, autoKick: false });
  A.orgId = (await pool.query(`insert into public.organizations (nome) values ('Empresa Apagar') returning id`)).rows[0].id;
  A.inst = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,'Vendas',$2,'x','connected') returning id`, [A.orgId, `del-${stamp}`])).rows[0].id;
  A.tag = (await pool.query(`insert into public.tags (organization_id, nome) values ($1,'Comprou') returning id`, [A.orgId])).rows[0].id;
  A.lead = (await pool.query(`insert into public.leads (organization_id, nome, telefone, email) values ($1,'Ana','5511988887777',$2) returning id`, [A.orgId, `del${stamp}@x.test`])).rows[0].id;
});
after(async () => { if (skip) return; await pool.end(); });

const ex = () => ({ id: null, organization_id: A.orgId, lead_id: A.lead, campaign_id: null, flow_id: null });
const ctx = async () => ({ lead: (await pool.query(`select * from public.leads where id = $1`, [A.lead])).rows[0], vars: {}, agora: new Date() });
const rows = async () => (await pool.query(`select wa_message_id, status from public.flow_message_deletions where lead_id = $1 order by created_at, wa_message_id`, [A.lead])).rows;

test('texto e mídia guardam o id; etiqueta aplicada depois apaga as duas', { skip }, async () => {
  const t = await flows.runNode(ex(), { ref: 't', type: 'send_text', data: { text: 'Oferta só hoje', delete_on_tag: A.tag } }, await ctx());
  assert.equal(t.exit, 'sent', JSON.stringify(t));
  const m = await flows.runNode(ex(), { ref: 'm', type: 'send_media', data: { kind: 'image', url: 'https://cdn.kobly.test/a.png', delete_on_tag: A.tag } }, await ctx());
  assert.equal(m.exit, 'sent', 'QR Code: mídia sem janela de 24 h');
  await flows.runNode(ex(), { ref: 'x', type: 'send_text', data: { text: 'Sem exclusão' } }, await ctx());
  assert.deepEqual((await rows()).map((r) => r.status), ['waiting', 'waiting'], 'só os blocos com a opção');
  assert.equal(await flows.processDeletions(), 0, 'nada a apagar antes da etiqueta');

  await pool.query(`insert into public.lead_tags (lead_id, tag_id) values ($1,$2)`, [A.lead, A.tag]); // como na tela de Leads
  assert.deepEqual((await rows()).map((r) => r.status), ['due', 'due']);
  assert.equal(await flows.processDeletions(), 2);
  assert.deepEqual(deleted.sort(), ['uaz-1', 'uaz-2']);
  assert.deepEqual((await rows()).map((r) => r.status), ['done', 'done']);
});

test('lead que já tem a etiqueta: apaga na próxima volta; falha repete e desiste após 3 tentativas', { skip }, async () => {
  failDelete = true;
  await flows.runNode(ex(), { ref: 't', type: 'send_text', data: { text: 'Outra', delete_on_tag: A.tag } }, await ctx());
  const id = `uaz-${sent.length}`;
  const st = async () => (await pool.query(`select status, attempts, last_error from public.flow_message_deletions where wa_message_id = $1`, [id])).rows[0];
  assert.equal((await st()).status, 'due');
  for (let i = 0; i < 3; i++) {
    await pool.query(`update public.flow_message_deletions set due_at = now() where wa_message_id = $1`, [id]); // pula a espera de 5 min
    await flows.processDeletions();
  }
  const r = await st();
  assert.equal(r.status, 'failed'); assert.equal(r.attempts, 3); assert.match(r.last_error, /fora do ar/);
  failDelete = false;
});

test('etiqueta de outra empresa não é aceita', { skip }, async () => {
  const other = (await pool.query(`insert into public.organizations (nome) values ('Outra') returning id`)).rows[0].id;
  const tag2 = (await pool.query(`insert into public.tags (organization_id, nome) values ($1,'Alheia') returning id`, [other])).rows[0].id;
  const before_ = (await rows()).length;
  await flows.runNode(ex(), { ref: 't', type: 'send_text', data: { text: 'X', delete_on_tag: tag2 } }, await ctx());
  assert.equal((await rows()).length, before_);
});
