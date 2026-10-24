// Motor de fluxos ponta a ponta contra um Postgres de TESTE já com o esquema do Kobly aplicado
// (bootstrap + migrações + 900_grants). Só a Meta e a XPag são simuladas (na rede); banco, RLS,
// rotas HTTP, postback, webhooks e motor são os de verdade.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/flows.integration.test.js   (sem a variável, é ignorado)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { encrypt } from '../src/whatsapp/crypto.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const APP_SECRET = 'segredo-do-app-meta-teste';
let pool, server, flows, base;
const meta = []; // chamadas à Meta
const xpag = { charges: new Map(), confirmed: new Set() };
const A = {}, B = {};

const fakeGraph = {
  getPhoneNumber: async () => ({ display_phone_number: '+52 55 0000 0000', verified_name: 'Loja Teste' }),
  getWaba: async () => ({ id: 'w' }), listTemplates: async () => [], subscribeApp: async () => ({}),
  sendTemplate: async (pid, tok, a) => { meta.push({ tipo: 'template', ...a, tok }); return { messages: [{ id: `wamid.out${meta.length}` }] }; },
  sendText: async (pid, tok, a) => { meta.push({ tipo: 'texto', ...a }); return { messages: [{ id: `wamid.out${meta.length}` }] }; },
  sendMedia: async (pid, tok, a) => { meta.push({ tipo: 'midia', ...a }); return { messages: [{ id: `wamid.out${meta.length}` }] }; },
  sendInteractive: async (pid, tok, a) => { meta.push({ tipo: 'botoes', ...a }); return { messages: [{ id: `wamid.out${meta.length}` }] }; },
  typing: async () => ({}),
};
// XPag simulada na rede (o adaptador real monta as requisições)
async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  if (u.hostname === 'api.xpag.global') {
    if (init.headers['X-Client-Secret'] !== 'segredo-xpag-teste') return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ ok: false, error_code: 'invalid_credentials', error: 'Credenciais inválidas' }) };
    if (u.pathname === '/balance') return ok({ ok: true, balances: {} });
    if (u.pathname === '/cashin') {
      const b = JSON.parse(init.body); const tx = `pr_${xpag.charges.size + 1}`;
      xpag.charges.set(tx, b);
      return ok({ ok: true, clabe: '646180000000000001', reference: 'REF1', bank_name: 'STP', transaction_id: tx, request_number: tx, status: 'pending', amount: b.amount });
    }
    if (u.pathname === '/consult-transaction') { const tx = u.searchParams.get('transaction_id'); return ok({ ok: true, status: xpag.confirmed.has(tx) ? 'confirmed' : 'pending', amount: 45 }); }
  }
  throw new Error('rede não esperada no teste: ' + url);
}

