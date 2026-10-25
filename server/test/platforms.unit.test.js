import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePayload } from '../src/ingest/normalize.js';
import { createZenith, zenithNormalize } from '../src/payments/zenith.js';
import { createKiwifyApi, createCaktoApi, KIWIFY_TRIGGERS, CAKTO_EVENTS } from '../src/platforms/service.js';

const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('Kiwify: eventos do webhook, valor em centavos e fallback pelo order_status', () => {
  const k = (o) => ({ order_id: 'ord-9', order_status: 'paid', webhook_event_type: 'order_approved', payment_method: 'credit_card',
    Customer: { full_name: 'Ana Lima', email: 'ana@x.co', mobile: '+5511988887777' }, Product: { product_name: 'Guia' }, Commissions: { charge_amount: 9700 }, ...o });
  const a = normalizePayload(k());
  assert.deepEqual([a.tipoEvento, a.name, a.phone, a.product, a.value, a.externalId], ['Compra Aprovada', 'Ana Lima', '+5511988887777', 'Guia', 97, 'ord-9:Compra Aprovada']);
  assert.equal(normalizePayload(k({ webhook_event_type: 'pix_created', order_status: 'waiting_payment', payment_method: 'pix' })).tipoEvento, 'Pix Gerado');
  assert.equal(normalizePayload(k({ webhook_event_type: 'billet_created', order_status: 'waiting_payment' })).tipoEvento, 'Boleto Gerado');
  assert.equal(normalizePayload(k({ webhook_event_type: 'chargeback', order_status: 'chargedback' })).tipoEvento, 'Chargeback');
  assert.equal(normalizePayload(k({ webhook_event_type: undefined, order_status: 'refunded' })).tipoEvento, 'Compra Reembolsada');
  assert.equal(normalizePayload(k({ Customer: undefined, customer: { name: 'B', email: 'b@x.co' } })).email, 'b@x.co', 'aceita customer minúsculo');
  assert.equal(normalizePayload(k({ webhook_event_type: 'subscription_late', order_status: 'paid' })).tipoEvento, 'Compra Aprovada', 'evento sem mapa cai no order_status');
});

test('Kirvano: eventos, preço em texto "R$ 1.169,80" e vários produtos', () => {
  const v = (o) => ({ event: 'PIX_GENERATED', sale_id: 'sl-1', checkout_id: 'ck-1', payment_method: 'PIX', total_price: 'R$ 1.169,80', status: 'PENDING',
    customer: { name: 'Bia', email: 'bia@x.co', phone_number: '5511977776666', document: '123' }, products: [{ name: 'Curso' }, { name: 'Bônus', is_order_bump: true }], ...o });
  const p = normalizePayload(v());
  assert.deepEqual([p.tipoEvento, p.value, p.phone, p.product, p.isPix, p.externalId], ['Pix Gerado', 1169.8, '5511977776666', 'Curso, Bônus', true, 'sl-1:Pix Gerado']);
  assert.equal(normalizePayload(v({ event: 'SALE_APPROVED' })).tipoEvento, 'Compra Aprovada');
  assert.equal(normalizePayload(v({ event: 'ABANDONED_CART', sale_id: undefined })).externalId, 'ck-1:Abandono de carrinho');
  assert.equal(normalizePayload(v({ event: 'OUTRO_EVENTO' })), null);
  assert.equal(normalizePayload(v({ total_price: 169.8 })).value, 169.8);
});

test('Payt: status "expired" e "peding_refund" (como a doc escreve) entram', () => {
  const base = { integration_key: 'ik', transaction_id: 't1', status: 'canceled', customer: { name: 'C', email: 'c@x.co' }, product: { name: 'P' }, transaction: { payment_method: 'pix', total_price: 9700 } };
  assert.equal(normalizePayload({ ...base, transaction: { ...base.transaction, payment_status: 'expired' } }).tipoEvento, 'Compra cancelada');
  assert.equal(normalizePayload({ ...base, status: 'paid', transaction: { ...base.transaction, payment_status: 'peding_refund' } }).tipoEvento, 'Compra Reembolsada');
  assert.equal(normalizePayload({ ...base, status: 'lost_cart', transaction: { ...base.transaction, payment_status: '' } }).tipoEvento, 'Abandono de carrinho');
});

