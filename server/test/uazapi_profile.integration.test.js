// WhatsApp por QR Code: pausar fluxos ao desconectar (e voltar ao reconectar) e editar o perfil.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/uazapi_profile.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createUazapi } from '../src/whatsapp/uazapi.js';
import { encrypt } from '../src/whatsapp/crypto.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();
let pool, uaz;
const A = {};
const net = [];

async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  net.push({ path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.pathname === '/instance/status') return ok({ instance: { status: 'connected', owner: '5547999990000', profileName: 'Loja Nova', profilePicUrl: 'https://pps.whatsapp.net/x.jpg', isBusiness: true } });
  if (u.pathname.startsWith('/profile/')) return ok({ success: true });
  if (u.pathname === '/chat/find') return ok({ chats: [], pagination: { hasMore: false } }); // histórico ao conectar: nada a importar
  throw new Error('rede não esperada: ' + url);
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  uaz = createUazapi({ pool, secretKey: KEY, base: 'https://uaz.test', adminToken: 'adm-0000000', fetchImpl: fakeFetch });
  A.orgId = (await pool.query(`insert into public.organizations (nome) values ('Loja Pausa') returning id`)).rows[0].id;
  A.inst = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,'Vendas',$2,$3,'connected') returning id, webhook_public_id`,
    [A.orgId, `pausa-${stamp}`, encrypt('tok-inst-1', KEY)])).rows[0];
  // dois fluxos publicados ativos e um pausado à mão (este não pode voltar sozinho)
  A.camps = [];
  for (const [nome, st] of [['F1', 'Ativa'], ['F2', 'Ativa'], ['F3', 'Pausada']]) {
    const c = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,$2,$3) returning id`, [A.orgId, nome, st])).rows[0].id;
    const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [c, A.orgId])).rows[0].id;
    await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,'{}',true)`, [A.orgId, f]);
    A.camps.push(c);
  }
});
after(async () => { if (skip) return; await pool.end(); });

const statuses = async () => (await pool.query(`select nome, status_campanha from public.campaigns where organization_id = $1 order by nome`, [A.orgId])).rows.map((r) => r.status_campanha);
const hook = (status) => uaz.receiveWebhook(A.inst.webhook_public_id, JSON.stringify({ EventType: 'connection', token: 'tok-inst-1', instance: { status } }));
const ctx = { orgId: null, role: 'Cliente' };

test('sem a opção ligada, cair não pausa nada', { skip }, async () => {
  await hook('disconnected');
  assert.deepEqual(await statuses(), ['Ativa', 'Ativa', 'Pausada']);
  await hook('connected');
});

test('com a opção: cai → pausa os ativos; volta → reativa só os que pausou', { skip }, async () => {
  ctx.orgId = A.orgId;
  await uaz.handle(ctx, {}, { action: 'settings', id: A.inst.id, pause_flows_on_disconnect: true });
  await hook('disconnected');
  assert.deepEqual(await statuses(), ['Pausada', 'Pausada', 'Pausada']);
  await hook('connected');
  assert.deepEqual(await statuses(), ['Ativa', 'Ativa', 'Pausada'], 'F3 já estava pausado e continua');
});

test('outro número conectado na empresa: não pausa', { skip }, async () => {
  await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,'Suporte',$2,'x','connected')`, [A.orgId, `pausa2-${stamp}`]);
  await hook('disconnected');
  assert.deepEqual(await statuses(), ['Ativa', 'Ativa', 'Pausada']);
  await hook('connected');
});

test('editar perfil: nome até 25, foto só JPEG, remover', { skip }, async () => {
  await assert.rejects(uaz.handle(ctx, {}, { action: 'profile', id: A.inst.id, name: 'x'.repeat(26) }), /1 a 25/);
  await assert.rejects(uaz.handle(ctx, {}, { action: 'profile', id: A.inst.id, image: 'data:image/png;base64,AAAA' }), /JPEG/);
  const r = await uaz.handle(ctx, {}, { action: 'profile', id: A.inst.id, name: 'Loja Nova', image: 'data:image/jpeg;base64,/9j/AAAA' });
  assert.equal(r.profile_name, 'Loja Nova'); assert.equal(r.profile_pic_url, 'https://pps.whatsapp.net/x.jpg');
  assert.deepEqual(net.filter((n) => n.path.startsWith('/profile/')).map((n) => [n.path, Object.keys(n.body)[0]]), [['/profile/name', 'name'], ['/profile/image', 'image']]);
  await uaz.handle(ctx, {}, { action: 'profile', id: A.inst.id, remove_image: true });
  assert.deepEqual(net.at(-2).body, { image: 'remove' });
  await assert.rejects(uaz.handle({ orgId: A.orgId, role: 'Suporte' }, {}, { action: 'profile', id: A.inst.id, name: 'x' }), /não pode/);
});

test('lead que responde "SAIR" pelo QR Code deixa de receber WhatsApp', { skip }, async () => {
  const lead = (await pool.query(`insert into public.leads (organization_id, nome, telefone) values ($1,'Zé','(11) 98765-4321') returning id`, [A.orgId])).rows[0].id;
  const msg = (text, id) => uaz.receiveWebhook(A.inst.webhook_public_id, JSON.stringify({ EventType: 'messages', token: 'tok-inst-1', message: { messageid: id, sender: '5511987654321@s.whatsapp.net', text, fromMe: false } }));
  await msg('quero saber o preço', `m1-${stamp}`);
  assert.equal((await pool.query(`select whatsapp_opt_out from public.leads where id = $1`, [lead])).rows[0].whatsapp_opt_out, false);
  await msg('Sair', `m2-${stamp}`);
  assert.equal((await pool.query(`select whatsapp_opt_out from public.leads where id = $1`, [lead])).rows[0].whatsapp_opt_out, true);
});
