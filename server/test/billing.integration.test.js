// Planos e cobrança: preços, assinatura por Pix, aviso de pagamento do Asaas (ativa + transação), travas do plano,
// upgrade pagando só a diferença, redução na renovação, atraso, cortesia, conta de cliente de agência e painel do admin.
// O Asaas é simulado (fetch falso). KOBLY_TEST_DATABASE_URL=postgres://... node --test test/billing.integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createBilling, validDocument } from '../src/billing/service.js';
import { monthly, priceOf, proration } from '../src/billing/pricing.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
const TOKEN = 'whk-test-123';
let pool, bill;
const A = {};

// Asaas de mentira: guarda as chamadas e responde como a API
const asaas = { calls: [], payments: {}, n: 0 };
async function fakeFetch(url, opt = {}) {
  const path = url.replace(/^https:\/\/sandbox\.asaas\.com\/api\/v3/, '');
  const body = opt.body ? JSON.parse(opt.body) : null;
  asaas.calls.push({ method: opt.method || 'GET', path, body });
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  let m;
  if (path === '/customers') return ok({ id: `cus_${stamp}` });
  if (path === '/subscriptions' && opt.method === 'POST') {
    const id = `sub_${++asaas.n}_${stamp}`, pid = `pay_${asaas.n}_${stamp}`;
    asaas.payments[pid] = { id: pid, subscription: id, value: body.value, billingType: body.billingType, status: body.billingType === 'CREDIT_CARD' ? 'CONFIRMED' : 'PENDING', dueDate: body.nextDueDate };
    return ok({ id, ...(body.creditCard ? { creditCard: { creditCardToken: 'tok_abc', creditCardNumber: '4242', creditCardBrand: 'VISA' } } : {}) });
  }
  if ((m = path.match(/^\/subscriptions\/([^/]+)\/payments$/))) return ok({ data: Object.values(asaas.payments).filter((p) => p.subscription === m[1]) });
  if (path.match(/^\/subscriptions\/[^/]+$/)) return ok({ ok: true });
  if ((m = path.match(/^\/payments\/([^/]+)\/pixQrCode$/))) return ok({ payload: `00020126PIX-${m[1]}`, encodedImage: 'iVBORw0KGgo=' });
  if (path === '/payments' && opt.method === 'POST') {
    const pid = `pay_up_${++asaas.n}_${stamp}`;
    asaas.payments[pid] = { id: pid, value: body.value, billingType: body.billingType, status: body.billingType === 'CREDIT_CARD' ? 'CONFIRMED' : 'PENDING', dueDate: body.dueDate };
    return ok(asaas.payments[pid]);
  }
  if ((m = path.match(/^\/payments\/([^/]+)$/))) return ok(asaas.payments[m[1]] || {});
  return { ok: false, status: 404, json: async () => ({ errors: [{ description: `rota falsa ${path}` }] }) };
}
const hook = (event, payment) => bill.receiveWebhook(JSON.stringify({ event, payment }), TOKEN);

async function user(nome) {
  const id = randomUUID(), email = `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@x.test`;
  await pool.query(`insert into auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at) values ($1,$2,'x',$3::jsonb, now())`, [id, email, JSON.stringify({ nome })]);
  return { id, email };
}
async function orgFor(u, nome) {
  const org = (await pool.query(`insert into public.organizations (nome) values ($1) returning id`, [nome])).rows[0].id;
  await pool.query(`update public.profiles set organization_id = $2 where auth_id = $1`, [u.id, org]);
  return org;
}
const ctx = (orgId) => ({ orgId, role: 'Cliente', teamRole: 'admin' });

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  bill = createBilling({ pool, secretKey: Buffer.alloc(32, 7), fetchImpl: fakeFetch, apiKey: 'test', env: 'sandbox', webhookToken: TOKEN });
});
after(async () => { if (!skip) await pool.end(); });

test('preços dos planos, ciclos e diferença do upgrade', () => {
  assert.equal(monthly('essencial', 1), 57); assert.equal(monthly('essencial', 3), 111);
  assert.equal(monthly('pro', 1), 87); assert.equal(monthly('pro', 3), 161);
  assert.equal(monthly('scale', 11), 447); assert.equal(monthly('scale', 60), 1700);
  assert.equal(monthly('agencia10'), 697);
  assert.throws(() => monthly('pro', 11), /1 a 10/);
  assert.equal(priceOf('pro', 1, 'anual'), 870); assert.equal(priceOf('pro', 1, 'trimestral'), 247.95);
  const now = new Date('2026-01-01T00:00:00Z');
  const p = proration({ oldPrice: 57, newPrice: 87, cycle: 'mensal', periodEnd: new Date('2026-01-16T00:00:00Z'), now });
  assert.deepEqual(p, { dias_restantes: 15, novo: 43.5, credito: 28.5, pagar: 15 });
  assert.equal(validDocument('529.982.247-25'), true); assert.equal(validDocument('111.111.111-11'), false);
  assert.equal(validDocument('11.222.333/0001-81'), true);
});

