// Fluxo: gatilho por mensagem (qualquer texto / palavras-chave), anúncio de origem, saudação personalizada,
// responder e reagir à última mensagem do lead, visualização única, Conectar fluxo e Webhook.
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/flow_extras.integration.test.js   (sem a variável, só os testes puros)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createFlowRuntime, keywordHit, blockedHost } from '../src/flows/runtime.js';
import { validateGraph } from '../src/flows/graph.js';
import { greetingVar } from '../src/flows/greetings.js';
import { render } from '../src/flows/vars.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const stamp = Date.now();
let pool, flows;
const A = {};
const sent = [], reactions = [], calls = [];
const whatsapp = {
  freeTextAllowed: async () => true,
  sendTextTo: async (orgId, a) => { sent.push(a); return { ok: true, id: `out-${sent.length}`, to: a.to }; },
  sendMediaTo: async (orgId, a) => { sent.push(a); return { ok: true, id: `out-${sent.length}`, to: a.to }; },
  reactTo: async (orgId, a) => { reactions.push(a); return { ok: true }; },
};
const fetchImpl = async (url, opt) => {
  calls.push({ url, ...opt });
  return { status: 200, text: async () => JSON.stringify({ status: 'ok', pedido: 42, lista: [1] }) };
};

const graph = (trigger, nodes) => ({ version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: trigger, next: { default: nodes[0].ref } }, ...nodes] });
async function flow(nome, g) {
  const camp = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,$2,'Ativa') returning id`, [A.org, nome])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [camp, A.org])).rows[0].id;
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`, [A.org, f, JSON.stringify(g)]);
  return camp;
}
const inbound = (id, from, body, extra = {}) => flows.onInbound({ orgId: A.org, accountId: null, instanceId: A.inst, message: { id, from, type: 'text', text: { body }, ...extra }, contacts: [{ profile: { name: 'Bia Gómez' }, wa_id: from }] });
const execs = async (camp) => (await pool.query(`select lead_id, status from public.flow_executions where campaign_id = $1 order by created_at`, [camp])).rows;

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  flows = createFlowRuntime({ pool, whatsapp, autoKick: false, fetchImpl });
  A.org = (await pool.query(`insert into public.organizations (nome) values ('Mente Viva') returning id`)).rows[0].id;
  A.inst = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,'Vendas',$2,'x','connected') returning id`, [A.org, `mv-${stamp}`])).rows[0].id;
});
after(async () => { if (!skip) await pool.end(); });

test('palavras-chave: contém, igual e começa com, sem acento e sem maiúsculas', () => {
  const kw = { mode: 'keywords', keywords: ['saber más', 'mente vívida'], match: 'contains' };
  assert.equal(keywordHit(kw, 'Hola, quiero SABER MAS'), true);
  assert.equal(keywordHit(kw, 'oi'), false);
  assert.equal(keywordHit({ ...kw, match: 'equals' }, 'Mente Vivida'), true);
  assert.equal(keywordHit({ ...kw, match: 'equals' }, 'mente vivida já'), false);
  assert.equal(keywordHit({ ...kw, match: 'starts' }, 'saber mas por favor'), true);
  assert.equal(keywordHit({ mode: 'any' }, '   '), false);
  assert.equal(keywordHit({ mode: 'any' }, 'oi'), true);
});

test('saudação por país e webhook sem rede interna; validação dos blocos novos', () => {
  const d = new Date('2026-10-30T12:00:00Z');
  assert.equal(greetingVar('saudacao_personalizada', { agora: d, lead: { telefone: '5511999990000' } }), 'Bom dia');
  assert.equal(greetingVar('saudacao_personalizada_es_mx', { agora: d }), 'Buenos días');
  assert.equal(greetingVar('saudacao_personalizada_en_au', { agora: d }), 'Good evening');
  assert.equal(render('{{saudacao_personalizada_es}}, {{primeiro_nome}}!', { agora: d, lead: { nome: 'Bia', telefone: '5215512345678' } }), 'Buenos días, Bia!');
  assert.equal(render('{{saudacao_inexistente}}', { agora: d }), '');
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', 'api.internal']) assert.equal(blockedHost(h), true, h);
  assert.equal(blockedHost('hooks.zapier.com'), false);
  const ok = validateGraph(graph({ source: 'message', mode: 'keywords', keywords: ['oi'], match: 'contains' }, [
    { ref: 'w', type: 'webhook', data: { url: 'https://hooks.zapier.com/x', method: 'POST' }, next: { success: 'g' } },
    { ref: 'g', type: 'goto_flow', data: { campaign_id: '11111111-1111-1111-1111-111111111111' }, next: {} },
  ]));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const bad = validateGraph(graph({ source: 'message', mode: 'keywords', keywords: [] }, [
    { ref: 't', type: 'send_text', data: { text: 'x', react_last: true }, next: { sent: 'g' } }, { ref: 'g', type: 'goto_flow', data: {}, next: {} }]));
  assert.ok(bad.errors.some((e) => /palavra-chave/.test(e)));
  assert.ok(bad.errors.some((e) => /emoji/.test(e)));
  assert.ok(bad.errors.some((e) => /fluxo para onde/.test(e)));
});

test('mensagem com palavra-chave cria o lead, guarda o anúncio e inicia o fluxo; responde e reage à mensagem', { skip }, async () => {
  A.camp = await flow('Mente Viva ES', graph({ source: 'message', mode: 'keywords', keywords: ['saber más', 'quiero saber mas'], match: 'contains' }, [
    { ref: 't1', type: 'send_text', data: { text: '{{saudacao_personalizada_es}} {{primeiro_nome}}! Anuncio: {{ad_title}}', reply_last: true, react_last: true, react_emoji: '❤️' }, next: { sent: 'm1' } },
    { ref: 'm1', type: 'send_media', data: { kind: 'image', url: 'https://cdn.kobly.test/a.jpg', view_once: true }, next: {} },
  ]));
  const from = `52155${String(stamp).slice(-8)}`;
  await inbound(`wamid.${stamp}.1`, from, 'Hola, quiero SABER MÁS', { referral: { source_id: '120200', headline: 'Curso Mente Viva', body: 'Aprende ya', ctwa_clid: 'clid-1', source_url: 'https://fb.me/ad' } });
  const lead = (await pool.query(`select id, nome, ad_origin from public.leads where organization_id = $1 and telefone = $2`, [A.org, from])).rows[0];
  assert.ok(lead, 'lead criado pela mensagem'); assert.equal(lead.nome, 'Bia Gómez');
  assert.equal(lead.ad_origin.headline, 'Curso Mente Viva'); assert.equal(lead.ad_origin.ctwa_clid, 'clid-1');
  assert.equal((await execs(A.camp)).length, 1);
  await flows.tick();
  const t = sent.find((x) => /Anuncio/.test(x.text || ''));
  assert.match(t.text, /^(Buenos días|Buenas tardes|Buenas noches) Bia! Anuncio: Curso Mente Viva$/);
  assert.equal(t.replyTo, `wamid.${stamp}.1`);
  assert.deepEqual(reactions.map((r) => [r.messageId, r.emoji]), [[`wamid.${stamp}.1`, '❤️']]);
  const m = sent.find((x) => x.kind === 'image');
  assert.equal(m.viewOnce, true); assert.equal(m.replyTo, null);
  // mensagem sem a palavra: nada novo; com a palavra de novo (fluxo já terminou): começa de novo
  await inbound(`wamid.${stamp}.2`, from, 'gracias');
  assert.equal((await execs(A.camp)).length, 1);
  await inbound(`wamid.${stamp}.3`, from, 'saber más otra vez');
  assert.equal((await execs(A.camp)).length, 2);
  // número sem fluxo por mensagem de outra empresa não vira lead
  const outra = (await pool.query(`insert into public.organizations (nome) values ('Sem fluxo') returning id`)).rows[0].id;
  const inst2 = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,'X',$2,'x','connected') returning id`, [outra, `sf-${stamp}`])).rows[0].id;
  await flows.onInbound({ orgId: outra, accountId: null, instanceId: inst2, message: { id: `wamid.${stamp}.x`, from: '5511900001111', type: 'text', text: { body: 'saber más' } }, contacts: [] });
  assert.equal((await pool.query(`select count(*)::int as n from public.leads where organization_id = $1`, [outra])).rows[0].n, 0);
});

