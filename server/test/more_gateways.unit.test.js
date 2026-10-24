import test from 'node:test';
import assert from 'node:assert/strict';
import { createPushinPay, createSyncPay, syncStatus } from '../src/payments/pix_br.js';
import { normalizePayload } from '../src/ingest/normalize.js';
import { extractUtm } from '../src/ingest/utm.js';

const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('PushinPay: valor em centavos, webhook na cobrança, consulta e status', async () => {
  const calls = [];
  const p = createPushinPay({ fetchImpl: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/pix/cashIn')) return res(200, { id: '9c29870c-9f69', qr_code: '00020101PIX', qr_code_base64: 'data:image/png;base64,AAA', status: 'created', value: 4590 });
    if (String(url).includes('/transactions/00000000')) return res(404, []);
    return res(200, { id: '9c29870c-9f69', status: 'paid', value: 4590 });
  } });
  const c = await p.createCharge({ clientSecret: 'tok' }, { amount: 45.9, externalId: 'kb-1', webhookUrl: 'https://api.k/wh' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { value: 4590, webhook_url: 'https://api.k/wh' });
  assert.equal(calls[0].url, 'https://api.pushinpay.com.br/api/pix/cashIn'); assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual([c.transactionId, c.code, c.status], ['9c29870c-9f69', '00020101PIX', 'pending']);
  assert.match(c.qr, /^https:\/\//, 'QR por link https (a imagem em base64 não serve para o WhatsApp)');
  assert.deepEqual(await p.consult({ clientSecret: 'tok' }, { transactionId: '9c29870c-9f69' }), { status: 'confirmed', amount: 45.9 });
  assert.equal(calls.at(-1).url, 'https://api.pushinpay.com.br/api/transactions/9c29870c-9f69');
  assert.deepEqual(await p.checkCredentials({ clientSecret: 'tok' }), { ok: true }, '404 numa transação inexistente = token aceito');
  const bad = createPushinPay({ fetchImpl: async () => res(401, { message: 'Unauthenticated.' }) });
  await assert.rejects(bad.checkCredentials({ clientSecret: 'x' }), (e) => e.code === 'invalid_credentials');
  await assert.rejects(p.createCharge({ clientSecret: 'tok' }, { amount: 0.3, externalId: 'k' }), /R\$ 0,50/);
  assert.deepEqual(p.parseWebhook({ id: 'ab', status: 'paid', value: '4590' }), { transactionId: 'ab', externalId: null, status: 'paid', dedupeKey: 'ab:paid' });
});

test('SyncPay: token reaproveitado por 1 h, cobrança em reais e só "pago" claro confirma', async () => {
  let t = 0; const calls = [];
  const s = createSyncPay({ now: () => t, fetchImpl: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith('/auth-token')) return JSON.parse(init.body).client_secret === 'sec' ? res(200, { access_token: 'AT1', token_type: 'Bearer', expires_in: 3600 }) : res(401, { error: 'invalid_client' });
    if (u.endsWith('/cash-in')) return res(200, { message: 'ok', pix_code: '00020126PIX', identifier: 'idt-1' });
    return res(200, { data: { id: 'idt-1', status: 'completed', amount: 97 } });
  } });
  const cred = { clientId: 'cid', clientSecret: 'sec' };
  const c = await s.createCharge(cred, { amount: 97, name: 'Ana', email: 'a@x.co', document: '123.456.789-00', phone: '+55 11 9999-0000', description: 'Guia', externalId: 'kb', webhookUrl: 'https://api.k/wh' });
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body, { amount: 97, description: 'Guia', client: { name: 'Ana', email: 'a@x.co', cpf: '12345678900', phone: '551199990000' }, webhook_url: 'https://api.k/wh' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer AT1');
  assert.deepEqual([c.transactionId, c.code], ['idt-1', '00020126PIX']);
  await s.consult(cred, { transactionId: 'idt-1' });
  assert.equal(calls.filter((x) => x.url.endsWith('/auth-token')).length, 1, 'não pede token de novo dentro da hora (a SyncPay responde 429)');
  t += 3600 * 1000;
  await s.consult(cred, { transactionId: 'idt-1' });
  assert.equal(calls.filter((x) => x.url.endsWith('/auth-token')).length, 2, 'token vencido é renovado');
  await assert.rejects(s.checkCredentials({ clientId: 'cid2', clientSecret: 'errado' }), (e) => e.code === 'invalid_credentials');
  for (const [st, exp] of [['completed', 'confirmed'], ['PAID', 'confirmed'], ['WAITING_FOR_APPROVAL', 'pending'], ['pending', 'pending'], ['expired', 'expired'], ['cancelled', 'expired'], ['algo_novo', 'pending'], [undefined, 'pending']]) assert.equal(syncStatus(st), exp, String(st));
  await assert.rejects(s.createCharge(cred, { amount: 0.5, externalId: 'k' }), /R\$ 1,00/);
  assert.equal(s.parseWebhook({ data: { id: 'idt-1', status: 'completed', updated_at: 'x' } }).transactionId, 'idt-1');
});

