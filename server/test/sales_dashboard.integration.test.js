// Dashboard de vendas: checkout + vendas dos fluxos, período no fuso da empresa, estado pelo DDD, número de WhatsApp,
// origem pela UTM, taxas e reembolsos. Também os ajudantes puros (período, telefone, origem).
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/sales_dashboard.integration.test.js   (sem a variável, só os testes puros)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { salesReport, salesPeriod, whereFrom, originOf, methodOf } from '../src/workspace/sales.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
let pool;
const A = {};

test('período: hoje, 7 dias, este mês e mês passado com o anterior de mesmo tamanho', () => {
  assert.deepEqual(salesPeriod('today', '2026-11-05'), { since: '2026-11-05', until: null, prev: { since: '2026-11-04', until: '2026-11-05' } });
  assert.deepEqual(salesPeriod('last_7d', '2026-11-05'), { since: '2026-10-30', until: null, prev: { since: '2026-10-23', until: '2026-10-30' } });
  assert.deepEqual(salesPeriod('this_month', '2026-11-05').prev, { since: '2026-10-01', until: '2026-11-01' });
  assert.deepEqual(salesPeriod('last_month', '2026-01-10'), { since: '2025-12-01', until: '2026-01-01', prev: { since: '2025-11-01', until: '2025-12-01' } });
  assert.equal(salesPeriod('maximum', '2026-11-05').prev, null);
});

test('telefone → estado/país; origem e forma de pagamento', () => {
  assert.deepEqual(whereFrom('+55 (21) 98888-7777'), { pais: 'Brasil', uf: 'RJ' });
  assert.deepEqual(whereFrom('11988887777'), { pais: 'Brasil', uf: 'SP' });
  assert.deepEqual(whereFrom('5215512345678'), { pais: 'México', uf: null });
  assert.deepEqual(whereFrom('351912345678'), { pais: 'Portugal', uf: null });
  assert.deepEqual(whereFrom(''), { pais: null, uf: null });
  assert.equal(originOf('fb', false, 'checkout'), 'Facebook / Instagram');
  assert.equal(originOf('google', false, 'checkout'), 'Google');
  assert.equal(originOf(null, true, 'fluxo'), 'Anúncio Click-to-WhatsApp');
  assert.equal(originOf(null, false, 'checkout'), 'Orgânico / direto');
  assert.equal(methodOf('PIX'), 'Pix'); assert.equal(methodOf('credit_card'), 'Cartão'); assert.equal(methodOf(null), 'Não informado');
});

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  A.org = (await pool.query(`insert into public.organizations (nome, timezone) values ('Loja Vendas ${stamp}', 'America/Sao_Paulo') returning id`)).rows[0].id;
  A.outra = (await pool.query(`insert into public.organizations (nome) values ('Outra ${stamp}') returning id`)).rows[0].id;
  A.inst = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status, phone) values ($1,'Vendas',$2,'x','connected','5511900001111') returning id`, [A.org, `sales-${stamp}`])).rows[0].id;
  const lead = (tel, utm) => pool.query(`insert into public.leads (organization_id, nome, telefone, utm) values ($1,'L',$2,$3::jsonb) returning id`, [A.org, tel, utm ? JSON.stringify(utm) : null]).then((r) => r.rows[0].id);
  A.l1 = await lead('5521988887777', { utm_source: 'fb', utm_campaign: 'bf' });
  A.l2 = await lead('5511977776666', null);
  A.l3 = await lead('5215512345678', { utm_source: 'google', utm_campaign: 'g' });
  // l2 conversou pelo número "Vendas"
  await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, instance_id, wa_message_id, from_phone, lead_id, msg_type, body, received_at) values ($1,$2,$3,'5511977776666',$4,'text','oi', now() - interval '1 hour')`, [A.org, A.inst, `w-${stamp}`, A.l2]);
  const ev = (lead, tipo, valor, produto, metodo, quando = "now() - interval '2 hours'") => pool.query(
    `insert into public.webhook_events (organization_id, lead_id, tipo_evento, valor_produto, produto, metodo_pagamento, id_webhook, created_at) values ($1,$2,$3,$4,$5,$6,$7, ${quando})`,
    [A.org, lead, tipo, valor, produto, metodo, `e-${stamp}-${Math.random()}`]);
  await ev(A.l1, 'Compra Aprovada', 200, 'Curso X', 'pix');
  await ev(A.l3, 'Compra Aprovada', 100, 'Curso X', 'credit_card');
  await ev(A.l1, 'Compra Reembolsada', 50, 'Curso X', 'pix');
  await ev(A.l2, 'Pix Gerado', 97, 'Ebook', 'pix');
  await ev(A.l1, 'Compra Aprovada', 999, 'Antiga', 'pix', "now() - interval '60 days'");
  await pool.query(`insert into public.flow_sales (organization_id, lead_id, amount, product) values ($1,$2,97,'Ebook')`, [A.org, A.l2]);
  // venda de outra empresa não aparece
  await pool.query(`insert into public.webhook_events (organization_id, tipo_evento, valor_produto, id_webhook) values ($1,'Compra Aprovada',5000,$2)`, [A.outra, `o-${stamp}`]);
  await pool.query(`insert into public.ads_settings (organization_id, imposto_pct, taxa_gateway_pct, custo_produto_pct, custo_por_venda) values ($1, 10, 0, 0, 1)`, [A.org]);
});
after(async () => { if (!skip) await pool.end(); });

