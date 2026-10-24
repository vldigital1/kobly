// Chats ao vivo, Configurações da automação e lista de Fluxos contra um Postgres de TESTE com o
// esquema do Kobly (mesmo preparo de flows.integration). Só a Meta é simulada.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/workspace.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { encrypt } from '../src/whatsapp/crypto.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const APP_SECRET = 'segredo-do-app-meta-teste-ws';
let pool, server, flows, base;
const meta = [];
const A = {}, B = {};
const PHONE = `5215598${String(Date.now()).slice(-6)}`;

const fakeGraph = {
  getPhoneNumber: async () => ({ display_phone_number: '+52', verified_name: 'Loja' }),
  getWaba: async () => ({ id: 'w' }), listTemplates: async () => [], subscribeApp: async () => ({}),
  sendTemplate: async (pid, tok, a) => { meta.push({ tipo: 'template', ...a }); return { messages: [{ id: `wamid.ws${Date.now()}${meta.length}` }] }; },
  sendText: async (pid, tok, a) => { meta.push({ tipo: 'texto', ...a }); return { messages: [{ id: `wamid.ws${Date.now()}${meta.length}` }] }; },
  sendMedia: async () => ({ messages: [{ id: 'm' }] }), sendInteractive: async () => ({ messages: [{ id: 'i' }] }), typing: async () => ({}),
};

const post = (path, body, token, extraHeaders = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const fn = async (name, body, token) => { const r = await post(`/functions/v1/${name}`, body, token); const j = await r.json(); return { status: r.status, ...j }; };
async function asUser(userId, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role kobly_authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'kobly_authenticated' })]);
    const r = await c.query(sql, params); await c.query('commit'); return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