test('Zenith: CLABE do SPEI, status e registro do webhook', async () => {
  const n = zenithNormalize({ checkout: { id: 'ck_1', referenceId: 'kb-1', amount: 10990, currency: 'MXN', status: 'pending' }, payment: { status: 'pending' }, nextAction: { type: 'bank_transfer', details: { clabe: '646180000000000001', beneficiary: 'Loja' } } });
  assert.deepEqual([n.transactionId, n.code, n.amount, n.status, n.extra.beneficiario], ['ck_1', '646180000000000001', 109.9, 'pending', 'Loja']);
  assert.equal(zenithNormalize({ checkout: { id: 'x', status: 'succeeded' } }).status, 'confirmed');
  assert.equal(zenithNormalize({ checkout: { id: 'x' }, nextAction: { type: 'redirect', url: 'https://pay.z/x' } }).link, 'https://pay.z/x');
  const calls = [];
  const z = createZenith({ fetchImpl: async (url, init = {}) => { calls.push({ url: String(url), init }); return res(200, { checkout: { id: 'ck_2', status: 'pending', amount: 4500 }, nextAction: { type: 'bank_transfer', details: { clabe: 'C' } } }); } });
  await z.createCharge({ clientId: 'pk', clientSecret: 'sk', sandbox: true }, { amount: 45, currency: 'MXN', method: 'SPEI', externalId: 'kb-123', name: 'Rosa Díaz', email: 'rosa@cliente.mx', webhookUrl: 'https://api.kobly.io/webhooks/payments/zenith/abc' });
  const b = JSON.parse(calls[0].init.body);
  assert.deepEqual([b.amount, b.currency, b.country, b.environment, b.paymentMethod, b.referenceId, b.customerEmail, b.returnUrl], [4500, 'MXN', 'MX', 'sandbox', 'spei', 'kb-123', 'rosa@cliente.mx', 'https://api.kobly.io/']);
  assert.equal(calls[0].init.headers['X-API-Key'], 'pk'); assert.equal(calls[0].init.headers['Idempotency-Key'], 'kb-12300');
  await z.registerWebhook({ clientId: 'pk', clientSecret: 'sk' }, { url: 'https://api.kobly.io/webhooks/payments/zenith/abc' });
  const w = JSON.parse(calls[1].init.body);
  assert.equal(calls[1].url, 'https://api.zenithworld.com.br/integrations/webhooks/endpoints'); assert.ok(w.events.includes('checkout.succeeded')); assert.equal(w.secret.length, 48);
  await assert.rejects(z.createCharge({ clientId: 'pk', clientSecret: 'sk' }, { amount: 45, currency: 'MXN', externalId: 'k' }), /e-mail/);
  assert.equal(z.parseWebhook({ id: 'evt_1', type: 'checkout.succeeded', data: { checkoutId: 'ck_2', status: 'succeeded' } }).transactionId, 'ck_2');
});

test('APIs das plataformas: Kiwify e Cakto criam o webhook com todos os eventos de venda', async () => {
  const calls = [];
  const kfetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return String(url).endsWith('/oauth/token') ? res(200, { access_token: 'KT', expires_in: 86400 }) : res(200, { id: 'wh-1' }); };
  const kw = await createKiwifyApi({ fetchImpl: kfetch }).createWebhook({ client_id: 'c', client_secret: 's', account_id: 'acc' }, { url: 'https://api.k/pb?token=pbk_1', secret: 'tok' });
  assert.equal(calls[0].init.body, 'client_id=c&client_secret=s');
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual([body.products, body.token, body.url], ['all', 'tok', 'https://api.k/pb?token=pbk_1']); assert.deepEqual(body.triggers, KIWIFY_TRIGGERS);
  assert.equal(calls[1].init.headers['x-kiwify-account-id'], 'acc'); assert.equal(calls[1].init.headers.Authorization, 'Bearer KT');
  assert.equal(kw.remoteId, 'wh-1');

  const c2 = [];
  const cfetch = async (url, init = {}) => {
    c2.push({ url: String(url), init });
    if (String(url).endsWith('/token/')) return res(200, { access_token: 'CT' });
    if (String(url).endsWith('/products/')) return res(200, { count: 2, results: [{ id: 'p1' }, { id: 'p2' }] });
    return res(200, { id: 77, fields: { secret: 'sec-cakto' } });
  };
  const ck = await createCaktoApi({ fetchImpl: cfetch }).createWebhook({ client_id: 'c', client_secret: 's' }, { url: 'https://api.k/pb?token=pbk_2' });
  const cb = JSON.parse(c2[2].init.body);
  assert.deepEqual(cb.products, ['p1', 'p2']); assert.deepEqual(cb.events, CAKTO_EVENTS);
  assert.deepEqual([ck.remoteId, ck.secret], ['77', 'sec-cakto']);
  const vazio = createCaktoApi({ fetchImpl: async (url) => (String(url).endsWith('/token/') ? res(200, { access_token: 'CT' }) : res(200, { results: [] })) });
  await assert.rejects(vazio.createWebhook({ client_id: 'c', client_secret: 's' }, { url: 'u' }), /crie ao menos um produto/);
  const negado = createKiwifyApi({ fetchImpl: async () => res(401, { error: 'auth_error' }) });
  await assert.rejects(negado.createWebhook({ client_id: 'c', client_secret: 'x', account_id: 'a' }, { url: 'u', secret: 't' }), (e) => e.code === 'platform_bad_credentials');
});
