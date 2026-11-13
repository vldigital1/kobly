// Instagram com login direto: "Entrar com Instagram" conecta a conta sem página do Facebook; comentário num post
// inicia o fluxo (resposta pública + 1ª mensagem como resposta privada ao comentário); story e Direct por palavra-chave;
// regra "Segue o perfil"; token de 60 dias renovado sozinho.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/instagram_login.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createMetaChannels, channelAddress } from '../src/messaging/metaChannels.js';
import { createFlowRuntime } from '../src/flows/runtime.js';
import { validateGraph } from '../src/flows/graph.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const IG_SECRET = 'segredo-app-instagram';
const stamp = Date.now();
const IG = `178${stamp}`.slice(0, 17);
const FAN = `igsid${stamp}`;
let pool, mc, flows;
const A = {}, sent = [], replies = [], subscribed = [];
let follows = true, refreshed = 0;

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  const auth = (init.headers && init.headers.Authorization) || '';
  if (u.hostname === 'api.instagram.com' && u.pathname === '/oauth/access_token') {
    const b = new URLSearchParams(init.body);
    assert.equal(b.get('code'), 'codigo-ig', 'tira o "#_" do fim do código');
    assert.equal(b.get('redirect_uri'), 'https://api.kobly.test/oauth/instagram/callback');
    return ok({ access_token: 'ig-curto', user_id: IG, permissions: 'instagram_business_basic' });
  }
  if (u.hostname !== 'graph.instagram.com') throw new Error('rede não esperada: ' + url);
  if (u.pathname === '/access_token') return ok({ access_token: 'ig-longo', token_type: 'bearer', expires_in: 5184000 });
  if (u.pathname === '/refresh_access_token') { refreshed++; return ok({ access_token: 'ig-renovado', expires_in: 5184000 }); }
  assert.match(auth, /^Bearer ig-(longo|renovado)$/);
  if (u.pathname.endsWith('/me') && u.searchParams.get('fields')) return ok({ id: 'app-scoped-1', user_id: IG, username: 'lojabela', name: 'Loja Bela', profile_picture_url: 'https://x.test/loja.jpg', account_type: 'BUSINESS' });
  if (u.pathname.endsWith('/me/subscribed_apps')) { subscribed.push(new URLSearchParams(init.body).get('subscribed_fields')); return ok({ success: true }); }
  if (u.pathname.endsWith('/me/messages')) { const b = JSON.parse(init.body); sent.push(b); return ok({ recipient_id: 'x', message_id: `m_out_${sent.length}` }); }
  if (u.pathname.endsWith('/replies')) { replies.push({ comment: u.pathname.split('/').at(-2), message: new URLSearchParams(init.body).get('message') }); return ok({ id: 'r1' }); }
  if (u.pathname.endsWith('/me/media')) return ok({ data: [{ id: '1801', caption: 'Promo de Natal', media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'https://x.test/t.jpg', permalink: 'https://instagram.com/p/1', timestamp: '2026-11-10T10:00:00+0000' }] });
  if (u.pathname.endsWith(`/${FAN}`)) {
    if (u.searchParams.get('fields') === 'is_user_follow_business') return ok({ is_user_follow_business: follows });
    return ok({ name: 'Carla Fã', username: 'carla.fa', profile_pic: 'https://x.test/c.jpg' });
  }
  throw new Error('rede não esperada: ' + url);
}
const sig = (raw) => `sha256=${createHmac('sha256', IG_SECRET).update(raw).digest('hex')}`;
const hook = (obj) => { const raw = Buffer.from(JSON.stringify(obj)); return mc.receiveWebhook(raw, sig(raw)); };
const comment = (id, text, media = '1801') => hook({ object: 'instagram', entry: [{ id: IG, time: 1, changes: [{ field: 'comments', value: { id, text, from: { id: FAN, username: 'carla.fa' }, media: { id: media, media_product_type: 'REELS' } } }] }] });
const ctx = () => ({ orgId: A.orgId, role: 'Cliente' });

