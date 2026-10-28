// Instagram Direct e Messenger: login com Facebook, escolha da página (Messenger + Instagram ligado), webhook assinado
// cria o contato e a conversa, resposta pelo Chat ao vivo sai pela página certa, eco do app vira "celular".
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/meta_channels.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createMetaChannels, channelAddress } from '../src/messaging/metaChannels.js';
import { createInbox } from '../src/workspace/inbox.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const SECRET = 'segredo-app-kobly';
const stamp = Date.now();
const PAGE = `90${stamp}`.slice(0, 15), IG = `17${stamp}`.slice(0, 17);
let pool, mc, inbox;
const A = {}, sent = [], inbound = [], subscribed = [];

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  const auth = (init.headers && init.headers.Authorization) || '';
  if (u.pathname.endsWith('/oauth/access_token')) return ok({ access_token: u.searchParams.get('code') ? 'curto' : 'user-longo' });
  if (u.pathname.endsWith('/me') && !u.pathname.endsWith('/me/messages')) return ok({ name: 'Dona da Loja' });
  if (u.pathname.endsWith('/me/accounts')) {
    assert.equal(auth, 'Bearer user-longo');
    return ok({ data: [{ id: PAGE, name: 'Loja Bela', access_token: 'page-token', picture: { data: { url: 'https://x.test/p.jpg' } }, instagram_business_account: { id: IG, username: 'lojabela', name: 'Loja Bela' } }] });
  }
  if (u.pathname.endsWith(`/${PAGE}/subscribed_apps`)) { assert.equal(auth, 'Bearer page-token'); subscribed.push(new URLSearchParams(init.body).get('subscribed_fields')); return ok({ success: true }); }
  if (u.pathname.endsWith('/me/messages')) { assert.equal(auth, 'Bearer page-token'); const b = JSON.parse(init.body); sent.push(b); return ok({ recipient_id: b.recipient.id, message_id: `m_out_${sent.length}` }); }
  if (/\/(psid|igsid)-/.test(u.pathname)) return ok(u.pathname.includes('igsid') ? { name: 'Carla IG', username: 'carla.ig', profile_pic: 'https://x.test/carla.jpg' } : { first_name: 'Rui', last_name: 'Messenger' });
  throw new Error('rede não esperada: ' + url);
}
const sig = (raw) => `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const hook = (obj) => { const raw = Buffer.from(JSON.stringify(obj)); return mc.receiveWebhook(raw, sig(raw)); };

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  mc = createMetaChannels({ pool, secretKey: KEY, fetchImpl: fakeFetch, appId: 'app-1', appSecret: SECRET, verifyToken: 'senha-webhook', publicBaseUrl: 'https://api.kobly.test',
    onInbound: async (a) => { inbound.push(a); } });
  // mesmo roteamento do app.js: ig:/fb: vai pelo Instagram/Messenger
  const wa = { freeTextAllowed: async (o, to) => !channelAddress(to) && false, sendTextTo: (o, a) => (channelAddress(a.to) ? mc.sendTextTo(o, a) : Promise.reject(new Error('whatsapp'))),
    sendMediaTo: (o, a) => mc.sendMediaTo(o, a) };
  inbox = createInbox({ pool, whatsapp: wa });
  A.orgId = (await pool.query(`insert into public.organizations (nome) values ('Loja Bela') returning id`)).rows[0].id;
});
after(async () => { if (skip) return; await pool.end(); });
const ctx = () => ({ orgId: A.orgId, role: 'Cliente' });

test('endereço ig:/fb: e verificação do webhook', () => {
  assert.deepEqual(channelAddress('ig:123456'), { kind: 'instagram', id: '123456' });
  assert.deepEqual(channelAddress('fb:987654'), { kind: 'messenger', id: '987654' });
  assert.equal(channelAddress('5511999990000'), null);
});

test('conectar: login → páginas → Messenger e Instagram ligados, página assinada', { skip }, async () => {
  assert.deepEqual(mc.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'senha-webhook', 'hub.challenge': 'abc' }), { status: 200, body: 'abc' });
  assert.equal(mc.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errada', 'hub.challenge': 'abc' }).status, 403);
  const s = await mc.handle(ctx(), {}, { action: 'oauth_start' });
  const state = new URL(s.url).searchParams.get('state');
  assert.ok(mc.ownsState(state));
  assert.match(new URL(s.url).searchParams.get('scope'), /instagram_manage_messages/);
  await assert.rejects(mc.handle(ctx(), {}, { action: 'oauth_pages' }), /expirou/);
  const html = await mc.oauthCallback({ state, code: 'codigo' });
  assert.match(html, /Facebook conectado/);
  const pg_ = await mc.handle(ctx(), {}, { action: 'oauth_pages' });
  assert.equal(pg_.pages[0].instagram.username, 'lojabela'); assert.equal(pg_.pages[0].token, undefined, 'token da página não vai para a tela');
  const c = await mc.handle(ctx(), {}, { action: 'connect', page_ids: [PAGE] });
  assert.deepEqual(c.channels.map((x) => x.kind).sort(), ['instagram', 'messenger']);
  assert.deepEqual(subscribed, ['messages,messaging_postbacks,message_echoes']);
  assert.equal((await mc.handle(ctx(), {}, { action: 'list' })).channels.length, 2);
  await assert.rejects(mc.handle({ orgId: A.orgId, role: 'Suporte' }, {}, { action: 'connect', page_ids: [PAGE] }), /não pode/);
});

test('mensagens: Instagram e Messenger criam o contato e a conversa; resposta sai pela página; eco vira "celular"', { skip }, async () => {
  assert.equal((await mc.receiveWebhook(Buffer.from('{}'), 'sha256=errada')).status, 401, 'sem a assinatura do app é recusado');
  const now = Date.now();
  await hook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: `igsid-${stamp}` }, recipient: { id: IG }, timestamp: now, message: { mid: `m_ig_${stamp}`, text: 'Oi, tem tamanho M?' } }] }] });
  await hook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: `igsid-${stamp}` }, recipient: { id: IG }, timestamp: now, message: { mid: `m_ig_${stamp}`, text: 'Oi, tem tamanho M?' } }] }] }); // reentrega
  await hook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: `psid-${stamp}` }, recipient: { id: PAGE }, timestamp: now, message: { mid: `m_fb_${stamp}`, attachments: [{ type: 'image', payload: { url: 'https://cdn.fb.test/foto.jpg' } }] } }] }] });
  const ig = (await pool.query(`select * from public.leads where organization_id = $1 and ig_user_id = $2`, [A.orgId, `igsid-${stamp}`])).rows[0];
  assert.equal(ig.nome, 'Carla IG'); assert.equal(ig.ig_username, 'carla.ig'); assert.equal(ig.chat_channel, 'instagram'); assert.equal(ig.avatar_url, 'https://x.test/carla.jpg');
  assert.equal(ig.utm.utm_source, 'instagram');
  const fb = (await pool.query(`select * from public.leads where organization_id = $1 and fb_psid = $2`, [A.orgId, `psid-${stamp}`])).rows[0];
  assert.equal(fb.nome, 'Rui Messenger'); assert.equal(fb.chat_channel, 'messenger');
  assert.equal(inbound.length, 2, 'cada mensagem nova avisa os fluxos uma vez');
  const list = (await inbox.handle(ctx(), {}, { action: 'list' })).conversations;
  assert.equal(list.find((c) => c.lead_id === ig.id).chat_channel, 'instagram');
  assert.equal(list.find((c) => c.lead_id === fb.id).ultima_tipo, 'image');
  // resposta pelo Chat ao vivo (dentro das 24 h)
  const r = await inbox.handle(ctx(), {}, { action: 'send', lead_id: ig.id, text: 'Tem sim! 😊' });
  assert.equal(r.message.body, 'Tem sim! 😊');
  assert.deepEqual(sent.at(-1), { recipient: { id: `igsid-${stamp}` }, messaging_type: 'RESPONSE', message: { text: 'Tem sim! 😊' } });
  assert.equal((await pool.query(`select channel from public.whatsapp_outbound_messages where lead_id = $1`, [ig.id])).rows[0].channel, 'instagram');
  // eco: a dona respondeu pelo app do Instagram
  await hook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: IG }, recipient: { id: `igsid-${stamp}` }, timestamp: now + 5000, message: { mid: `m_echo_${stamp}`, text: 'Já separei para você', is_echo: true } }] }] });
  const m = await inbox.handle(ctx(), {}, { action: 'messages', lead_id: ig.id });
  assert.deepEqual(m.messages.map((x) => x.de), ['lead', 'humano', 'celular']);
  // fora das 24 h: não deixa responder
  await pool.query(`update public.leads set whatsapp_last_inbound_at = now() - interval '2 days' where id = $1`, [fb.id]);
  await assert.rejects(inbox.handle(ctx(), {}, { action: 'send', lead_id: fb.id, text: 'oi' }), /24 h/);
});
