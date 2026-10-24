import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPostbackAuth, signPostback, parseSignature, tokenFrom } from '../src/ingest/auth.js';

const tok = { signing_secret: 's'.repeat(64), hottok: null, require_signature: false };
const body = '{"event":"pix_generated","email":"a@x.test"}';
const NOW = 1_800_000_000;

test('postback: assinatura válida passa; corpo alterado, segredo errado, vencida ou malformada não', () => {
  const sig = signPostback(tok.signing_secret, NOW, body);
  assert.deepEqual(verifyPostbackAuth({ token: tok, headers: { 'x-kobly-signature': `t=${NOW},v1=${sig}` }, rawBody: body, nowS: NOW }), { ok: true, mode: 'assinado' });
  assert.equal(verifyPostbackAuth({ token: tok, headers: { 'x-kobly-signature': `t=${NOW},v1=${sig}` }, rawBody: body + ' ', nowS: NOW }).reason, 'assinatura_invalida');
  assert.equal(verifyPostbackAuth({ token: tok, headers: { 'x-kobly-signature': `t=${NOW},v1=${signPostback('x'.repeat(64), NOW, body)}` }, rawBody: body, nowS: NOW }).reason, 'assinatura_invalida');
  assert.equal(verifyPostbackAuth({ token: tok, headers: { 'x-kobly-signature': `t=${NOW - 301},v1=${signPostback(tok.signing_secret, NOW - 301, body)}` }, rawBody: body, nowS: NOW }).reason, 'assinatura_expirada');
  assert.equal(verifyPostbackAuth({ token: tok, headers: { 'x-kobly-signature': 'lixo' }, rawBody: body, nowS: NOW }).reason, 'assinatura_malformada');
  // assinatura inválida é recusada mesmo sem modo estrito (não cai no modo legado)
  assert.equal(verifyPostbackAuth({ token: { ...tok, require_signature: false }, headers: { 'x-kobly-signature': `t=${NOW},v1=${'0'.repeat(64)}` }, rawBody: body, nowS: NOW }).ok, false);
});

test('postback: hottok da Hotmart, modo estrito e modo legado (compatível com a URL)', () => {
  const hot = { ...tok, hottok: 'hottok-da-conta-123' };
  assert.deepEqual(verifyPostbackAuth({ token: hot, headers: { 'x-hotmart-hottok': 'hottok-da-conta-123' }, rawBody: body }), { ok: true, mode: 'hottok' });
  assert.equal(verifyPostbackAuth({ token: hot, headers: { 'x-hotmart-hottok': 'errado-errado-1' }, rawBody: body }).reason, 'hottok_invalido');
  assert.deepEqual(verifyPostbackAuth({ token: tok, headers: {}, rawBody: body }), { ok: true, mode: 'legado_url' });
  assert.equal(verifyPostbackAuth({ token: { ...tok, require_signature: true }, headers: {}, rawBody: body }).reason, 'assinatura_obrigatoria');
  assert.equal(verifyPostbackAuth({ token: { ...hot, require_signature: true }, headers: {}, rawBody: body }).reason, 'hottok_obrigatorio');
});

test('postback: token no cabeçalho tem prioridade; parse da assinatura', () => {
  assert.equal(tokenFrom({ 'x-kobly-token': 'pbk_cab' }, new URLSearchParams('token=pbk_url')), 'pbk_cab');
  assert.equal(tokenFrom({ authorization: 'Bearer pbk_bearer' }, new URLSearchParams('')), 'pbk_bearer');
  assert.equal(tokenFrom({}, new URLSearchParams('token=pbk_url')), 'pbk_url');
  assert.deepEqual(parseSignature(`t=${NOW}, v1=${'a'.repeat(64)}, v1=${'B'.repeat(64)}`), { t: NOW, v1: ['a'.repeat(64), 'b'.repeat(64)] });
});