async function publish(nome, graph) {
  const v = validateGraph(graph);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const c = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,$2,'Ativa') returning id`, [A.orgId, nome])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [c, A.orgId])).rows[0].id;
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`, [A.orgId, f, JSON.stringify(graph)]);
  return c;
}
const run = async () => { for (let i = 0; i < 6; i++) { await pool.query(`update public.flow_executions set run_at = now() where status = 'waiting' and wait_kind = 'timer'`); await flows.tick(); } };

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  mc = createMetaChannels({ pool, secretKey: KEY, fetchImpl: fakeFetch, igAppId: 'ig-app-1', igAppSecret: IG_SECRET, verifyToken: 'senha', publicBaseUrl: 'https://api.kobly.test',
    onInbound: (a) => flows.onInboundLead(a), onComment: (a) => flows.onComment(a) });
  const wa = { sendTextTo: (o, a) => mc.sendTextTo(o, a), sendMediaTo: (o, a) => mc.sendMediaTo(o, a), sendInteractiveTo: (o, a) => mc.sendInteractiveTo(o, a),
    freeTextAllowed: (o, to) => (channelAddress(to) ? mc.commentReplyPending(o, to) : false), igFollows: (o, id) => mc.followsBusiness(o, id) };
  flows = createFlowRuntime({ pool, whatsapp: wa, autoKick: false });
  A.orgId = (await pool.query(`insert into public.organizations (nome) values ('Loja Bela IG') returning id`)).rows[0].id;
});
after(async () => { if (skip) return; await pool.end(); });

test('Entrar com Instagram: login → token de 60 dias → conta conectada e assinada (sem página do Facebook)', { skip }, async () => {
  assert.deepEqual(await mc.handle(ctx(), {}, { action: 'oauth_status' }), { enabled: false, ig_enabled: true });
  const s = await mc.handle(ctx(), {}, { action: 'ig_oauth_start' });
  const u = new URL(s.url);
  assert.equal(u.hostname, 'www.instagram.com');
  assert.equal(u.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments');
  assert.match(await mc.igOauthCallback({ state: 'msg.x.y', code: 'a' }), /expirou/);
  const html = await mc.igOauthCallback({ state: u.searchParams.get('state'), code: 'codigo-ig#_' });
  assert.match(html, /@lojabela conectado/);
  assert.deepEqual(subscribed, ['messages,messaging_postbacks,comments']);
  const ch = (await mc.handle(ctx(), {}, { action: 'list' })).channels;
  assert.equal(ch.length, 1); assert.equal(ch[0].auth, 'ig_login'); assert.equal(ch[0].page_id, null); assert.equal(ch[0].username, 'lojabela');
  assert.equal(ch[0].token_enc, undefined, 'token não vai para a tela');
  const m = await mc.handle(ctx(), {}, { action: 'ig_media' });
  assert.deepEqual(m.media[0], { id: '1801', caption: 'Promo de Natal', type: 'reel', thumb: 'https://x.test/t.jpg', link: 'https://instagram.com/p/1', at: '2026-11-10T10:00:00+0000' });
});

test('comentário com a palavra no Reels: resposta pública, 1ª mensagem como resposta privada, segue o perfil? → link', { skip }, async () => {
  await publish('Comentou EU QUERO', { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { source: 'ig_comment', mode: 'keywords', keywords: ['eu quero'], match: 'contains', posts: 'selected', media_ids: ['1801'], replies: ['Te mandei no Direct! 💌'] }, next: { default: 'b' } },
    { ref: 'b', type: 'send_buttons', data: { text: 'Oi {{primeiro_nome}}! Quer o link?', options: [{ id: 'sim', title: 'Quero o link' }] }, next: { opt_sim: 'c', other: 'c', timeout: 'fim' } },
    { ref: 'c', type: 'condition', data: { match: 'all', rules: [{ kind: 'ig_follows', op: 'follows' }] }, next: { yes: 'link', no: 'segue' } },
    { ref: 'link', type: 'send_text', data: { text: 'Aqui está: https://loja.test' }, next: { sent: 'fim' } },
    { ref: 'segue', type: 'send_text', data: { text: 'Siga o perfil e toque de novo 😉' }, next: { sent: 'fim' } },
    { ref: 'fim', type: 'end', data: {}, next: {} },
  ] });
  await comment(`c1_${stamp}`, 'Nossa, EU QUERO!!', '9999'); // outro post: não vale
  await comment(`c2_${stamp}`, 'que lindo', '1801'); // sem a palavra: não vale
  await run();
  assert.equal(sent.length, 0); assert.equal(replies.length, 0);
  await comment(`c3_${stamp}`, 'Eu quero!', '1801');
  await comment(`c3_${stamp}`, 'Eu quero!', '1801'); // reentrega do Instagram
  assert.deepEqual(replies, [{ comment: `c3_${stamp}`, message: 'Te mandei no Direct! 💌' }]);
  await run();
  assert.equal(sent.length, 1, 'só a 1ª mensagem: depois espera a pessoa responder');
  assert.deepEqual(sent[0].recipient, { comment_id: `c3_${stamp}` });
  assert.equal(sent[0].message.text, 'Oi Carla! Quer o link?');
  assert.equal(sent[0].message.quick_replies[0].title, 'Quero o link');
  const lead = (await pool.query(`select * from public.leads where organization_id = $1 and ig_user_id = $2`, [A.orgId, FAN])).rows[0];
  assert.equal(lead.nome, 'Carla Fã'); assert.equal(lead.ig_comment_id, null, 'resposta privada usada');
  assert.equal((await pool.query(`select flows_started, public_reply from public.ig_comment_events where comment_id = $1`, [`c3_${stamp}`])).rows[0].flows_started, 1);
  // a pessoa toca no botão no Direct: abre a conversa e o fluxo segue
  follows = false;
  await hook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: FAN }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: `m1_${stamp}`, text: 'Quero o link', quick_reply: { payload: 'Quero o link' } } }] }] });
  await run();
  assert.deepEqual(sent.at(-1), { recipient: { id: FAN }, message: { text: 'Siga o perfil e toque de novo 😉' } });
});