const post = (path, body, token, extraHeaders = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const fn = async (name, body, token) => { const r = await post(`/functions/v1/${name}`, body, token); const j = await r.json(); return { status: r.status, ...j }; };
// consulta COMO o usuário (RLS de verdade), como o PostgREST faria
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
  const org = await asUser(who.userId, `select (public.create_own_org($1)).id as id`, [nome]);
  who.orgId = org.rows[0].id;
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  const config = { jwtSecret: 'segredo-jwt-integracao', requireConfirm: false, allowedOrigins: [], loginPerMin: 1000, signupPerMin: 1000,
    secretKey: KEY.toString('base64'), publicBaseUrl: 'https://api.kobly.test', metaAppSecret: APP_SECRET, xpagBase: 'https://api.xpag.global' };
  ({ server, flows } = createApp({ pool, config, graph: fakeGraph, fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await newOrg(A, 'Empresa A'); await newOrg(B, 'Empresa B');
  // dados da empresa A: campanha ativa, WhatsApp oficial, modelo aprovado, token de postback, etiqueta
  A.campaign = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,'Recuperação Pix MX','Ativa') returning id`, [A.orgId])).rows[0].id;
  const acc = (await pool.query(`insert into public.whatsapp_accounts (organization_id, waba_id, phone_number_id, status, verify_token, token_enc) values ($1,'111','222','connected','vt',$2) returning id, webhook_public_id`, [A.orgId, encrypt('token-meta-A', KEY)])).rows[0];
  A.webhook = acc.webhook_public_id;
  A.template = (await pool.query(`insert into public.whatsapp_templates (organization_id, account_id, name, language, category, status, components, body_text, variable_count) values ($1,$2,'recuperacao_pix','es_MX','MARKETING','APPROVED','[]','Hola {{1}}',1) returning id`, [A.orgId, acc.id])).rows[0].id;
  A.pbk = (await pool.query(`insert into public.postback_tokens (organization_id, nome) values ($1,'Checkout') returning token`, [A.orgId])).rows[0].token;
  A.tag = (await pool.query(`insert into public.tags (organization_id, nome) values ($1,'Pagou no fluxo') returning id`, [A.orgId])).rows[0].id;
});
after(async () => { if (skip) return; await new Promise((r) => server.close(r)); await pool.end(); });

const graph = () => ({ version: 1, start: 'ini', nodes: [
  { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'tpl' } },
  { ref: 'tpl', type: 'send_template', data: { template_id: A.template, vars: ['primeiro_nome'] }, next: { sent: 'esp' } },
  { ref: 'esp', type: 'wait_reply', data: { timeout_minutes: 60 }, next: { reply: 'cond', timeout: 'fim' } },
  { ref: 'cond', type: 'condition', data: { rules: [{ kind: 'var', name: 'resposta', op: 'contains', value: 'quiero' }] }, next: { yes: 'pg', no: 'fim' } },
  { ref: 'pg', type: 'payment', data: { integration_id: A.integration, currency: 'MXN', method: 'SPEI', amount: '45' }, next: { charge_created: 'cod', payment_approved: 'venda', error: 'fim' } },
  { ref: 'cod', type: 'send_text', data: { text: 'CLABE {{pagamento_codigo}} ({{pagamento_banco}})' }, next: { sent: 'esp2' } },
  { ref: 'esp2', type: 'wait_reply', data: { timeout_minutes: 120 }, next: { reply: 'fim', timeout: 'fim' } },
  { ref: 'venda', type: 'record_sale', data: {}, next: { default: 'etq' } },
  { ref: 'etq', type: 'tag', data: { add: [A.tag] }, next: { default: 'fim' } },
  { ref: 'fim', type: 'end', data: {}, next: {} },
] });
// roda o motor até não sobrar nada vencido; se uma rodada automática (resposta/aviso) estiver em curso, espera ela acabar
const waitIdle = async () => {
  for (let i = 0; i < 300; i++) {
    const st = await flows.tick();
    if (st.busy) { await new Promise((r) => setTimeout(r, 30)); continue; }
    if (!st.claimed) return;
  }
  throw new Error('motor não ficou ocioso');
};
const exec = async () => (await pool.query(`select * from public.flow_executions where campaign_id = $1`, [A.campaign])).rows[0];

test('conta XPag: credencial errada é recusada; a certa fica cifrada e invisível ao cliente', { skip }, async () => {
  const bad = await fn('payment-integrations', { action: 'connect', provider: 'xpag', client_id: 'cliente-teste', client_secret: 'segredo-errado' }, A.token);
  assert.equal(bad.status, 400); assert.match(bad.message, /Credenciais inválidas/);
  const ok = await fn('payment-integrations', { action: 'connect', provider: 'xpag', client_id: 'cliente-teste', client_secret: 'segredo-xpag-teste' }, A.token);
  assert.equal(ok.status, 200); A.integration = ok.integration.id;
  const raw = (await pool.query(`select secret_enc from public.payment_integrations where id = $1`, [A.integration])).rows[0].secret_enc;
  assert.equal(raw.includes('segredo-xpag-teste'), false);
  await assert.rejects(asUser(A.userId, `select secret_enc from public.payment_integrations`), /permission denied/);
  assert.equal((await asUser(A.userId, `select id from public.payment_integrations`)).rowCount, 1);
});

test('publicar o fluxo: validação no servidor e versão ativa', { skip }, async () => {
  const bad = await fn('flow-graph', { action: 'save', campaign_id: A.campaign, graph: { version: 1, start: 'x', nodes: [] } }, A.token);
  assert.equal(bad.status, 422);
  const r = await fn('flow-graph', { action: 'save', campaign_id: A.campaign, graph: graph() }, A.token);
  assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.version, 1); assert.deepEqual(r.warnings, []);
  assert.equal((await fn('flow-graph', { action: 'save', campaign_id: A.campaign, graph: graph() }, B.token)).status, 404, 'outra empresa não mexe na campanha');
});

test('ponta a ponta: Pix gerado → modelo → resposta → cobrança SPEI → pagamento confirmado → venda', { skip }, async () => {
  const phone = '5215512345678';
  const pb = await post(`/functions/v1/postback-receiver?token=${A.pbk}`, { event: 'pix_generated', email: 'rosa@cliente.test', name: 'Rosa Diaz', phone, product: 'Guia', value: 45 });
  const pj = await pb.json();
  assert.equal(pj.fluxos_iniciados, 1, JSON.stringify(pj)); assert.equal(pj.enqueued, 0, 'campanha em grafo não usa o motor antigo');
  await waitIdle();
  assert.deepEqual(meta.map((m) => m.tipo), ['template']);
  assert.equal(meta[0].to, phone); assert.equal(meta[0].tok, 'token-meta-A', 'token da Meta decifrado só no envio');
  assert.equal((await exec()).current_ref, 'esp');

  // resposta do lead pelo webhook oficial (assinatura HMAC conferida de verdade)
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '222' }, messages: [{ id: `wamid.in${Date.now()}`, from: phone, type: 'text', text: { body: 'Sí, quiero' } }] } }] }] });
  const forged = await post(`/webhooks/whatsapp/${A.webhook}`, body, null, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
  assert.equal(forged.status, 403, 'assinatura falsa é recusada');
  const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
  assert.equal((await post(`/webhooks/whatsapp/${A.webhook}`, body, null, { 'x-hub-signature-256': sig })).status, 200);
  assert.equal((await post(`/webhooks/whatsapp/${A.webhook}`, body, null, { 'x-hub-signature-256': sig })).status, 200, 'reentrega aceita e ignorada');
  await waitIdle();
  const ch = (await pool.query(`select * from public.payment_charges where campaign_id = $1`, [A.campaign])).rows;
  assert.equal(ch.length, 1, 'uma cobrança só, mesmo com o aviso repetido');
  assert.equal(ch[0].status, 'pending'); assert.equal(Number(ch[0].amount), 45); assert.equal(ch[0].currency, 'MXN');
  assert.equal(xpag.charges.get(ch[0].transaction_id).webhook_url, `https://api.kobly.test/webhooks/payments/xpag/${(await pool.query(`select webhook_token from public.payment_integrations where id = $1`, [A.integration])).rows[0].webhook_token}`);
  assert.deepEqual(meta.slice(1).map((m) => [m.tipo, m.text]), [['texto', 'CLABE 646180000000000001 (STP)']], 'janela aberta pela resposta → texto livre');
  assert.equal((await exec()).current_ref, 'esp2');

  // aviso da XPag: só vale depois que a consulta na API confirma
  const token = (await pool.query(`select webhook_token from public.payment_integrations where id = $1`, [A.integration])).rows[0].webhook_token;
  const aviso = { type: 'cashin', status: 'confirmed', transaction_id: ch[0].transaction_id, external_id: ch[0].external_id, e2e: 'E2E1' };
  const cedo = await (await post(`/webhooks/payments/xpag/${token}`, aviso)).json();
  assert.equal(cedo.status, 'pending', 'aviso falso/antecipado não libera nada');
  xpag.confirmed.add(ch[0].transaction_id);
  const aviso2 = { ...aviso, e2e: 'E2E2' };
  assert.equal((await (await post(`/webhooks/payments/xpag/${token}`, aviso2)).json()).confirmed, true);
  assert.equal((await (await post(`/webhooks/payments/xpag/${token}`, aviso2)).json()).deduped, true);
  assert.equal((await post(`/webhooks/payments/xpag/token-que-nao-existe-123456789`, aviso2)).status, 404);
  await waitIdle();
  const e = await exec();
  assert.equal(e.status, 'completed', JSON.stringify({ ref: e.current_ref, err: e.last_error }));
  const sales = (await pool.query(`select amount, currency from public.flow_sales where campaign_id = $1`, [A.campaign])).rows;
  assert.deepEqual(sales.map((s) => [Number(s.amount), s.currency]), [[45, 'MXN']]);
  assert.equal((await pool.query(`select vendas_recuperadas from public.campaign_stats where campaign_id = $1`, [A.campaign])).rows[0].vendas_recuperadas, 1);
  assert.equal((await pool.query(`select count(*)::int n from public.lead_tags where tag_id = $1`, [A.tag])).rows[0].n, 1);
  const trilha = (await pool.query(`select ref || ':' || outcome as p from public.flow_execution_events where execution_id = $1 order by id`, [e.id])).rows.map((r) => r.p);
  assert.deepEqual(trilha, ['ini:default', 'tpl:sent', 'esp:waiting_reply', 'esp:reply', 'cond:yes', 'pg:charge_created', 'cod:sent', 'esp2:waiting_reply', 'pg:payment_confirmed', 'pg:payment_approved', 'venda:default', 'etq:default', 'fim:completed']);
});

test('postback seguro: URL antiga segue valendo e fica registrada; modo estrito exige assinatura no cabeçalho', { skip }, async () => {
  const ev = (email) => JSON.stringify({ event: 'cart_abandoned', email, name: 'Teste' });
  // compatibilidade: só a URL continua aceita (modo legado) e marca last_unsigned_at
  assert.equal((await post(`/functions/v1/postback-receiver?token=${A.pbk}`, ev('legado@x.test'))).status, 200);
  const row = (await pool.query(`select id, signing_secret, last_unsigned_at from public.postback_tokens where token = $1`, [A.pbk])).rows[0];
  assert.ok(row.last_unsigned_at, 'uso só pela URL fica registrado para a tela avisar');
  assert.match(row.signing_secret, /^[0-9a-f]{64}$/, 'todo token ganha um segredo de assinatura');

  await pool.query(`update public.postback_tokens set require_signature = true where id = $1`, [row.id]);
  const semAss = await post(`/functions/v1/postback-receiver?token=${A.pbk}`, ev('estrito@x.test'));
  assert.equal(semAss.status, 401); assert.equal((await semAss.json()).error, 'assinatura_obrigatoria');

  // token no cabeçalho (fora da URL) + assinatura HMAC
  const { signPostback } = await import('../src/ingest/auth.js');
  const corpo = ev('assinado@x.test'); const t = Math.floor(Date.now() / 1000);
  const ok = await post('/functions/v1/postback-receiver', corpo, null, { 'x-kobly-token': A.pbk, 'x-kobly-signature': `t=${t},v1=${signPostback(row.signing_secret, t, corpo)}` });
  assert.equal(ok.status, 200, await ok.clone().text());
  const forjado = await post('/functions/v1/postback-receiver', corpo, null, { 'x-kobly-token': A.pbk, 'x-kobly-signature': `t=${t},v1=${signPostback('segredo-roubado-errado', t, corpo)}` });
  assert.equal(forjado.status, 401);
  assert.equal((await pool.query(`select count(*)::int n from public.leads where organization_id = $1 and email in ('estrito@x.test')`, [A.orgId])).rows[0].n, 0, 'evento recusado não cria lead');
  assert.equal((await pool.query(`select count(*)::int n from public.leads where organization_id = $1 and email = 'assinado@x.test'`, [A.orgId])).rows[0].n, 1);
  await pool.query(`update public.postback_tokens set require_signature = false where id = $1`, [row.id]);
});

test('RLS: cada empresa só enxerga as próprias execuções, cobranças e caixa de entrada', { skip }, async () => {
  for (const t of ['flow_executions', 'payment_charges', 'whatsapp_inbound_messages', 'flow_graph_versions', 'flow_sales']) {
    assert.ok((await asUser(A.userId, `select count(*)::int n from public.${t}`)).rows[0].n >= 1, `A vê ${t}`);
    assert.equal((await asUser(B.userId, `select count(*)::int n from public.${t}`)).rows[0].n, 0, `B não vê ${t} de A`);
  }
  await assert.rejects(asUser(A.userId, `update public.flow_executions set status = 'cancelled'`), /permission denied/, 'cliente não escreve direto no motor');
  await assert.rejects(asUser(A.userId, `select token_enc from public.whatsapp_accounts`), /permission denied/);
});

test('métricas, copiloto, MCP (rascunho) e publicação do rascunho com revalidação', { skip }, async () => {
  const st = await fn('flow-graph', { action: 'stats', campaign_id: A.campaign }, A.token);
  assert.equal(st.status, 200); assert.ok(st.by_ref.find((r) => r.ref === 'venda').leads === 1);
  const cp = await fn('flow-graph', { action: 'copilot', campaign_id: A.campaign }, A.token);
  assert.equal(cp.status, 200); assert.equal(cp.leads, 1); assert.ok(Array.isArray(cp.suggestions));

  const tk = await fn('mcp-tokens', { action: 'create', label: 'Claude' }, A.token);
  const rpc = async (id, name, args) => { const r = await post('/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, tk.token); return JSON.parse((await r.json()).result.content[0].text); };
  const rec = await rpc(1, 'kobly_recursos', {});
  assert.equal(rec.modelos[0].id, A.template); assert.equal(JSON.stringify(rec).includes('segredo'), false);
  const g2 = graph(); g2.nodes.find((n) => n.ref === 'esp').data.timeout_minutes = 360;
  const draft = await rpc(2, 'kobly_salvar_rascunho', { campaign_id: A.campaign, graph: g2, nota: 'esperar 6 h' });
  assert.equal(draft.draft, true); assert.equal(draft.version, 2);
  const ativo = (await pool.query(`select v.version from public.flow_graph_versions v join public.campaign_flows f on f.id = v.flow_id where f.campaign_id = $1 and v.is_active`, [A.campaign])).rows;
  assert.deepEqual(ativo.map((r) => r.version), [1], 'rascunho da IA não muda o fluxo publicado');
  const outraEmpresa = await rpc(3, 'kobly_ler_fluxo', { campaign_id: (await pool.query(`insert into public.campaigns (organization_id, nome) values ($1,'De B') returning id`, [B.orgId])).rows[0].id });
  assert.match(outraEmpresa.erro, /não encontrada/, 'o token de A não alcança campanha de B');
  const pub = await fn('flow-graph', { action: 'activate', campaign_id: A.campaign, version: 2 }, A.token);
  assert.equal(pub.status, 200);
  const v = (await pool.query(`select version, is_active, is_draft, source from public.flow_graph_versions v join public.campaign_flows f on f.id = v.flow_id where f.campaign_id = $1 order by version`, [A.campaign])).rows;
  assert.deepEqual(v.map((x) => [x.version, x.is_active, x.is_draft, x.source]), [[1, false, false, 'editor'], [2, true, false, 'mcp']]);
});
