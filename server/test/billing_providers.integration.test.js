// Cobrança com Pix Automático (Asaas) e cartão (Stripe): QR Code que paga e autoriza, cobranças do ciclo criadas
// pela Kobly com a autorização, redução sem autorizar de novo, upgrade com um QR só, autorização recusada;
// assinatura no cartão da Stripe, aviso assinado, renovação, upgrade no cartão salvo, troca de Pix para cartão.
// Asaas e Stripe simulados (fetch falso). KOBLY_TEST_DATABASE_URL=postgres://... node --test test/billing_providers.integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import pg from 'pg';
import { createBilling } from '../src/billing/service.js';
import { formEncode, verifyStripeSignature } from '../src/billing/stripe.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
const TOKEN = 'whk-test-456';
const WHSEC = 'whsec_teste';
let pool, bill, clock = new Date();

// ---- Asaas e Stripe de mentira ----------------------------------------------------------------
const fake = { calls: [], auths: {}, payments: {}, stripe: { subs: {}, invoices: {}, pis: {}, sis: {}, n: 0 } };
const parseForm = (s) => { const o = {}; for (const kv of String(s || '').split('&').filter(Boolean)) { const [k, v] = kv.split('=').map(decodeURIComponent); o[k] = v; } return o; };
async function fakeFetch(url, opt = {}) {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  const nf = () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'not found' }, errors: [{ description: 'not found' }] }) });
  if (url.startsWith('https://api.stripe.com/v1')) {
    const path = url.replace('https://api.stripe.com/v1', '').split('?')[0];
    const b = parseForm(opt.body);
    fake.calls.push({ to: 'stripe', method: opt.method || 'GET', path, body: b });
    const S = fake.stripe; let m;
    if (path === '/customers' && opt.method === 'POST') return ok({ id: `cus_s_${stamp}` });
    if ((m = path.match(/^\/customers\/([^/]+)$/))) return ok({ id: m[1], invoice_settings: { default_payment_method: 'pm_card' } });
    if (/^\/products\//.test(path)) return ok({ id: path.split('/')[2] });
    if (path === '/subscriptions' && opt.method === 'POST') {
      const id = `sub_s_${++S.n}_${stamp}`, inv = `in_${S.n}_${stamp}`, pi = `pi_${S.n}_${stamp}`;
      S.invoices[inv] = { id: inv, status: b.trial_end ? 'paid' : 'open', subscription: id, amount_paid: 0, payment_intent: pi };
      S.pis[pi] = { id: pi, status: 'requires_payment_method', client_secret: `${pi}_secret` };
      S.subs[id] = { id, body: b, default_payment_method: b.default_payment_method || null };
      return ok({ id, items: { data: [{ id: `si_${S.n}` }] }, latest_invoice: { id: inv, payment_intent: S.pis[pi] } });
    }
    if ((m = path.match(/^\/subscriptions\/([^/]+)$/))) {
      if (opt.method === 'POST') { S.subs[m[1]].last = b; return ok({ id: m[1] }); }
      if (opt.method === 'DELETE') { S.subs[m[1]].deleted = true; return ok({ id: m[1], status: 'canceled' }); }
      return ok({ id: m[1], default_payment_method: S.subs[m[1]] ? S.subs[m[1]].default_payment_method || 'pm_card' : 'pm_card' });
    }
    if ((m = path.match(/^\/invoices\/([^/]+)$/))) return S.invoices[m[1]] ? ok(S.invoices[m[1]]) : nf();
    if (path === '/payment_intents' && opt.method === 'POST') { const id = `pi_up_${++S.n}`; S.pis[id] = { id, status: 'succeeded', amount: Number(b.amount) }; return ok(S.pis[id]); }
    if ((m = path.match(/^\/payment_intents\/([^/]+)$/))) return ok(S.pis[m[1]]);
    if (path === '/setup_intents' && opt.method === 'POST') { const id = `seti_${++S.n}`; S.sis[id] = { id, status: 'succeeded', customer: b.customer, payment_method: 'pm_novo', client_secret: `${id}_secret` }; return ok(S.sis[id]); }
    if ((m = path.match(/^\/setup_intents\/([^/]+)$/))) return ok(S.sis[m[1]]);
    if ((m = path.match(/^\/payment_methods\/([^/]+)$/))) return ok({ id: m[1], card: { last4: '4242', brand: 'visa' } });
    return nf();
  }
  const path = url.replace(/^https:\/\/sandbox\.asaas\.com\/api\/v3/, '');
  const body = opt.body ? JSON.parse(opt.body) : null;
  fake.calls.push({ to: 'asaas', method: opt.method || 'GET', path, body });
  let m;
  if (path === '/customers') return ok({ id: `cus_a_${stamp}` });
  if (path === '/pix/automatic/authorizations' && opt.method === 'POST') {
    const id = randomUUID();
    fake.auths[id] = { id, status: 'CREATED', ...body, payload: `00020126PIXAUTO-${id}`, encodedImage: 'iVBORw0KGgo=' };
    return ok(fake.auths[id]);
  }
  if ((m = path.match(/^\/pix\/automatic\/authorizations\/([^/]+)$/))) {
    if (opt.method === 'DELETE') { fake.auths[m[1]].status = 'CANCELLED'; return ok({ id: m[1] }); }
    return ok(fake.auths[m[1]]);
  }
  if (path === '/payments' && opt.method === 'POST') { const id = `pay_${Object.keys(fake.payments).length + 1}_${stamp}`; fake.payments[id] = { id, status: 'PENDING', ...body }; return ok(fake.payments[id]); }
  if ((m = path.match(/^\/payments\/([^/]+)\/pixQrCode$/))) return ok({ payload: `00020126PIX-${m[1]}`, encodedImage: 'iVBORw0KGgo=' });
  if ((m = path.match(/^\/payments\/([^/]+)$/))) { if (opt.method === 'POST') Object.assign(fake.payments[m[1]], body); return ok(fake.payments[m[1]]); }
  return nf();
}
const hook = (event, extra) => bill.receiveWebhook(JSON.stringify({ id: `evt_${randomUUID()}`, event, ...extra }), TOKEN);
function stripeHook(type, object) {
  const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type, data: { object } });
  const t = Math.floor(clock.getTime() / 1000);
  const sig = createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  return bill.receiveStripe(raw, `t=${t},v1=${sig}`);
}
const last = (to, re, method = 'POST') => fake.calls.filter((c) => c.to === to && c.method === method && re.test(c.path)).pop();

