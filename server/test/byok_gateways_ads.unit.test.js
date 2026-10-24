import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlm, listModels, parseJsonText, AI_PROVIDERS } from '../src/ai/llm.js';
import { createMercadoPago, createWoovi, mpChargeBody, mpNormalize, wooviNormalize } from '../src/payments/pix_br.js';
import { actionValue, normalizeInsight } from '../src/ads/meta.js';

const outputs = [{ key: 'compra', description: 'quer comprar' }, { key: 'duvida', description: 'tem dúvida' }];

test('IA: cada provedor no formato OpenAI vai para a sua URL, com a chave da empresa', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"saida":"compra"}' } }] }) }; };
  for (const p of ['openai', 'gemini', 'deepseek', 'openrouter']) {
    assert.equal(await createLlm({ provider: p, apiKey: `k-${p}`, model: 'm1', fetchImpl }).classify({ text: 'quero', outputs }), 'compra');
    assert.equal(calls.at(-1).url, `${AI_PROVIDERS[p].baseUrl}/chat/completions`);
    assert.equal(calls.at(-1).auth, `Bearer k-${p}`); assert.equal(calls.at(-1).body.model, 'm1');
  }
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid key' } }) });
  await assert.rejects(createLlm({ provider: 'openai', apiKey: 'x', model: 'm', fetchImpl: bad }).classify({ text: 'a', outputs }), (e) => e.code === 'ai_bad_key');
  await assert.rejects(createLlm({ apiKey: '' }).classify({ text: 'x', outputs }), /Integrações → IA/);
});