async function newOrg(who, nome) {
  const email = `${nome.toLowerCase().replace(/\W/g, '')}${Date.now()}@kobly.test`;
  const s = await (await post('/auth/signup', { email, password: 'senha-forte-123', nome })).json();
  who.token = s.session.access_token; who.userId = s.session.user.id;
  who.orgId = (await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome])).rows[0].id;
}
const waitIdle = async () => {
  for (let i = 0; i < 300; i++) {
    const st = await flows.tick();
    if (st.busy) { await new Promise((r) => setTimeout(r, 30)); continue; }
    if (!st.claimed) return;
  }
  throw new Error('motor não ficou ocioso');
};
const inbound = async (text) => {
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: A.pnid }, messages: [{ id: `wamid.wsin${Date.now()}${Math.random()}`, from: PHONE, type: 'text', text: { body: text } }] } }] }] });
  const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
  assert.equal((await post(`/webhooks/whatsapp/${A.webhook}`, body, null, { 'x-hub-signature-256': sig })).status, 200);
};

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000,
    secretKey: KEY.toString('base64'), publicBaseUrl: 'https://api.kobly.test', metaAppSecret: APP_SECRET };
  ({ server, flows } = createApp({ pool, config, graph: fakeGraph, fetchImpl: async () => { throw new Error('rede não esperada'); } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await newOrg(A, 'Empresa WS A'); await newOrg(B, 'Empresa WS B');
  A.pnid = `pn${Date.now()}`;
  A.campaign = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,'Fluxo WS','Ativa') returning id`, [A.orgId])).rows[0].id;
  const acc = (await pool.query(`insert into public.whatsapp_accounts (organization_id, waba_id, phone_number_id, status, verify_token, token_enc) values ($1,'w1',$2,'connected','vt',$3) returning id, webhook_public_id`, [A.orgId, A.pnid, encrypt('token-meta', KEY)])).rows[0];
  A.webhook = acc.webhook_public_id;
  A.pbk = (await pool.query(`insert into public.postback_tokens (organization_id, nome) values ($1,'Checkout') returning token`, [A.orgId])).rows[0].token;
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

test('configurações: respostas rápidas, variáveis e agentes presos à empresa', { skip }, async () => {
  const qr = await fn('workspace-settings', { action: 'upsert', kind: 'quick_reply', item: { shortcut: 'pix', body: 'Seu Pix: {{pagamento_codigo}}' } }, A.token);
  assert.equal(qr.status, 200, JSON.stringify(qr));
  assert.equal((await fn('workspace-settings', { action: 'upsert', kind: 'quick_reply', item: { shortcut: 'pix', body: 'outra' } }, A.token)).status, 409, 'atalho duplicado');
  assert.equal((await fn('workspace-settings', { action: 'upsert', kind: 'global_var', item: { key: 'Cupom X', value: '1' } }, A.token)).status, 422, 'chave inválida');
  assert.equal((await fn('workspace-settings', { action: 'upsert', kind: 'global_var', item: { key: 'cupom', value: 'VOLTA10' } }, A.token)).status, 200);
  const ag = await fn('workspace-settings', { action: 'upsert', kind: 'agent', item: { name: 'Vendedora', objective: 'Levar o lead a pagar.', max_turns: 5 } }, A.token);
  assert.equal(ag.status, 200); A.agent = ag.item.id; assert.equal(ag.item.max_turns, 5);
  assert.equal((await fn('workspace-settings', { action: 'update_org', nome: 'Empresa WS A', timezone: 'Marte/Base' }, A.token)).status, 422);
  assert.equal((await fn('workspace-settings', { action: 'update_org', nome: 'Empresa WS A', timezone: 'America/Mexico_City' }, A.token)).status, 200);

  const got = await fn('workspace-settings', { action: 'get' }, A.token);
  assert.equal(got.org.timezone, 'America/Mexico_City');
  assert.deepEqual(got.quick_replies.map((q) => q.shortcut), ['pix']);
  // outra empresa: não vê, não edita, não apaga
  assert.equal((await fn('workspace-settings', { action: 'get' }, B.token)).agents.length, 0);
  assert.equal((await asUser(B.userId, `select id from public.ai_agents`)).rowCount, 0, 'RLS');
  assert.equal((await fn('workspace-settings', { action: 'upsert', kind: 'agent', item: { id: A.agent, name: 'x', objective: 'y' } }, B.token)).status, 404);
  assert.equal((await fn('workspace-settings', { action: 'delete', kind: 'agent', id: A.agent }, B.token)).ok, false);
  // o cliente só lê: escrever direto pelo PostgREST é negado
  await assert.rejects(asUser(A.userId, `insert into public.global_variables (organization_id, key) values ($1,'hack')`, [A.orgId]), /permission denied/);
});

test('fluxo usa {{global.*}}, registra a conversa e aparece na lista de Fluxos', { skip }, async () => {
  const g = { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'esp' } },
    { ref: 'esp', type: 'wait_reply', data: { timeout_minutes: 60 }, next: { reply: 'txt', timeout: 'fim' } },
    { ref: 'txt', type: 'send_text', data: { text: 'Use o cupom {{global.cupom}}, {{primeiro_nome}}!' }, next: { sent: 'ag' } },
    { ref: 'ag', type: 'ai_agent', data: { agent_id: '00000000-0000-0000-0000-000000000000' }, next: { error: 'fim' } },
    { ref: 'fim', type: 'end', data: {}, next: {} },
  ] };
  const saved = await fn('flow-graph', { action: 'save', campaign_id: A.campaign, graph: g }, A.token);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.ok(saved.warnings.some((w) => /Agente de IA .* não existe/.test(w)), 'agente de outra empresa/inexistente vira aviso');
  const list = await fn('flow-graph', { action: 'list' }, A.token);
  const row = list.flows.find((f) => f.campaign_id === A.campaign);
  assert.equal(row.active_version, 1); assert.deepEqual(row.eventos, ['Pix Gerado']);
  assert.equal((await fn('flow-graph', { action: 'list' }, B.token)).flows.length, 0);

  const pb = await (await post(`/functions/v1/postback-receiver?token=${A.pbk}`, { event: 'pix_generated', email: `ana${Date.now()}@cliente.test`, name: 'Ana Ruiz', phone: PHONE, product: 'Guia', value: 45 })).json();
  assert.equal(pb.fluxos_iniciados, 1, JSON.stringify(pb));
  await waitIdle();
  await inbound('Hola, ¿cómo pago?');
  await waitIdle();
  const txt = meta.find((m) => m.tipo === 'texto');
  assert.equal(txt.text, 'Use o cupom VOLTA10, Ana!');
  const ev = (await pool.query(`select outcome, detail from public.flow_execution_events where ref = 'ag' and organization_id = $1`, [A.orgId])).rows[0];
  assert.equal(ev.outcome, 'error'); assert.match(ev.detail, /agente de IA salvo não encontrado/);
  const out = (await pool.query(`select source, body, lead_id from public.whatsapp_outbound_messages where organization_id = $1`, [A.orgId])).rows;
  assert.deepEqual(out.map((o) => [o.source, o.body]), [['fluxo', 'Use o cupom VOLTA10, Ana!']]);
  A.lead = out[0].lead_id;
});

test('chats ao vivo: conversa, resposta humana na janela, assumir pausa a automação', { skip }, async () => {
  const list = await fn('inbox', { action: 'list' }, A.token);
  const c = list.conversations.find((x) => x.lead_id === A.lead);
  assert.ok(c, JSON.stringify(list)); assert.equal(c.janela_aberta, true); assert.equal(c.ultima_de, 'fluxo');
  assert.equal((await fn('inbox', { action: 'list' }, B.token)).conversations.length, 0);
  assert.equal((await fn('inbox', { action: 'messages', lead_id: A.lead }, B.token)).status, 404, 'outra empresa não lê');

  const sent = await fn('inbox', { action: 'send', lead_id: A.lead, text: 'Oi Ana, sou da equipe.' }, A.token);
  assert.equal(sent.status, 200, JSON.stringify(sent)); assert.equal(sent.message.de, 'humano');
  assert.equal(meta.at(-1).text, 'Oi Ana, sou da equipe.');
  const msgs = await fn('inbox', { action: 'messages', lead_id: A.lead }, A.token);
  assert.deepEqual(msgs.messages.map((m) => m.de), ['lead', 'fluxo', 'humano']);

  // fluxo novo esperando resposta → assumir encerra e impede novos fluxos e retomadas
  await pool.query(`update public.flow_executions set status = 'completed' where lead_id = $1`, [A.lead]);
  await post(`/functions/v1/postback-receiver?token=${A.pbk}`, { event: 'pix_generated', email: (await pool.query(`select email from public.leads where id = $1`, [A.lead])).rows[0].email, name: 'Ana Ruiz', phone: PHONE, value: 45 });
  await waitIdle();
  const p = await fn('inbox', { action: 'pause', lead_id: A.lead, paused: true }, A.token);
  assert.equal(p.cancelled, 1, JSON.stringify(p));
  const pb = await (await post(`/functions/v1/postback-receiver?token=${A.pbk}`, { event: 'pix_generated', email: (await pool.query(`select email from public.leads where id = $1`, [A.lead])).rows[0].email, name: 'Ana Ruiz', phone: PHONE, value: 45 })).json();
  assert.equal(pb.fluxos_iniciados, 0, 'lead pausado não entra em fluxo');
  assert.equal((await fn('inbox', { action: 'pause', lead_id: A.lead, paused: false }, A.token)).paused, false);

  // janela fechada: texto livre é recusado
  await pool.query(`update public.leads set whatsapp_last_inbound_at = now() - interval '25 hours' where id = $1`, [A.lead]);
  const closed = await fn('inbox', { action: 'send', lead_id: A.lead, text: 'oi' }, A.token);
  assert.equal(closed.status, 409); assert.match(closed.message, /24 h/);
});