async function newOrg(nome) {
  const id = randomUUID(), email = `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@x.test`;
  await pool.query(`insert into auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at) values ($1,$2,'x',$3::jsonb, now())`, [id, email, JSON.stringify({ nome })]);
  const org = (await pool.query(`insert into public.organizations (nome, documento) values ($1, '11222333000181') returning id`, [nome])).rows[0].id;
  await pool.query(`update public.profiles set organization_id = $2 where auth_id = $1`, [id, org]);
  return { org, u: { id, email } };
}
const ctx = (orgId) => ({ orgId, role: 'Cliente', teamRole: 'admin' });
const subRow = async (org) => (await pool.query(`select * from public.subscriptions where organization_id = $1`, [org])).rows[0];

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  bill = createBilling({ pool, secretKey: Buffer.alloc(32, 7), fetchImpl: fakeFetch, apiKey: 'test', env: 'sandbox', webhookToken: TOKEN, now: () => clock,
    pixAuto: true, stripeKey: 'sk_test_x', stripePk: 'pk_test_x', stripeWebhookSecret: WHSEC });
});
after(async () => { if (!skip) await pool.end(); });

test('formulário da Stripe e assinatura do aviso', () => {
  assert.equal(formEncode({ a: 1, items: [{ price_data: { unit_amount: 8700 } }], expand: ['x.y'] }), 'a=1&items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=8700&expand%5B0%5D=x.y');
  const raw = '{"id":"evt"}', t = 1700000000;
  const sig = createHmac('sha256', 'seg').update(`${t}.${raw}`).digest('hex');
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'seg', t + 10), true);
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'outro', t + 10), false);
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'seg', t + 1000), false, 'aviso velho não vale');
});

