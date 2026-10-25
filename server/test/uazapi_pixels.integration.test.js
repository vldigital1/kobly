// WhatsApp por QR Code (Uazapi) e pixels do TikTok/Google contra um Postgres de TESTE. Só as APIs externas são simuladas.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/uazapi_pixels.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
const LEAD_PHONE = `5511977${String(stamp).slice(-6)}`;
let pool, server, base;
const A = {}, B = {};
const net = [];
const uaz = { status: 'connecting' };

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const body = init.body ? JSON.parse(init.body) : null;
  net.push({ host: u.hostname, path: u.pathname, search: u.search, headers: init.headers || {}, body });
  const ok = (b, status = 200) => ({ ok: true, status, json: async () => b });
  if (u.hostname === 'uazapi.test') {
    if (u.pathname === '/instance/create') return init.headers.admintoken === 'admin-123' ? ok({ token: 'inst-token-abc', instance: { name: body.name } }) : { ok: false, status: 401, json: async () => ({}) };
    if (init.headers.token !== 'inst-token-abc') return { ok: false, status: 401, json: async () => ({}) };
    if (u.pathname === '/webhook') return ok({ ok: true });
    if (u.pathname === '/instance/connect') return ok({ instance: { status: 'connecting', qrcode: 'data:image/png;base64,QRQR' } });
    if (u.pathname === '/instance/status') return ok(uaz.status === 'connected'
      ? { instance: { status: 'connected', owner: '5511900001111', profileName: 'Loja Demo' }, status: { connected: true } }
      : { instance: { status: 'connecting', qrcode: 'data:image/png;base64,QR2' } });
    if (u.pathname === '/send/text') return ok({ messageid: `out-${net.length}` });
    if (u.pathname === '/instance/disconnect' || u.pathname === '/instance') return ok({});
  }
  if (u.hostname === 'business-api.tiktok.com') return ok(init.headers['Access-Token'] === 'tt-token-valido-0000000000' ? { code: 0, message: 'OK' } : { code: 40001, message: 'Access token invalid' });
  if (u.hostname === 'www.google-analytics.com') return ok(u.pathname.startsWith('/debug/') ? { validationMessages: u.searchParams.get('api_secret') === 'segredo-ga4' ? [] : [{ description: 'api_secret inválido' }] } : {}, u.pathname.startsWith('/debug/') ? 200 : 204);
  throw new Error('rede não esperada: ' + url);
}
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const fn = async (name, body, token) => { const r = await post(`/functions/v1/${name}`, body, token); const j = await r.json(); return { status: r.status, ...j }; };
async function asUser(userId, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role kobly_authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'kobly_authenticated' })]);
    const r = await c.query(sql, params); await c.query('commit'); return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000, secretKey: KEY.toString('base64'),
    publicBaseUrl: 'https://api.kobly.test', uazapiBase: 'https://uazapi.test', uazapiAdminToken: 'admin-123' };
  ({ server } = createApp({ pool, config, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, nome] of [[A, 'Empresa UZ A'], [B, 'Empresa UZ B']]) {
    const s = await (await post('/auth/signup', { email: `${nome.toLowerCase().replace(/\W/g, '')}${stamp}@kobly.test`, password: 'senha-forte-123', nome })).json();
    who.token = s.session.access_token; who.userId = s.session.user.id;
    who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
  }
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('Uazapi: cria a instância, aponta o webhook, mostra o QR e conecta', { skip }, async () => {
  const c = await fn('uazapi', { action: 'create', label: 'Vendas' }, A.token);
  assert.equal(c.status, 200, JSON.stringify(c)); assert.equal(c.qrcode, 'data:image/png;base64,QRQR'); A.inst = c.instance.id;
  const hook = net.find((x) => x.path === '/webhook');
  assert.match(hook.body.url, /^https:\/\/api\.kobly\.test\/webhooks\/uazapi\/[0-9a-f-]{36}$/); assert.deepEqual(hook.body.events, ['messages', 'connection']);
  A.hook = hook.body.url.replace('https://api.kobly.test', '');
  assert.equal(net.find((x) => x.path === '/instance/create').headers.admintoken, 'admin-123', 'só o servidor usa o admintoken');
  await assert.rejects(asUser(A.userId, `select token_enc from public.whatsapp_uazapi_instances`), /permission denied/);
  assert.equal((await fn('uazapi', { action: 'status', id: A.inst }, A.token)).qrcode, 'data:image/png;base64,QR2');
  uaz.status = 'connected';
  const s = await fn('uazapi', { action: 'status', id: A.inst }, A.token);
  assert.deepEqual([s.status, s.phone, s.profile_name, s.qrcode], ['connected', '5511900001111', 'Loja Demo', null]);
  assert.equal((await fn('uazapi', { action: 'status', id: A.inst }, B.token)).status, 404, 'outra empresa não vê');
  assert.equal((await fn('uazapi', { action: 'list' }, A.token)).configured, true);
});

test('Uazapi: mensagem do lead entra nos Chats e a resposta sai pelo número do QR (sem janela de 24 h)', { skip }, async () => {
  const lead = (await pool.query(`insert into public.leads (organization_id, email, nome, telefone) values ($1,$2,'Ana',$3) returning id`, [A.orgId, `uz${stamp}@x.test`, LEAD_PHONE])).rows[0].id;
  const msg = (token, extra = {}) => ({ EventType: 'messages', owner: '5511900001111', token, BaseUrl: 'https://uazapi.test',
    message: { messageid: `MSG${stamp}`, chatid: `${LEAD_PHONE}@s.whatsapp.net`, sender: `${LEAD_PHONE}@s.whatsapp.net`, senderName: 'Ana', fromMe: false, isGroup: false, messageType: 'Conversation', text: 'Oi, ainda dá pra pagar?', ...extra } });
  assert.equal((await post(A.hook, msg('token-falso'))).status, 401, 'aviso sem o token da instância é recusado');
  assert.equal((await post(A.hook, msg('inst-token-abc'))).status, 200);
  assert.equal((await post(A.hook, msg('inst-token-abc', { messageid: `G${stamp}`, isGroup: true }))).status, 200);
  const rows = (await pool.query(`select body, instance_id, account_id from public.whatsapp_inbound_messages where organization_id = $1`, [A.orgId])).rows;
  assert.equal(rows.length, 1, 'grupo ignorado'); assert.equal(rows[0].instance_id, A.inst); assert.equal(rows[0].account_id, null);
  const conv = (await fn('inbox', { action: 'list' }, A.token)).conversations.find((x) => x.lead_id === lead);
  assert.ok(conv); assert.equal(conv.ultima, 'Oi, ainda dá pra pagar?');

  // janela de 24 h vencida: com só o WhatsApp comum conectado a resposta sai mesmo assim
  await pool.query(`update public.leads set whatsapp_last_inbound_at = now() - interval '3 days' where id = $1`, [lead]);
  assert.equal((await fn('inbox', { action: 'messages', lead_id: lead }, A.token)).lead.janela_aberta, true);
  const sent = await fn('inbox', { action: 'send', lead_id: lead, text: 'Dá sim! Te mando o Pix.' }, A.token);
  assert.equal(sent.status, 200, JSON.stringify(sent));
  const out = net.filter((x) => x.path === '/send/text').at(-1);
  assert.deepEqual(out.body, { number: LEAD_PHONE, text: 'Dá sim! Te mando o Pix.' }); assert.equal(out.headers.token, 'inst-token-abc');
  assert.equal((await pool.query(`select channel from public.whatsapp_outbound_messages where organization_id = $1 and source = 'humano'`, [A.orgId])).rows[0].channel, 'uazapi');

  assert.equal((await fn('uazapi', { action: 'remove', id: A.inst }, A.token)).ok, true);
  assert.equal((await post(A.hook, msg('inst-token-abc', { messageid: `M2${stamp}` }))).status, 404, 'instância excluída não recebe mais');
});

test('Pixels: TikTok e Google salvos por plataforma e testados de verdade', { skip }, async () => {
  assert.equal((await fn('pixel-configs', { action: 'save', provider: 'tiktok', pixel_id: 'c4-minusculo', access_token: 'x'.repeat(30) }, A.token)).status, 422);
  const tt = await fn('pixel-configs', { action: 'save', provider: 'tiktok', pixel_id: 'C4ABC123DEF456', access_token: 'tt-token-valido-0000000000' }, A.token);
  assert.equal(tt.status, 200, JSON.stringify(tt)); assert.equal(tt.pixel.provider, 'tiktok');
  assert.equal((await fn('pixel-configs', { action: 'test', id: tt.pixel.id }, A.token)).status, 200);
  const tcall = net.filter((x) => x.host === 'business-api.tiktok.com').at(-1);
  assert.equal(tcall.path, '/open_api/v1.3/event/track/'); assert.equal(tcall.body.event_source_id, 'C4ABC123DEF456');
  const ttBad = await fn('pixel-configs', { action: 'save', provider: 'tiktok', pixel_id: 'C4ABC123DEF999', access_token: 'tt-token-errado-00000000000' }, A.token);
  assert.equal((await fn('pixel-configs', { action: 'test', id: ttBad.pixel.id }, A.token)).status, 400, 'token recusado aparece no teste');

  assert.equal((await fn('pixel-configs', { action: 'save', provider: 'google', pixel_id: '12345', access_token: 'segredo-ga4' }, A.token)).status, 422);
  const ga = await fn('pixel-configs', { action: 'save', provider: 'google', pixel_id: 'g-abc123xyz', access_token: 'segredo-ga4' }, A.token);
  assert.equal(ga.status, 200, JSON.stringify(ga)); assert.equal(ga.pixel.pixel_id, 'G-ABC123XYZ');
  assert.equal((await fn('pixel-configs', { action: 'test', id: ga.pixel.id }, A.token)).status, 200);
  const g = net.filter((x) => x.host === 'www.google-analytics.com').at(-1);
  assert.equal(g.path, '/debug/mp/collect', 'o teste usa a validação do Google'); assert.match(g.search, /measurement_id=G-ABC123XYZ/);
  const gaBad = await fn('pixel-configs', { action: 'save', provider: 'google', pixel_id: 'G-ABC123XYZ', access_token: 'segredo-errado' }, A.token);
  assert.equal((await fn('pixel-configs', { action: 'test', id: gaBad.pixel.id }, A.token)).status, 400);
  const meta = await fn('pixel-configs', { action: 'save', pixel_id: '123456789', access_token: 'm'.repeat(30) }, A.token);
  assert.equal(meta.pixel.provider, 'meta', 'sem provedor continua sendo o da Meta');
  assert.deepEqual((await fn('pixel-configs', { action: 'list' }, A.token)).pixels.map((p) => p.provider).sort(), ['google', 'google', 'meta', 'tiktok', 'tiktok']);
});