test('"qualquer texto" só inicia na primeira conversa; quem está esperando resposta não recomeça', { skip }, async () => {
  const camp = await flow('Boas-vindas', graph({ source: 'message', mode: 'any' }, [
    { ref: 'w', type: 'wait_reply', data: { save_as: 'resposta1', timeout_minutes: 60 }, next: {} },
  ]));
  const from = `55119${String(stamp).slice(-8)}`;
  await inbound(`wamid.${stamp}.a1`, from, 'oi');
  await flows.tick();
  assert.equal((await execs(camp)).length, 1);
  await inbound(`wamid.${stamp}.a2`, from, 'quero saber'); // responde o "Aguardar resposta"
  await flows.tick();
  const e = (await pool.query(`select status, variables from public.flow_executions where campaign_id = $1`, [camp])).rows;
  assert.equal(e.length, 1); assert.equal(e[0].status, 'completed'); assert.equal(e[0].variables.resposta1, 'quero saber');
  await inbound(`wamid.${stamp}.a3`, from, 'oi de novo');
  assert.equal((await execs(camp)).length, 1, 'não recomeça');
});

test('Conectar fluxo leva o lead para o outro fluxo; Webhook manda os dados e guarda a resposta', { skip }, async () => {
  const destino = await flow('Destino', graph({ events: ['Pix Gerado'] }, [{ ref: 'x', type: 'send_text', data: { text: 'Cheguei no destino' }, next: {} }]));
  const lead = (await pool.query(`insert into public.leads (organization_id, nome, telefone, email) values ($1,'Caio','5511955554444','caio@x.test') returning *`, [A.org])).rows[0];
  const ex = { id: null, organization_id: A.org, lead_id: lead.id, campaign_id: A.camp };
  const ctx = { lead, vars: { plano: 'pro', _wait_var: 'x' }, agora: new Date(), evento: {} };
  const g = await flows.runNode(ex, { ref: 'g', type: 'goto_flow', data: { campaign_id: destino } }, ctx);
  assert.equal(g.stop, 'completed'); assert.match(g.detail, /Destino/);
  assert.equal((await execs(destino)).length, 1);
  const self = await flows.runNode(ex, { ref: 'g', type: 'goto_flow', data: { campaign_id: A.camp } }, ctx);
  assert.equal(self.stop, 'failed');

  const w = await flows.runNode(ex, { ref: 'w', type: 'webhook', data: { url: 'https://hooks.example.com/kobly?l={{primeiro_nome}}', method: 'POST', headers: [{ key: 'X-Token', value: 'abc' }], save_as: 'crm' } }, ctx);
  assert.equal(w.exit, 'success');
  const c = calls.pop();
  assert.equal(c.url, 'https://hooks.example.com/kobly?l=Caio'); assert.equal(c.headers['X-Token'], 'abc');
  const sentBody = JSON.parse(c.body);
  assert.equal(sentBody.lead.telefone, '5511955554444'); assert.equal(sentBody.variaveis.plano, 'pro'); assert.equal(sentBody.variaveis._wait_var, undefined);
  assert.equal(ctx.vars.crm_status, '200'); assert.equal(ctx.vars.crm_pedido, '42'); assert.equal(ctx.vars.crm_lista, undefined);
  const blocked = await flows.runNode(ex, { ref: 'w', type: 'webhook', data: { url: 'http://169.254.169.254/latest' } }, ctx);
  assert.equal(blocked.exit, 'error'); assert.equal(calls.length, 0);
});