test('Pix Automático: QR paga e autoriza; Kobly cria as cobranças do ciclo; redução sem autorizar de novo; upgrade com um QR só', { skip }, async () => {
  clock = new Date('2026-03-01T12:00:00Z');
  const A = await newOrg('Pix Auto');
  const cat = await bill.handle(ctx(A.org), A.u, { action: 'catalog' });
  assert.deepEqual(cat.pagamento, { pix: 'pix_auto', cartao: 'stripe', stripe_pk: 'pk_test_x' });
  const r = await bill.handle(ctx(A.org), A.u, { action: 'subscribe', plan: 'pro', connections: 3, method: 'PIX' });
  assert.equal(r.invoice.autoriza, true); assert.match(r.invoice.pix_payload, /PIXAUTO/); assert.equal(r.invoice.value, 161);
  const req = last('asaas', /^\/pix\/automatic\/authorizations$/).body;
  assert.equal(req.frequency, 'MONTHLY'); assert.equal(req.paymentCreationMode, 'MANUAL'); assert.equal(req.minLimitValue, 161);
  assert.equal(req.immediateQrCode.originalValue, 161); assert.equal(req.startDate, '2026-04-01'); assert.ok(req.contractId.length <= 35);
  // o cliente paga o QR: chega o pagamento (sem id da autorização) e depois a ativação
  await hook('PAYMENT_RECEIVED', { payment: { id: `pay_first_${stamp}`, customer: `cus_a_${stamp}`, value: 161, billingType: 'PIX' } });
  let s = await subRow(A.org);
  assert.equal(s.status, 'ativa'); assert.equal(s.provider, 'pix_auto');
  const authId = s.pix_auth_id;
  await hook('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', { authorization: { id: authId, status: 'ACTIVE', value: null } });
  s = await subRow(A.org);
  assert.equal(s.pix_auth_status, 'ACTIVE');
  assert.equal(new Date(s.current_period_end).toISOString().slice(0, 10), '2026-04-01');
  // longe da renovação: nada é criado
  assert.equal((await bill.tick()).created, 0);
  // reduz para PRO com 2 conexões (vale na renovação) e chega perto do vencimento: cobrança com a autorização, no valor novo
  await bill.handle(ctx(A.org), A.u, { action: 'downgrade', plan: 'pro', connections: 2 });
  clock = new Date('2026-03-26T12:00:00Z');
  assert.equal((await bill.tick()).created, 1);
  const pay = last('asaas', /^\/payments$/).body;
  assert.equal(pay.pixAutomaticAuthorizationId, authId); assert.equal(pay.value, 124); assert.equal(pay.dueDate, '2026-04-01');
  assert.equal((await bill.tick()).created, 0, 'não cria duas vezes');
  // desfazer a redução troca o valor da cobrança já criada
  await bill.handle(ctx(A.org), A.u, { action: 'cancel_downgrade' });
  const payId = Object.keys(fake.payments).pop();
  assert.equal(fake.payments[payId].value, 161);
  // o banco debita no vencimento: renova
  clock = new Date('2026-04-01T12:00:00Z');
  await hook('PAYMENT_CONFIRMED', { payment: { id: payId, value: 161, billingType: 'PIX', customer: `cus_a_${stamp}` } });
  s = await subRow(A.org);
  assert.equal(new Date(s.current_period_end).toISOString().slice(0, 10), '2026-05-01');
  // upgrade para 5 conexões: um QR só com a diferença, autorizando R$ 235
  clock = new Date('2026-04-16T12:00:00Z');
  const up = await bill.handle(ctx(A.org), A.u, { action: 'upgrade', plan: 'pro', connections: 5 });
  assert.equal(up.invoice.kind, 'upgrade'); assert.equal(up.invoice.autoriza, true);
  const areq = last('asaas', /^\/pix\/automatic\/authorizations$/).body;
  assert.equal(areq.minLimitValue, 235); assert.equal(areq.immediateQrCode.originalValue, up.invoice.value); assert.equal(areq.startDate, '2026-05-01');
  const newAuth = (await pool.query(`select pix_auth_id from public.invoices where id = $1`, [up.invoice.id])).rows[0].pix_auth_id;
  fake.auths[newAuth].status = 'ACTIVE'; // a tela pergunta e o Asaas já ativou
  const st = await bill.handle(ctx(A.org), A.u, { action: 'invoice', id: up.invoice.id });
  assert.equal(st.invoice.status, 'paga');
  s = await subRow(A.org);
  assert.equal(s.connections, 5); assert.equal(Number(s.price), 235); assert.equal(s.pix_auth_id, newAuth); assert.equal(Number(s.pix_auth_value), 235);
  assert.equal(fake.auths[authId].status, 'CANCELLED', 'a autorização antiga é cancelada');
  // o banco cancelou a autorização: a próxima renovação vira um QR que paga e autoriza de novo
  await hook('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', { authorization: { id: newAuth, status: 'CANCELLED' } });
  clock = new Date('2026-04-26T12:00:00Z');
  assert.equal((await bill.tick()).created, 1);
  const ren = (await pool.query(`select * from public.invoices where subscription_id = $1 order by created_at desc limit 1`, [s.id])).rows[0];
  assert.ok(ren.pix_auth_id, 'renovação com QR de autorização'); assert.equal(Number(ren.value), 235);
  const status = await bill.handle(ctx(A.org), A.u, { action: 'status' });
  assert.equal(status.subscription.pix_auto.status, 'CANCELLED');
});

