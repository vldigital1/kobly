import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseUazapiStatus } from '../src/whatsapp/uazapi.js';
import { buildTikTokBody, buildGa4Body, ga4ClientId, TIKTOK_EVENTS, GA4_EVENTS } from '../src/payments/pixel.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');

test('Uazapi: status da instância em qualquer formato de resposta', () => {
  assert.deepEqual(parseUazapiStatus({ instance: { status: 'connecting', qrcode: 'data:image/png;base64,AAA' } }), { status: 'connecting', qrcode: 'data:image/png;base64,AAA', paircode: null, phone: null, profileName: null });
  const c = parseUazapiStatus({ instance: { status: 'connected', owner: '5511999999999', profileName: 'Loja', qrcode: 'velho' }, status: { connected: true, jid: '5511999999999@s.whatsapp.net' } });
  assert.deepEqual([c.status, c.qrcode, c.phone, c.profileName], ['connected', null, '5511999999999', 'Loja'], 'conectado não mostra QR antigo');
  assert.equal(parseUazapiStatus({ status: { connected: true, jid: '5521988887777@s.whatsapp.net' } }).phone, '5521988887777');
  assert.equal(parseUazapiStatus({ qrcode: 'Q' }).status, 'connecting', 'sem status mas com QR = aguardando leitura');
  assert.equal(parseUazapiStatus({}).status, 'disconnected');
  assert.equal(parseUazapiStatus({ instance: { status: 'hibernated' } }).status, 'hibernated');
});

test('TikTok Events API: e-mail e telefone (+DDI) em hash, compra vira CompletePayment', () => {
  const b = buildTikTokBody({ pixelCode: 'C4ABC123DEF456', eventName: 'Purchase', eventId: 'ch-1', eventTime: 1790000000, lead: { id: 'l1', email: ' Ana@X.co ', telefone: '+55 (11) 98888-7777' }, value: 97, currency: 'BRL', testCode: 'TEST123' });
  assert.deepEqual([b.event_source, b.event_source_id, b.test_event_code], ['web', 'C4ABC123DEF456', 'TEST123']);
  const ev = b.data[0];
  assert.deepEqual([ev.event, ev.event_id, ev.event_time], ['CompletePayment', 'ch-1', 1790000000]);
  assert.equal(ev.user.email, sha('ana@x.co')); assert.equal(ev.user.phone, sha('+5511988887777')); assert.equal(ev.user.external_id, sha('l1'));
  assert.deepEqual(ev.properties, { value: 97, currency: 'BRL', order_id: 'ch-1' });
  assert.equal(buildTikTokBody({ pixelCode: 'X', eventName: 'Lead', eventId: 'e', eventTime: 1, lead: {} }).data[0].event, 'SubmitForm');
  assert.equal(buildTikTokBody({ pixelCode: 'X', eventName: 'Lead', eventId: 'e', eventTime: 1, lead: {} }).data[0].properties, undefined, 'sem valor, sem properties');
  assert.equal(TIKTOK_EVENTS.Purchase, 'CompletePayment');
});

test('GA4 Measurement Protocol: client_id estável por lead e purchase com transaction_id', () => {
  const b = buildGa4Body({ eventName: 'Purchase', eventId: 'ch-9', lead: { id: 'lead-1' }, value: '45.9', currency: 'MXN' });
  assert.match(b.client_id, /^\d+\.\d+$/);
  assert.equal(b.client_id, ga4ClientId({ id: 'lead-1' }), 'mesmo lead, mesmo client_id');
  assert.notEqual(b.client_id, ga4ClientId({ id: 'lead-2' }));
  assert.deepEqual(b.events, [{ name: 'purchase', params: { engagement_time_msec: 1, value: 45.9, currency: 'MXN', transaction_id: 'ch-9' } }]);
  assert.equal(buildGa4Body({ eventName: 'Lead', eventId: 'x', lead: { id: 'a' } }).events[0].name, 'generate_lead');
  assert.equal(GA4_EVENTS.InitiateCheckout, 'begin_checkout');
});