test('vendas dos últimos 7 dias: totais, taxas, reembolsos e quebras', { skip }, async () => {
  const r = await salesReport(pool, A.org, { date_preset: 'last_7d' });
  assert.equal(r.totais.vendas, 3);
  assert.equal(r.totais.faturamento, 397);
  assert.equal(Math.round(r.totais.ticket_medio * 100) / 100, 132.33);
  assert.equal(r.totais.recuperadas, 1); assert.equal(r.totais.receita_recuperada, 97);
  assert.equal(r.totais.despesas, 397 * 0.1 + 3); // 10% + R$ 1 por venda
  assert.deepEqual(r.totais.reembolsos, { n: 1, valor: 50 });
  assert.deepEqual(r.totais.pendentes, { n: 1, valor: 97 });
  assert.equal(r.serie.length, 7);
  assert.equal(r.serie.reduce((t, d) => t + d.vendas, 0), 3);
  assert.equal(r.por_hora.reduce((t, h) => t + h.vendas, 0), 3);
  assert.deepEqual(r.estados.map((e) => e.uf).sort(), ['RJ', 'SP']);
  assert.deepEqual(r.paises.map((p) => p.nome).sort(), ['Brasil', 'México']);
  assert.ok(r.instancias.find((i) => i.nome.startsWith('Vendas') && i.vendas === 1));
  assert.ok(r.instancias.find((i) => i.nome === 'Sem conversa no WhatsApp' && i.vendas === 2));
  assert.equal(r.produtos[0].nome, 'Curso X'); assert.equal(r.produtos[0].valor, 300);
  assert.deepEqual(r.origens.map((o) => o.nome).sort(), ['Facebook / Instagram', 'Google', 'WhatsApp (sem UTM)']);
  assert.deepEqual(r.metodos.map((m) => m.nome).sort(), ['Cartão', 'Não informado', 'Pix']);
  assert.equal(r.anterior.vendas, 0);
});

test('todo o período inclui a venda antiga; outra empresa nunca entra', { skip }, async () => {
  const r = await salesReport(pool, A.org, { date_preset: 'maximum' });
  assert.equal(r.totais.vendas, 4);
  assert.equal(r.totais.faturamento, 1396);
  assert.equal(r.anterior, null);
  assert.ok(r.serie.length >= 60);
});