test('Stripe: assinar no cartão, aviso assinado, renovação, upgrade no cartão salvo e sair do Pix para o cartão', { skip }, async () => {
  clock = new Date('2026-05-01T12:00:00Z');
  const B = await newOrg('Cartao Stripe');
  const r = await bill.handle(ctx(B.org), B.u, { action: 'subscribe', plan: 'essencial', connections: 1, method: 'CREDIT_CARD' });
  assert.ok(r.stripe && /_secret$/.test(r.stripe.client_secret)); assert.equal(r.stripe.publishable_key, 'pk_test_x');
  const sreq = last('stripe', /^\/subscriptions$/).body;
  assert.equal(sreq['items[0][price_data][unit_amount]'], '5700'); assert.equal(sreq['items[0][price_data][currency]'], 'brl'); assert.equal(sreq.payment_behavior, 'default_incomplete');
  let s = await subRow(B.org);
  assert.equal(s.status, 'pendente'); assert.equal(s.provider, 'stripe');
  // aviso com assinatura errada é recusado
  assert.equal((await bill.receiveStripe('{"id":"x","type":"invoice.paid"}', 't=1,v1=abc')).status, 400);
  // a Stripe avisa que a 1ª fatura foi paga
  const inv1 = Object.values(fake.stripe.invoices).find((i) => i.subscription === s.stripe_subscription_id);
  assert.equal((await stripeHook('invoice.paid', { ...inv1, status: 'paid', amount_paid: 5700, billing_reason: 'subscription_create' })).status, 200);
  s = await subRow(B.org);
  assert.equal(s.status, 'ativa'); assert.equal(s.card_last4, '4242');
  // renovação (fatura nova da Stripe)
  clock = new Date('2026-06-01T12:00:00Z');
  await stripeHook('invoice.paid', { id: `in_ren_${stamp}`, subscription: s.stripe_subscription_id, amount_paid: 5700, billing_reason: 'subscription_cycle', payment_intent: `pi_ren_${stamp}` });
  s = await subRow(B.org);
  assert.equal(new Date(s.current_period_end).toISOString().slice(0, 10), '2026-07-01');
  // upgrade no meio do mês: cobra a diferença no cartão salvo e muda o valor da assinatura (sem rateio da Stripe)
  clock = new Date('2026-06-16T12:00:00Z');
  const up = await bill.handle(ctx(B.org), B.u, { action: 'upgrade', plan: 'pro', connections: 1 });
  assert.equal(up.invoice.status, 'paga');
  const pi = last('stripe', /^\/payment_intents$/).body;
  assert.equal(pi.off_session, 'true'); assert.equal(Number(pi.amount), Math.round(up.invoice.value * 100));
  const subUpd = last('stripe', new RegExp(`^/subscriptions/${s.stripe_subscription_id}$`)).body;
  assert.equal(subUpd['items[0][price_data][unit_amount]'], '8700'); assert.equal(subUpd.proration_behavior, 'none');
  assert.equal((await subRow(B.org)).plan_code, 'pro');
  // o mesmo aviso de novo não faz nada (idempotente)
  const again = await stripeHook('payment_intent.succeeded', { id: 'pi_x', metadata: { kobly_invoice: up.invoice.id } });
  assert.equal(again.status, 200);

  // conta no Pix Automático passa a pagar no cartão: assinatura nova na Stripe que só cobra na renovação
  clock = new Date('2026-07-01T12:00:00Z');
  const C = await newOrg('Pix para Cartao');
  await bill.handle(ctx(C.org), C.u, { action: 'subscribe', plan: 'pro', connections: 1, method: 'PIX' });
  await hook('PAYMENT_RECEIVED', { payment: { id: `pay_c_${stamp}`, customer: `cus_a_${stamp}`, value: 87, billingType: 'PIX' } });
  let sc = await subRow(C.org);
  assert.equal(sc.status, 'ativa');
  const oldAuth = sc.pix_auth_id;
  const setup = await bill.handle(ctx(C.org), C.u, { action: 'card_setup' });
  assert.match(setup.stripe.client_secret, /^seti_/);
  const seti = setup.stripe.client_secret.replace(/_secret$/, '');
  await bill.handle(ctx(C.org), C.u, { action: 'card_saved', setup_intent: seti });
  sc = await subRow(C.org);
  assert.equal(sc.provider, 'stripe'); assert.equal(sc.billing_type, 'CREDIT_CARD'); assert.equal(sc.card_last4, '4242'); assert.equal(sc.pix_auth_id, null);
  const moved = last('stripe', /^\/subscriptions$/).body;
  assert.equal(Number(moved.trial_end), Math.floor(new Date(sc.current_period_end).getTime() / 1000), 'só cobra na renovação');
  assert.equal(fake.auths[oldAuth].status, 'CANCELLED', 'para o Pix Automático');
  // e volta para o Pix: na renovação chega um QR que paga e autoriza
  await bill.handle(ctx(C.org), C.u, { action: 'use_pix' });
  sc = await subRow(C.org);
  assert.equal(sc.provider, 'pix_auto'); assert.equal(sc.pix_auth_id, null);
  assert.ok(fake.stripe.subs[moved && last('stripe', /^\/subscriptions\/[^/]+$/, 'DELETE').path.split('/')[2]].deleted, 'para a Stripe');
});
