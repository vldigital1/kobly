// Bloco "Enviar e-mail" dos fluxos: mesmo envio das campanhas (Resend simulado na rede; banco de verdade).
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/email_block.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createFlowRuntime } from '../src/flows/runtime.js';
import { createFlowEmail } from '../src/email/flowEmail.js';
import { verifyUnsubToken } from '../src/unsubscribe.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
let pool, flows;
const A = {};
const sent = [];
let reply = { status: 200, body: { id: 're_1' } };

async function fakeFetch(url, init) {
  assert.equal(String(url), 'https://api.resend.com/emails');
  sent.push({ ...JSON.parse(init.body), auth: init.headers.Authorization });
  return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const email = createFlowEmail({ pool, apiKey: 're_test_key', platformFrom: 'Kobly <envio@kobly.test>', sendingDomain: 'envio.kobly.test', unsubSecret: 'segredo-unsub', publicBaseUrl: 'https://api.kobly.test', fetchImpl: fakeFetch });
  flows = createFlowRuntime({ pool, whatsapp: {}, email, autoKick: false });
  A.orgId = (await pool.query(`insert into public.organizations (nome, sender_local) values ('Loja E-mail', 'loja-email') returning id`)).rows[0].id;
  A.campaign = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'Funil e-mail') returning id`, [A.orgId])).rows[0].id;
  A.email = (await pool.query(`insert into public.emails (organization_id, titulo, assunto, remetente, corpo_html) values ($1,'Recuperação','Oi {{primeiro_nome}}, seu {{produto}} espera','Loja "Top"',
    '<p>Olá {{nome}}</p><a href="{{cta_link}}">Pagar</a> <a href="#" style="x">Descadastrar</a> {{unsubscribe_url}}') returning id`, [A.orgId])).rows[0].id;
  A.lead = (await pool.query(`insert into public.leads (organization_id, nome, email, produto, link_recuperacao) values ($1,'<b>Ana</b> Souza',$2,'Curso','https://pay.kobly.test/x') returning id`, [A.orgId, `ana${stamp}@x.test`])).rows[0].id;
  A.semEmail = (await pool.query(`insert into public.leads (organization_id, nome, telefone) values ($1,'Bia','5511999990000') returning id`, [A.orgId])).rows[0].id;
});
after(async () => { if (skip) return; await pool.end(); });

const ex = (lead = A.lead) => ({ id: null, organization_id: A.orgId, lead_id: lead, campaign_id: A.campaign, flow_id: null });
const ctx = async (lead = A.lead) => ({ lead: (await pool.query(`select * from public.leads where id = $1`, [lead])).rows[0], vars: {}, agora: new Date(), ctaLink: 'https://pay.kobly.test/x', brand: { nome: 'Loja' } });
const node = (email_id = A.email) => ({ ref: 'em', type: 'send_email', data: { email_id } });

test('envia com remetente da empresa, variáveis, descadastro e métricas', { skip }, async () => {
  const r = await flows.runNode(ex(), node(), await ctx());
  assert.equal(r.exit, 'default', JSON.stringify(r));
  const m = sent.at(-1);
  assert.equal(m.from, 'Loja Top <loja-email@envio.kobly.test>', 'aspas do nome saem; subdomínio da plataforma');
  assert.equal(m.subject, 'Oi <b>Ana</b>, seu Curso espera', 'assunto é texto puro');
  assert.match(m.html, /Olá &lt;b&gt;Ana&lt;\/b&gt; Souza/, 'nome do lead escapado no HTML');
  assert.match(m.html, /href="https:\/\/pay\.kobly\.test\/x"/);
  const link = /href="(https:\/\/api\.kobly\.test\/functions\/v1\/unsubscribe\?token=[^"]+)"[^>]*>Descadastrar/.exec(m.html);
  assert.ok(link, 'rodapé "Descadastrar" aponta para o link assinado');
  assert.ok(!m.html.includes('{{unsubscribe_url}}'));
  assert.ok(verifyUnsubToken('segredo-unsub', new URL(link[1]).searchParams.get('token')));
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const ev = (await pool.query(`select channel, status, sg_message_id from public.email_events where organization_id = $1`, [A.orgId])).rows;
  assert.deepEqual(ev, [{ channel: 'email', status: 'enviado', sg_message_id: 're_1' }]);
  assert.equal((await pool.query(`select emails_enviados from public.campaign_stats where campaign_id = $1`, [A.campaign])).rows[0].emails_enviados, 1);
});

test('lead sem e-mail ou descadastrado: segue o fluxo sem enviar', { skip }, async () => {
  const n = sent.length;
  assert.match((await flows.runNode(ex(A.semEmail), node(), await ctx(A.semEmail))).detail, /sem e-mail/);
  await pool.query(`insert into public.email_suppressions (organization_id, email, reason) values ($1,$2,'unsubscribe')`, [A.orgId, `ana${stamp}@x.test`]);
  const r = await flows.runNode(ex(), node(), await ctx());
  assert.equal(r.exit, 'default'); assert.match(r.detail, /descadastrado/);
  assert.equal(sent.length, n, 'nada saiu');
  await pool.query(`delete from public.email_suppressions where organization_id = $1`, [A.orgId]);
});

test('erro definitivo encerra; instabilidade repete; e-mail de outra empresa não vale', { skip }, async () => {
  reply = { status: 403, body: { message: 'domain not verified' } };
  const f = await flows.runNode(ex(), node(), await ctx());
  assert.equal(f.stop, 'failed'); assert.match(f.detail, /domain not verified/);
  reply = { status: 503, body: {} };
  assert.ok((await flows.runNode(ex(), node(), await ctx())).retry);
  reply = { status: 200, body: { id: 're_2' } };
  const other = (await pool.query(`insert into public.organizations (nome) values ('Outra') returning id`)).rows[0].id;
  const alheio = (await pool.query(`insert into public.emails (organization_id, titulo, assunto, corpo_html) values ($1,'x','x','<p>x</p>') returning id`, [other])).rows[0].id;
  assert.match((await flows.runNode(ex(), node(alheio), await ctx())).detail, /não encontrado/);
});
