// Afiliados: virar afiliado, clique no link, cadastro pelo link (com fluxo de boas-vindas), comissão recorrente a cada
// pagamento de plano (10% padrão ou a comissão do afiliado), carência, saque por Pix e o painel do Administrador.
// Fluxo: compartilhar por código, prévia e importar em outra conta (etiquetas pelo nome, e-mail copiado, conta de pagamento em branco).
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/affiliates.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createAffiliates, slugCode, maskEmail } from '../src/affiliates/service.js';
import { createFlowTransfer } from '../src/flows/transfer.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
let pool, aff;
const A = {}, started = [];

async function user(nome) {
  const id = randomUUID(), email = `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@x.test`;
  await pool.query(`insert into auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at) values ($1,$2,'x',$3::jsonb, now())`, [id, email, JSON.stringify({ nome })]);
  return { id, email, user_metadata: { nome } };
}
async function orgFor(u, nome) {
  const org = (await pool.query(`insert into public.organizations (nome) values ($1) returning id`, [nome])).rows[0].id;
  await pool.query(`update public.profiles set organization_id = $2 where auth_id = $1`, [u.id, org]);
  return org;
}
const pay = async (org, valor, status = 'Pago') => (await pool.query(`insert into public.transactions (organization_id, valor_pago, status_pagamento, id_transacao, data) values ($1,$2,$3,$4, current_date) returning id`,
  [org, valor, status, `tx-${stamp}-${Math.random()}`])).rows[0].id;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  // conta da Kobly com um fluxo publicado para boas-vindas
  A.kobly = (await pool.query(`insert into public.organizations (nome) values ('Kobly HQ ${stamp}') returning id`)).rows[0].id;
  A.camp = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,'Boas-vindas','Ativa') returning id`, [A.kobly])).rows[0].id;
  aff = createAffiliates({ pool, secretKey: Buffer.from('k'), siteUrl: 'https://app.koblay.io', flows: { startForLead: async (a) => { started.push(a); return { started: true }; } } });
  await aff.admin({ action: 'save_settings', default_pct: 10, min_payout: 50, hold_days: 7, platform_org_id: A.kobly, referral_campaign_id: A.camp });
});
after(async () => { if (skip) return; await pool.query(`update public.affiliate_settings set platform_org_id = null, referral_campaign_id = null, affiliate_campaign_id = null where id`); await pool.end(); });

test('código do link e e-mail mascarado', () => {
  assert.equal(slugCode('Maria José da Silva!'), 'maria-jose-da-silva');
  assert.equal(maskEmail('fernanda@gmail.com'), 'fe••••••@gmail.com');
});

test('virar afiliado, clique no link e cadastro pelo link com fluxo de boas-vindas', { skip }, async () => {
  A.ana = await user('Ana Afiliada');
  assert.equal((await aff.handle(A.ana, { action: 'me' })).affiliate, null);
  const j = await aff.handle(A.ana, { action: 'join', code: `Ana ${stamp}` });
  A.code = j.affiliate.code;
  assert.equal(j.affiliate.link, `https://app.koblay.io/?ref=${A.code}`); assert.equal(j.affiliate.pct, 10);
  await assert.rejects(aff.handle(await user('Outra'), { action: 'join', code: A.code }), /em uso/);
  assert.equal((await aff.click({ code: A.code, ip: '1.2.3.4' })).ok, true);
  await aff.click({ code: A.code, ip: '1.2.3.4' }); // mesmo IP na mesma hora: conta 1
  await aff.click({ code: A.code, ip: '5.6.7.8' });
  assert.equal((await aff.click({ code: 'nao-existe', ip: '1.1.1.1' })).ok, false);
  // a própria Ana não se indica
  assert.equal((await aff.onSignup({ userId: A.ana.id, email: A.ana.email, ref: A.code })).ok, false);
  A.bruno = await user('Bruno Cliente');
  assert.equal((await aff.onSignup({ userId: A.bruno.id, email: A.bruno.email, nome: 'Bruno Cliente', whatsapp: '(11) 98888-7777', ref: A.code })).ok, true);
  assert.equal(started.length, 1); assert.equal(started[0].campaignId, A.camp); assert.equal(started[0].orgId, A.kobly);
  const lead = (await pool.query(`select telefone, utm from public.leads where id = $1`, [started[0].leadId])).rows[0];
  assert.equal(lead.telefone, '5511988887777'); assert.equal(lead.utm.utm_campaign, A.code);
});