test('IA: Claude pelo SDK oficial, com recuperação no servidor nos modelos que aceitam e recusa tratada', async () => {
  const sent = [];
  const fake = (resp) => ({ beta: { messages: { create: async (p) => { sent.push(p); return resp; } } } });
  const ok = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Claro: {"saida": "duvida"}' }] };
  assert.equal(await createLlm({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5-5', anthropicClient: fake(ok) }).classify({ text: 'como funciona?', outputs }), 'duvida');
  assert.equal(sent[0].model, 'claude-opus-5-5'); assert.deepEqual(sent[0].betas, ['server-side-fallback-2026-07-01']); assert.equal(sent[0].fallbacks, 'default');
  assert.equal(sent[0].temperature, undefined, 'sem temperature (removido nos modelos atuais)');
  await createLlm({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-haiku-5-5', anthropicClient: fake(ok) }).classify({ text: 'x', outputs });
  assert.equal(sent[1].fallbacks, undefined, 'Haiku não usa fallbacks');
  await assert.rejects(createLlm({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5-5', anthropicClient: fake({ stop_reason: 'refusal', content: [] }) }).classify({ text: 'x', outputs }), (e) => e.code === 'ai_refused');
  assert.deepEqual(parseJsonText('ok {"a":1} fim'), { a: 1 });
  assert.throws(() => parseJsonText('sem json'), (e) => e.code === 'ai_bad_output');
});

test('IA: lista de modelos confere a chave (Gemini sem o prefixo models/)', async () => {
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'models/gemini-b' }, { id: 'models/gemini-a' }] }), url });
  assert.deepEqual(await listModels({ provider: 'gemini', apiKey: 'k', fetchImpl }), ['gemini-a', 'gemini-b']);
  const claude = { models: { list: () => (async function* () { yield { id: 'claude-opus-5-5' }; yield { id: 'claude-haiku-5-5' }; })() } };
  assert.deepEqual(await listModels({ provider: 'anthropic', apiKey: 'k', anthropicClient: claude }), ['claude-opus-5-5', 'claude-haiku-5-5']);
  await assert.rejects(listModels({ provider: 'xyz', apiKey: 'k' }), /não suportado/);
});

test('Mercado Pago: corpo do Pix, idempotência, status e aviso', async () => {
  const b = mpChargeBody({ amount: '97.5', name: 'Ana Maria Souza', email: 'ana@x.test', description: 'Guia', externalId: 'ext1', webhookUrl: 'https://api.k/wh' });
  assert.deepEqual(b, { transaction_amount: 97.5, payment_method_id: 'pix', description: 'Guia', external_reference: 'ext1', notification_url: 'https://api.k/wh', payer: { email: 'ana@x.test', first_name: 'Ana', last_name: 'Maria Souza' } });
  const n = mpNormalize({ id: 123, status: 'pending', transaction_amount: 97.5, point_of_interaction: { transaction_data: { qr_code: '000201PIX', ticket_url: 'https://mp/t' } } });
  assert.equal(n.transactionId, '123'); assert.equal(n.code, '000201PIX'); assert.equal(n.link, 'https://mp/t'); assert.match(n.qr, /^https:\/\//);
  const calls = [];
  const mp = createMercadoPago({ fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => (init.method === 'POST' ? { id: 9, status: 'pending', point_of_interaction: { transaction_data: { qr_code: 'C' } } } : { status: 'approved', transaction_amount: 50 }) }; } });
  await mp.createCharge({ clientSecret: 'APP_USR-1' }, { amount: 50, externalId: 'kb-1', email: 'a@b.c' });
  assert.equal(calls[0].init.headers['X-Idempotency-Key'], 'kb-1'); assert.equal(calls[0].init.headers.Authorization, 'Bearer APP_USR-1');
  assert.deepEqual(await mp.consult({ clientSecret: 'APP_USR-1' }, { transactionId: '9' }), { status: 'confirmed', amount: 50 });
  assert.equal(mp.parseWebhook({ type: 'payment', action: 'payment.updated', data: { id: '9' } }).transactionId, '9');
  assert.equal(mp.parseWebhook({ type: 'merchant_order', data: { id: '1' } }), null);
  await assert.rejects(mp.createCharge({ clientSecret: 'x' }, { openAmount: true, externalId: 'k' }), /valor livre/);
  assert.deepEqual(mp.methods, { BRL: ['PIX'] });
});

test('Woovi: valor em centavos, correlationID idempotente e status', async () => {
  const calls = [];
  const w = createWoovi({ fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => ({ charge: { correlationID: 'kb-2', status: init.method === 'POST' ? 'ACTIVE' : 'COMPLETED', value: 4590, brCode: 'BR', qrCodeImage: 'https://w/qr.png', paymentLinkUrl: 'https://w/p' } }) }; } });
  const c = await w.createCharge({ clientSecret: 'APPID' }, { amount: 45.9, externalId: 'kb-2', description: 'Guia' });
  assert.equal(JSON.parse(calls[0].init.body).value, 4590); assert.match(calls[0].url, /return_existing=true/); assert.equal(calls[0].init.headers.Authorization, 'APPID');
  assert.deepEqual([c.transactionId, c.code, c.qr, c.status], ['kb-2', 'BR', 'https://w/qr.png', 'pending']);
  assert.deepEqual(await w.consult({ clientSecret: 'APPID' }, { transactionId: 'kb-2' }), { status: 'confirmed', amount: 45.9 });
  assert.equal(w.parseWebhook({ event: 'OPENPIX:CHARGE_COMPLETED', charge: { correlationID: 'kb-2' } }).externalId, 'kb-2');
  assert.equal(wooviNormalize({ status: 'EXPIRED' }).status, 'expired');
});

test('Facebook Ads: compras e receita pela ação preferida, ROAS da Meta', () => {
  const r = normalizeInsight({ campaign_id: '1', campaign_name: 'Black', spend: '100.50', impressions: '1000', clicks: '50', ctr: '5', cpc: '2.01', account_currency: 'BRL',
    actions: [{ action_type: 'purchase', value: '3' }, { action_type: 'omni_purchase', value: '4' }, { action_type: 'lead', value: '10' }],
    action_values: [{ action_type: 'omni_purchase', value: '402' }] });
  assert.deepEqual([r.compras_meta, r.receita_meta, r.leads_meta, r.spend], [4, 402, 10, 100.5]);
  assert.equal(r.roas_meta.toFixed(2), '4.00');
  assert.equal(actionValue(undefined, ['purchase']), 0);
  assert.equal(normalizeInsight({ campaign_id: '2', spend: '0' }).roas_meta, null);
});
