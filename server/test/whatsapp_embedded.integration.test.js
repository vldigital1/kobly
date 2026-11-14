// WhatsApp oficial com um clique (Cadastro incorporado): o código do login vira o token da empresa, o número é ativado,
// a conta fica marcada como "embedded" e os avisos chegam no webhook do app da Kobly (achando a conta pela WABA).
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/whatsapp_embedded.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const APP_SECRET = 'segredo-app-kobly-wa';
const stamp = String(Date.now());
const WABA = `55${stamp}`.slice(0, 15), PID = `66${stamp}`.slice(0, 15);
let pool, server, base;
const A = {}, calls = [];

const fakeGraph = {
  exchangeCode: async (id, secret, code) => { calls.push(['code', id, secret, code]); if (code !== 'codigo-valido-123') throw new Error('invalid code'); return { access_token: 'token-empresa-abc-0123456789' }; },
  registerPhone: async (pid, tok, pin) => { calls.push(['register', pid, tok, pin]); return { success: true }; },
  getPhoneNumber: async () => ({ display_phone_number: '+55 11 90000-0000', verified_name: 'Loja Um Clique', quality_rating: 'GREEN' }),
  getWaba: async () => ({ id: WABA, name: 'Loja' }),
  subscribeApp: async (waba, tok) => { calls.push(['subscribe', waba, tok]); return { success: true }; },
  listTemplates: async () => [],
};
const post = (path, body, token, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const fn = async (body) => { const r = await post('/functions/v1/whatsapp-account', body, A.token); return { status: r.status, ...(await r.json()) }; };

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-wa-emb', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'),
    publicBaseUrl: 'https://api.kobly.test', metaAdsAppId: '1550449143065379', metaAdsAppSecret: APP_SECRET, metaWaConfigId: '987654321', metaMsgVerifyToken: 'senha-webhook' };
  ({ server } = createApp({ pool, config, graph: fakeGraph, fetchImpl: async (u) => { throw new Error('rede não esperada: ' + u); } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await (await post('/auth/signup', { email: `umclique${stamp}@kobly.test`, password: 'senha-forte-123', nome: 'Loja Um Clique' })).json();
  A.token = s.session.access_token; A.userId = s.session.user.id;
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role kobly_authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.userId, role: 'kobly_authenticated' })]);
    A.orgId = (await c.query(`select (public.create_own_org('Loja Um Clique')).id as id`)).rows[0].id; await c.query('commit');
  } finally { c.release(); }
});
after(async () => { if (skip) return; server.close(); await pool.end(); });

test('um clique: código do login → token da empresa → número ativado e conta conectada sem colar nada', { skip }, async () => {
  const cfg = await fn({ action: 'embedded_config' });
  assert.deepEqual(cfg, { status: 200, enabled: true, app_id: '1550449143065379', config_id: '987654321', graph_version: 'v21.0' });
  const bad = await fn({ action: 'embedded_connect', code: 'codigo-errado-999', waba_id: WABA, phone_number_id: PID });
  assert.equal(bad.status, 400); assert.match(bad.message || bad.error || '', /Meta não confirmou/);
  const r = await fn({ action: 'embedded_connect', code: 'codigo-valido-123', waba_id: WABA, phone_number_id: PID });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.account.embedded, true); assert.equal(r.account.status, 'connected'); assert.equal(r.account.display_phone, '+55 11 90000-0000');
  assert.equal(r.registerWarning, null);
  assert.deepEqual(calls[1].slice(0, 3), ['code', '1550449143065379', APP_SECRET]);
  const reg = calls.find((c) => c[0] === 'register');
  assert.equal(reg[1], PID); assert.equal(reg[2], 'token-empresa-abc-0123456789'); assert.match(reg[3], /^\d{6}$/);
  assert.ok(calls.some((c) => c[0] === 'subscribe' && c[1] === WABA));
});

test('webhook do app: senha confere, assinatura do app da Kobly, mensagem cai na conta certa pela WABA', { skip }, async () => {
  const ok = await fetch(`${base}/webhooks/whatsapp-app?hub.mode=subscribe&hub.verify_token=senha-webhook&hub.challenge=xyz`);
  assert.equal(ok.status, 200); assert.equal(await ok.text(), 'xyz');
  assert.equal((await fetch(`${base}/webhooks/whatsapp-app?hub.mode=subscribe&hub.verify_token=errada&hub.challenge=xyz`)).status, 403);
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PID },
    contacts: [{ profile: { name: 'Cliente Teste' }, wa_id: '5511988887777' }], messages: [{ from: '5511988887777', id: `wamid.emb${stamp}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oi, quero saber o preço' } }] } }] }] });
  const sig = `sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`;
  assert.equal((await post('/webhooks/whatsapp-app', payload, null, { 'x-hub-signature-256': 'sha256=errada' })).status, 403);
  const r = await post('/webhooks/whatsapp-app', payload, null, { 'x-hub-signature-256': sig });
  assert.equal(r.status, 200);
  const m = (await pool.query(`select m.body, a.organization_id from public.whatsapp_inbound_messages m join public.whatsapp_accounts a on a.id = m.account_id where m.wa_message_id = $1`, [`wamid.emb${stamp}`])).rows[0];
  assert.equal(m.body, 'Oi, quero saber o preço'); assert.equal(m.organization_id, A.orgId);
  // empresa sem fluxo por mensagem: o contato novo vira lead e a conversa aparece no Chat ao vivo
  const l = (await pool.query(`select l.id, l.nome, l.telefone from public.whatsapp_inbound_messages m join public.leads l on l.id = m.lead_id where m.wa_message_id = $1`, [`wamid.emb${stamp}`])).rows[0];
  assert.ok(l, 'mensagem ligada a um lead'); assert.equal(l.nome, 'Cliente Teste'); assert.equal(l.telefone, '5511988887777');
});