test('comissão recorrente: 10% de cada pagamento, carência, cancelamento e comissão especial', { skip }, async () => {
  A.orgBruno = await orgFor(A.bruno, 'Loja do Bruno');
  await pay(A.orgBruno, 197);
  await pay(A.orgBruno, 197);           // mês seguinte
  await pay(A.orgBruno, 97, 'Pendente'); // não pago: sem comissão
  const tx = await pay(A.orgBruno, 50);
  await pool.query(`update public.transactions set status_pagamento = 'Pagamento recusado' where id = $1`, [tx]); // estornado
  let d = await aff.handle(A.ana, { action: 'dashboard' });
  assert.equal(d.saldo.pendente, 39.4, '2 × 19,70'); assert.equal(d.saldo.disponivel, 0);
  assert.equal(d.stats.cliques, 2); assert.equal(d.stats.cadastros, 1); assert.equal(d.stats.pagantes, 1);
  assert.equal(d.serie.length, 12);
  const refs = (await aff.handle(A.ana, { action: 'referrals' })).referrals;
  assert.equal(refs[0].conta, 'Loja do Bruno'); assert.match(refs[0].email, /•/); assert.equal(refs[0].comissao, 39.4);
  // amigo próximo: 30%
  const list = (await aff.admin({ action: 'list', q: A.code })).affiliates;
  await aff.admin({ action: 'update', id: list[0].id, commission_pct: 30 });
  await pay(A.orgBruno, 100);
  d = await aff.handle(A.ana, { action: 'dashboard' });
  assert.equal(d.saldo.pendente, 69.4); assert.equal(d.affiliate.pct, 30);
  // saque: antes da carência não dá
  await assert.rejects(aff.handle(A.ana, { action: 'request_payout' }), /Pix/);
  await aff.handle(A.ana, { action: 'update', pix_tipo: 'email', pix_chave: 'ana@pix.test' });
  await assert.rejects(aff.handle(A.ana, { action: 'request_payout' }), /mínimo/);
  await pool.query(`update public.affiliate_commissions set available_at = now() - interval '1 day' where affiliate_id = $1`, [list[0].id]);
  const p = (await aff.handle(A.ana, { action: 'request_payout' })).payout;
  assert.equal(p.amount, 69.4);
  d = await aff.handle(A.ana, { action: 'dashboard' });
  assert.equal(d.saldo.em_saque, 69.4); assert.equal(d.saldo.disponivel, 0);
  // admin paga
  const ov = await aff.admin({ action: 'overview' });
  assert.ok(ov.saques_pendentes >= 69.4);
  await aff.admin({ action: 'mark_paid', id: p.id, note: 'Pix enviado' });
  await assert.rejects(aff.admin({ action: 'mark_paid', id: p.id }), /já foi resolvido/);
  d = await aff.handle(A.ana, { action: 'payouts' });
  assert.equal(d.payouts[0].status, 'pago'); assert.equal(d.saldo.paga, 69.4);
  // código não muda depois do primeiro cadastro
  await assert.rejects(aff.handle(A.ana, { action: 'update', code: 'novo-codigo' }), /não muda/);
});