test('Postback Cakto: eventos, valor, pedido e idempotência por transição', () => {
  const base = { secret: 's', data: { id: 'ord-1', refId: 'AUA', status: 'waiting_payment', amount: 5.55, paymentMethod: 'pix', checkoutUrl: 'https://pay.cakto.com.br/B8?utm_source=fb', customer: { name: 'Ex', email: 'ex@x.co', phone: '34999999999' }, product: { name: 'Guia' } } };
  const pix = normalizePayload({ ...base, event: 'pix_gerado' });
  assert.deepEqual([pix.tipoEvento, pix.email, pix.phone, pix.product, pix.value, pix.isPix, pix.externalId], ['Pix Gerado', 'ex@x.co', '34999999999', 'Guia', 5.55, true, 'ord-1:Pix Gerado']);
  assert.equal(normalizePayload({ ...base, event: 'purchase_approved' }).externalId, 'ord-1:Compra Aprovada');
  assert.equal(normalizePayload({ ...base, event: 'checkout_abandonment' }).tipoEvento, 'Abandono de carrinho');
  assert.equal(normalizePayload({ ...base, event: 'evento_desconhecido' }), null);
  assert.deepEqual(extractUtm({ ...base, event: 'pix_gerado' }), { utm_source: 'fb' }, 'UTM do link do checkout');
});

test('Postback PerfectPay: status por código, boleto x pix, abandono e UTM do metadata (sem virar NexoPayt)', () => {
  const pp = (o) => ({ token: 't', code: 'PPCPMTB1', sale_amount: 197, currency_enum: 1, payment_type_enum: 1, sale_status_enum: 2, sale_status_detail: 'approved',
    customer: { full_name: 'Ana Lima', email: 'ana@x.co', phone_area_code: '11', phone_number: '988887777' }, product: { code: 'PPPB1', name: 'Curso' }, metadata: { utm_source: 'google', utm_campaign: 'marca', src: 'yt' }, ...o });
  const ap = normalizePayload(pp());
  assert.deepEqual([ap.tipoEvento, ap.name, ap.phone, ap.value, ap.paymentMethod, ap.externalId], ['Compra Aprovada', 'Ana Lima', '11988887777', 197, 'Cartão', 'PPCPMTB1:Compra Aprovada']);
  assert.equal(normalizePayload(pp({ sale_status_enum: 1, payment_type_enum: 2, billet_url: 'https://b' })).tipoEvento, 'Boleto Gerado');
  assert.equal(normalizePayload(pp({ sale_status_enum: 1, payment_type_enum: 0, sale_status_detail: 'pending_pix' })).tipoEvento, 'Pix Gerado');
  assert.equal(normalizePayload(pp({ sale_status_enum: 1, payment_type_enum: 1, sale_status_detail: 'pending' })), null, 'cartão pendente não é recuperação');
  assert.equal(normalizePayload(pp({ sale_status_enum: 0, sale_status_detail: 'checkout_saved' })).tipoEvento, 'Abandono de carrinho');
  assert.equal(normalizePayload(pp({ sale_status_enum: 7 })).tipoEvento, 'Compra Reembolsada');
  assert.equal(normalizePayload(pp({ sale_status_enum: 9 })).tipoEvento, 'Chargeback');
  assert.deepEqual(extractUtm(pp()), { utm_source: 'google', utm_campaign: 'marca', src: 'yt' });
  // NexoPayt continua reconhecida (tem customer mas não tem sale_status_enum)
  assert.equal(normalizePayload({ status: 'paid', payment_status: 'paid', customer: { email: 'n@x.co' }, transaction: { id: 't1', payment_status: 'paid' } })?.email, 'n@x.co');
});