test('assinar por Pix: QR Code, aviso do Asaas ativa o plano e grava a transação', { skip }, async () => {
  A.u = await user('Dona Loja'); A.org = await orgFor(A.u, `Loja ${stamp}`);
  assert.equal((await bill.entitlement(A.org)).plan, null);
  await assert.rejects(bill.handle(ctx(A.org), A.u, { action: 'subscribe', plan: 'essencial', connections: 1, method: 'PIX' }), /CPF ou CNPJ/);
  await assert.rejects(bill.handle({ ...ctx(A.org), teamRole: 'atendente' }, A.u, { action: 'subscribe', plan: 'essencial' }), /dono da conta/);
  const r = await bill.handle(ctx(A.org), A.u, { action: 'subscribe', plan: 'essencial', connections: 1, cycle: 'mensal', method: 'PIX', documento: '529.982.247-25' });
  assert.equal(r.subscription.status, 'pendente'); assert.equal(r.invoice.value, 57);
  assert.match(r.invoice.pix_payload, /^00020126PIX-/); assert.ok(r.invoice.pix_image);
  A.pay1 = Object.keys(asaas.payments)[0];
  // aviso falso (sem o token) é recusado
  assert.equal((await bill.receiveWebhook(JSON.stringify({ event: 'PAYMENT_RECEIVED', payment: { id: A.pay1 } }), 'errado')).status, 401);
  assert.equal((await hook('PAYMENT_RECEIVED', { ...asaas.payments[A.pay1], status: 'RECEIVED' })).status, 200);
  await hook('PAYMENT_RECEIVED', { ...asaas.payments[A.pay1], status: 'RECEIVED' }); // repetido: não duplica
  const st = await bill.handle(ctx(A.org), A.u, { action: 'status' });
  assert.equal(st.subscription.status, 'ativa'); assert.equal(st.subscription.plan, 'essencial');
  assert.ok(new Date(st.subscription.renova_em) > new Date(Date.now() + 27 * 86400000));
  assert.equal(st.invoices[0].status, 'paga'); assert.equal(st.documento, '529•••25');
  const tx = (await pool.query(`select valor_pago::float as v, status_pagamento::text as s, forma_pagamento from public.transactions where id_transacao = $1`, [A.pay1])).rows;
  assert.equal(tx.length, 1); assert.equal(tx[0].v, 57); assert.equal(tx[0].s, 'Pago'); assert.equal(tx[0].forma_pagamento, 'Pix');
  const o = (await pool.query(`select plano_status, asaas_customer_id from public.organizations where id = $1`, [A.org])).rows[0];
  assert.equal(o.plano_status, 'ativo'); assert.equal(o.asaas_customer_id, `cus_${stamp}`);
  await assert.rejects(bill.handle(ctx(A.org), A.u, { action: 'subscribe', plan: 'pro', method: 'PIX' }), /já tem um plano/);
});

test('travas: Essencial sem IA e com 1 conexão; o Administrador passa', { skip }, async () => {
  await assert.rejects(bill.requireFeature(A.org, 'ia', 'Cliente'), (e) => e.status === 402 && /PRO/.test(e.message));
  await bill.requireFeature(A.org, 'ia', 'Administrador');
  await bill.requireSlots(A.org, 1, 'Cliente');
  await assert.rejects(bill.requireSlots(A.org, 2, 'Cliente'), /1 conexão/);
  const sem = await orgFor(await user('Sem Plano'), `Sem ${stamp}`);
  await assert.rejects(bill.requireSlots(sem, 1, 'Cliente'), (e) => e.code === 'no_plan');
});

test('upgrade no meio do mês: paga só a diferença por Pix e o plano muda quando paga', { skip }, async () => {
  const q = await bill.handle(ctx(A.org), A.u, { action: 'quote', plan: 'pro', connections: 3 });
  assert.equal(q.price, 161); assert.equal(q.upgrade.direcao, 'upgrade');
  assert.ok(q.upgrade.pagar > 0 && q.upgrade.pagar <= 104);
  await assert.rejects(bill.handle(ctx(A.org), A.u, { action: 'upgrade', plan: 'essencial', connections: 1 }), /Reduzir plano/);
  const r = await bill.handle(ctx(A.org), A.u, { action: 'upgrade', plan: 'pro', connections: 3, method: 'PIX' });
  assert.equal(r.invoice.kind, 'upgrade'); assert.equal(r.invoice.status, 'pendente'); assert.equal(r.invoice.value, q.upgrade.pagar);
  assert.equal((await bill.entitlement(A.org)).plan, 'essencial', 'ainda não pagou');
  const pid = asaas.calls.filter((c) => c.path === '/payments' && c.method === 'POST').length && Object.keys(asaas.payments).find((k) => k.startsWith('pay_up_'));
  asaas.payments[pid].status = 'RECEIVED'; // pagou: a tela pergunta e o servidor confere no Asaas
  const inv = await bill.handle(ctx(A.org), A.u, { action: 'invoice', id: r.invoice.id });
  assert.equal(inv.invoice.status, 'paga');
  assert.equal(inv.subscription.plan, 'pro'); assert.equal(inv.subscription.connections, 3); assert.equal(inv.subscription.price, 161);
  const upd = asaas.calls.filter((c) => c.method === 'POST' && /^\/subscriptions\/sub_/.test(c.path)).pop();
  assert.equal(upd.body.value, 161, 'próximas cobranças no valor novo');
  const e = await bill.entitlement(A.org); assert.equal(e.connections, 3); assert.ok(e.features.includes('ia'));
});

