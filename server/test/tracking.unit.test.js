import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUtm } from '../src/ingest/utm.js';
import { buildUtmifyOrder } from '../src/tracking/utmify.js';
import { atendentePode } from '../src/functions/index.js';

test('UTM: topo, Kiwify (TrackingParameters), Hotmart (origin.src/xcod) e URL do checkout', () => {
  assert.deepEqual(extractUtm({ email: 'a@b.c', utm_source: 'facebook', utm_campaign: 'pix-mx' }), { utm_source: 'facebook', utm_campaign: 'pix-mx' });
  assert.deepEqual(extractUtm({ order: { TrackingParameters: { src: 'ig', sck: null, utm_source: 'FB', utm_medium: 'cpc' } } }), { src: 'ig', utm_source: 'FB', utm_medium: 'cpc' });
  assert.deepEqual(extractUtm({ data: { purchase: { origin: { src: 'story', xcod: 'abc123' } } } }), { src: 'story', sck: 'abc123' });
  assert.deepEqual(extractUtm({ checkout_url: 'https://pay.test/c?utm_source=google&utm_term=guia+mx&x=1' }), { utm_source: 'google', utm_term: 'guia mx' });
  // "source"/"campaign" soltos fora de um objeto de rastreio não viram UTM (ex.: source do webhook)
  assert.equal(extractUtm({ source: 'hotmart', campaign: { id: 1 }, product: { name: 'Guia' } }), null);
  assert.equal(extractUtm({ utm_source: '   ' }), null);
  assert.equal(extractUtm(null), null);
});

test('UTMify: pedido no formato da API, método mapeado e moeda fora da lista ignorada', () => {
  const charge = { id: 'c1', currency: 'MXN', method: 'SPEI', amount: '45.00', created_at: '2026-10-24T15:34:14.000Z' };
  const lead = { nome: 'Rosa', sobrenome: 'Díaz', email: 'rosa@x.test', telefone: '5215512345678', produto: 'Guia', utm: { utm_source: 'facebook', sck: 'k1' } };
  const o = buildUtmifyOrder({ charge, lead, status: 'waiting_payment' });
  assert.equal(o.orderId, 'kobly-c1'); assert.equal(o.platform, 'Kobly');
  assert.equal(o.paymentMethod, 'pix'); assert.equal(o.status, 'waiting_payment');
  assert.equal(o.createdAt, '2026-10-24 15:34:14'); assert.equal(o.approvedDate, null); assert.equal(o.refundedAt, null);
  assert.deepEqual(o.customer, { name: 'Rosa Díaz', email: 'rosa@x.test', phone: '5215512345678', document: null, country: 'MX' });
  assert.equal(o.products[0].priceInCents, 4500); assert.equal(o.products[0].name, 'Guia');
  assert.deepEqual(o.trackingParameters, { utm_source: 'facebook', utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, src: null, sck: 'k1' });
  assert.deepEqual(o.commission, { totalPriceInCents: 4500, gatewayFeeInCents: 0, userCommissionInCents: 4500, currency: 'MXN' });

  const paid = buildUtmifyOrder({ charge: { ...charge, currency: 'BRL', method: 'PIX', paid_amount: '50', confirmed_at: '2026-10-24T16:00:00Z' }, lead, product: { id: 'p1', nome: 'Guia Completo' }, status: 'paid' });
  assert.equal(paid.approvedDate, '2026-10-24 16:00:00'); assert.equal(paid.commission.totalPriceInCents, 5000);
  assert.equal(paid.commission.currency, undefined, 'BRL dispensa moeda'); assert.equal(paid.products[0].id, 'p1');
  assert.equal(buildUtmifyOrder({ charge: { ...charge, method: 'OXXO' }, lead, status: 'waiting_payment' }).paymentMethod, 'boleto');
  assert.equal(buildUtmifyOrder({ charge: { ...charge, currency: 'JPY' }, lead, status: 'paid' }), null);
});

test('atendente: só conversa e lê o necessário', () => {
  assert.equal(atendentePode('inbox', 'send'), true);
  assert.equal(atendentePode('workspace-settings', 'get'), true);
  assert.equal(atendentePode('workspace-settings', 'upsert'), false);
  assert.equal(atendentePode('flow-graph', 'save'), false);
  assert.equal(atendentePode('team', 'invite'), false);
  assert.equal(atendentePode('payment-integrations', 'list'), false);
  assert.equal(atendentePode(null, 'x'), false);
  assert.equal(atendentePode('toString', undefined), false);
});