test('fluxo: código para compartilhar, prévia e importar em outra conta', { skip }, async () => {
  const tr = createFlowTransfer({ pool });
  const o1 = (await pool.query(`insert into public.organizations (nome) values ('Origem ${stamp}') returning id`)).rows[0].id;
  const o2 = (await pool.query(`insert into public.organizations (nome) values ('Destino ${stamp}') returning id`)).rows[0].id;
  const tag = (await pool.query(`insert into public.tags (organization_id, nome) values ($1,'Comprou') returning id`, [o1])).rows[0].id;
  const tagB = (await pool.query(`insert into public.tags (organization_id, nome) values ($1,'Comprou') returning id`, [o2])).rows[0].id; // já existe no destino
  const em = (await pool.query(`insert into public.emails (organization_id, titulo, assunto, corpo_html) values ($1,'Oi','Seu acesso','<p>Olá</p>') returning id`, [o1])).rows[0].id;
  const c = (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'Recuperação Pix') returning id`, [o1])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [c, o1])).rows[0].id;
  const graph = { start: 'a', nodes: [
    { ref: 'a', type: 'send_email', data: { email_id: em }, next: { default: 'b' } },
    { ref: 'b', type: 'tag', data: { add: [tag] }, next: { default: 'c' } },
    { ref: 'c', type: 'payment', data: { integration_id: randomUUID(), currency: 'BRL', method: 'PIX' } },
  ] };
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`, [o1, f, JSON.stringify(graph)]);
  // código do fluxo: o mesmo até pedir um novo
  const sh = await tr.share(o1, null, c);
  assert.match(sh.code, /^[0-9a-f-]{36}$/); assert.equal(sh.link, `https://app.koblay.io/?fluxo=${sh.code}`);
  assert.equal((await tr.share(o1, null, c)).code, sh.code);
  await assert.rejects(tr.share(o2, null, c), /Salve o fluxo/, 'outra empresa não compartilha');
  // prévia pública: desenho e nomes, sem a conta de pagamento
  const pv = await tr.preview(sh.code);
  assert.equal(pv.nome, 'Recuperação Pix'); assert.equal(pv.blocos, 3); assert.equal(pv.conta, `Origem ${stamp}`);
  assert.deepEqual(pv.lookups.tags, [{ id: tag, nome: 'Comprou' }]); assert.equal(pv.lookups.emails[0].assunto, 'Seu acesso');
  assert.equal(pv.graph.nodes[2].data.integration_id, null); assert.equal(pv.inclui.emails, 1);
  // versão mais nova: mudou o fluxo depois do código, a importação já pega a nova
  await pool.query(`update public.flow_graph_versions set is_active = false where flow_id = $1`, [f]);
  graph.nodes[0].data.nota = 'v2';
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,2,$3::jsonb,true)`, [o1, f, JSON.stringify(graph)]);
  await assert.rejects(tr.importByCode(o2, null, 'abc'), /inválido/);
  const r = await tr.importByCode(o2, null, sh.code);
  assert.equal(r.nome, 'Recuperação Pix'); assert.equal(r.criados.emails, 1);
  assert.deepEqual(r.pendencias, ['Conta de pagamento: escolha a da sua conta nos blocos que usam.']);
  const g = (await pool.query(`select v.graph, v.is_draft, v.is_active from public.flow_graph_versions v join public.campaign_flows f on f.id = v.flow_id where f.campaign_id = $1`, [r.campaign_id])).rows[0];
  assert.equal(g.is_draft, true); assert.equal(g.is_active, false);
  assert.deepEqual(g.graph.nodes[1].data.add, [tagB], 'etiqueta achada pelo nome');
  const newEmail = g.graph.nodes[0].data.email_id;
  assert.notEqual(newEmail, em);
  assert.equal((await pool.query(`select organization_id from public.emails where id = $1`, [newEmail])).rows[0].organization_id, o2);
  assert.equal(g.graph.nodes[2].data.integration_id, null);
  assert.equal(g.graph.nodes[0].data.nota, 'v2', 'importou a versão mais nova');
  assert.equal((await pool.query(`select imports from public.flow_shares where code = $1`, [sh.code])).rows[0].imports, 1);
  // novo código desativa o antigo
  const sh2 = await tr.share(o1, null, c, true);
  assert.notEqual(sh2.code, sh.code);
  await assert.rejects(tr.preview(sh.code), /desativado/);
});