test('reduzir plano vale na renovação; atraso deixa inadimplente', { skip }, async () => {
  const r = await bill.handle(ctx(A.org), A.u, { action: 'downgrade', plan: 'essencial', connections: 2 });
  assert.equal(r.subscription.plan, 'pro'); assert.equal(r.subscription.pending_change.plan, 'essencial');
  const sub = (await pool.query(`select * from public.subscriptions where organization_id = $1`, [A.org])).rows[0];
  const before = new Date(sub.current_period_end);
  // renovação: o Asaas cria a cobrança do mês seguinte e depois avisa que pagou
  const p2 = { id: `pay_ren_${stamp}`, subscription: sub.asaas_subscription_id, value: 84, billingType: 'PIX', dueDate: '2026-12-01' };
  await hook('PAYMENT_CREATED', p2);
  await hook('PAYMENT_CONFIRMED', p2);
  const s2 = (await pool.query(`select * from public.subscriptions where id = $1`, [sub.id])).rows[0];
  assert.equal(s2.plan_code, 'essencial'); assert.equal(s2.connections, 2); assert.equal(Number(s2.price), 84); assert.equal(s2.pending_change, null);
  assert.ok(new Date(s2.current_period_end) > before);
  assert.equal((await pool.query(`select count(*)::int as n from public.transactions where organization_id = $1 and status_pagamento = 'Pago'`, [A.org])).rows[0].n, 3);
  const p3 = { id: `pay_atr_${stamp}`, subscription: sub.asaas_subscription_id, value: 84, billingType: 'PIX' };
  await hook('PAYMENT_CREATED', p3);
  await hook('PAYMENT_OVERDUE', p3);
  assert.equal((await pool.query(`select status from public.subscriptions where id = $1`, [sub.id])).rows[0].status, 'inadimplente');
  assert.equal((await bill.entitlement(A.org)).plan, 'essencial', 'continua usando enquanto o período não acabou');
  await hook('PAYMENT_REFUNDED', p2);
  assert.equal((await pool.query(`select status_pagamento::text as s from public.transactions where id_transacao = $1`, [p2.id])).rows[0].s, 'Pagamento recusado');
});

test('cortesia, conta de cliente de agência e painel do Administrador', { skip }, async () => {
  const gestor = await user('Gestor Agencia'); const ag = await orgFor(gestor, `Agencia ${stamp}`);
  await bill.admin({ action: 'set_cortesia', org_id: ag, plan: 'agencia5', note: 'parceira' });
  const gp = (await pool.query(`select id from public.profiles where auth_id = $1`, [gestor.id])).rows[0].id;
  const clientes = [];
  for (let i = 0; i < 6; i++) {
    const c = (await pool.query(`insert into public.organizations (nome) values ($1) returning id`, [`Cliente ${i} ${stamp}`])).rows[0].id;
    await pool.query(`insert into public.organization_memberships (organization_id, profile_id, created_at) values ($1,$2, now() + ($3 || ' seconds')::interval)`, [c, gp, String(i)]);
    clientes.push(c);
  }
  const e0 = await bill.entitlement(clientes[0]);
  assert.equal(e0.plan, 'pro'); assert.equal(e0.connections, 1); assert.equal(e0.source, 'agencia');
  assert.equal((await bill.entitlement(clientes[4])).plan, 'pro');
  assert.equal((await bill.entitlement(clientes[5])).plan, null, 'sexto cliente passa do limite da Agência 5');
  const ov = await bill.admin({ action: 'overview' });
  assert.ok(ov.cortesias >= 1); assert.ok(ov.inadimplentes >= 1); assert.equal(typeof ov.mrr, 'number');
  const l = await bill.admin({ action: 'list', q: `Agencia ${stamp}` });
  assert.equal(l.subscriptions.length, 1); assert.equal(l.subscriptions[0].status, 'cortesia');
  await bill.admin({ action: 'cancel', org_id: ag });
  assert.equal((await bill.entitlement(clientes[0])).plan, null);
});