test('Direct por palavra-chave e story: só os gatilhos do Instagram; menção no story inicia o fluxo de story', { skip }, async () => {
  await publish('Direct PROMO', { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { source: 'message', channel: 'instagram', mode: 'keywords', keywords: ['promo'], match: 'contains' }, next: { default: 't' } },
    { ref: 't', type: 'send_text', data: { text: 'Promo do dia: 20% OFF' }, next: { sent: 'fim' } }, { ref: 'fim', type: 'end', data: {}, next: {} }] });
  await publish('Zap PROMO', { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { source: 'message', mode: 'keywords', keywords: ['promo'] }, next: { default: 't' } },
    { ref: 't', type: 'send_text', data: { text: 'só no WhatsApp' }, next: { sent: 'fim' } }, { ref: 'fim', type: 'end', data: {}, next: {} }] });
  await publish('Menção no story', { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { source: 'ig_story', story: 'mention' }, next: { default: 't' } },
    { ref: 't', type: 'send_text', data: { text: 'Obrigada pela marcação! 💖' }, next: { sent: 'fim' } }, { ref: 'fim', type: 'end', data: {}, next: {} }] });
  const n = sent.length;
  await hook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: FAN }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: `m2_${stamp}`, text: 'tem PROMO hoje?' } }] }] });
  await run();
  assert.deepEqual(sent.slice(n).map((x) => x.message.text), ['Promo do dia: 20% OFF'], 'o fluxo do WhatsApp não roda no Instagram');
  await hook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: FAN }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: `m3_${stamp}`, attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.test/story.jpg' } }] } }] }] });
  await run();
  assert.equal(sent.at(-1).message.text, 'Obrigada pela marcação! 💖');
  const inb = (await pool.query(`select body, payload from public.whatsapp_inbound_messages where wa_message_id = $1`, [`m3_${stamp}`])).rows[0];
  assert.equal(inb.body, '[mencionou você no story]'); assert.equal(inb.payload.story, 'mention');
});

test('token de 60 dias é renovado sozinho quando faltam menos de 10 dias', { skip }, async () => {
  await pool.query(`update public.meta_channels set token_expires_at = now() + interval '3 days' where organization_id = $1`, [A.orgId]);
  await mc.handle(ctx(), {}, { action: 'ig_media' });
  assert.equal(refreshed, 1);
  const r = (await pool.query(`select token_expires_at from public.meta_channels where organization_id = $1`, [A.orgId])).rows[0];
  assert.ok(new Date(r.token_expires_at) > new Date(Date.now() + 50 * 86400000));
  await mc.handle(ctx(), {}, { action: 'ig_media' });
  assert.equal(refreshed, 1, 'não renova de novo');
});
