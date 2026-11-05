// Agentes de voz: criar na ElevenLabs, configurar o número de ligação, bloco Ligação (só tocar e agente), resultado da
// ligação retomando o fluxo pela saída certa, e a OpenAI atendendo quem liga (webhook assinado).
// KOBLY_TEST_DATABASE_URL=postgres://... node --test test/voice_agents.integration.test.js   (sem a variável, só os testes puros)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import pg from 'pg';
import { createVoiceAgents, cleanOutcomes, readConversation, verifyStandardWebhook, elevenAgentBody } from '../src/voice/agents.js';
import { createFlowRuntime } from '../src/flows/runtime.js';
import { validateGraph } from '../src/flows/graph.js';
import { encrypt } from '../src/whatsapp/crypto.js';

const URL_ = process.env.KOBLY_TEST_DATABASE_URL;
const skip = !URL_;
const KEY = randomBytes(32);
const stamp = Date.now();

test('saídas: chaves limpas, únicas, até 8; corpo do agente leva a saída na coleta de dados', () => {
  const o = cleanOutcomes([{ label: 'Quer comprar' }, { label: 'Quer comprar' }, { label: 'Não tem interesse', description: 'disse não' }, { label: '' }]);
  assert.deepEqual(o.map((x) => x.key), ['quer_comprar', 'saida_2', 'nao_tem_interesse']);
  const b = elevenAgentBody({ name: 'Vendedor', language: 'pt', instructions: 'Você vende cursos.', first_message: 'Oi!', outcomes: o, max_duration_s: 300, silence_timeout_s: 20, voice_id: 'v1' });
  assert.equal(b.conversation_config.agent.first_message, 'Oi!');
  assert.equal(b.conversation_config.tts.voice_id, 'v1');
  assert.match(b.platform_settings.data_collection.saida.description, /quer_comprar/);
  assert.match(b.conversation_config.agent.prompt.prompt, /português do Brasil/);
});

test('resultado da conversa: atendeu com saída, recusou, não atendeu', () => {
  const outs = [{ key: 'quer_comprar' }];
  const ok = readConversation({ status: 'done', metadata: { call_duration_secs: 64, whatsapp: { call_result: 'answered' } },
    analysis: { transcript_summary: 'Lead quer o curso.', data_collection_results: { saida: { value: 'quer_comprar' } } },
    transcript: [{ role: 'agent', message: 'Oi!' }, { role: 'user', message: 'Quero sim' }] }, outs);
  assert.deepEqual([ok.done, ok.result, ok.outcome, ok.duration], [true, 'answered', 'quer_comprar', 64]);
  assert.equal(ok.transcript, 'Agente: Oi!\nLead: Quero sim');
  assert.equal(readConversation({ status: 'done', metadata: { whatsapp: { call_permission_request: { state: 'declined' } } } }).result, 'rejected');
  assert.equal(readConversation({ status: 'failed', metadata: { whatsapp: { call_result: 'no_answer' } } }).result, 'no_answer');
  assert.equal(readConversation({ status: 'in-progress', metadata: {} }).done, false);
  // saída que não existe no agente não vale
  assert.equal(readConversation({ status: 'done', metadata: { whatsapp: { call_result: 'answered' } }, analysis: { data_collection_results: { saida: { value: 'inventada' } } } }, outs).outcome, null);
});

test('assinatura do webhook da OpenAI (Standard Webhooks)', () => {
  const secret = `whsec_${randomBytes(24).toString('base64')}`;
  const raw = '{"type":"realtime.call.incoming"}';
  const ts = '1700000000';
  const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`msg_1.${ts}.${raw}`).digest('base64');
  const h = { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
  assert.equal(verifyStandardWebhook(secret, h, raw, 1700000010), true);
  assert.equal(verifyStandardWebhook(secret, h, raw + ' ', 1700000010), false);
  assert.equal(verifyStandardWebhook(secret, h, raw, 1700009999), false, 'velho demais');
});

test('bloco Ligação: validação', () => {
  const g = (data, next = {}) => ({ version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'c' } }, { ref: 'c', type: 'call', data, next }] });
  assert.equal(validateGraph(g({ mode: 'ring', ring_seconds: 20 })).ok, true);
  assert.ok(validateGraph(g({ mode: 'agent' })).errors.some((e) => /agente de voz/.test(e)));
  assert.ok(validateGraph(g({ mode: 'ring', ring_seconds: 99 })).errors.some((e) => /3 e 60/.test(e)));
  assert.equal(validateGraph(g({ mode: 'agent', voice_agent_id: '11111111-1111-1111-1111-111111111111', outcomes: [{ key: 'quer_comprar', label: 'Quer comprar' }] })).ok, true);
});

// ---- com banco ----
let pool, va, flows;
const A = {};
const el = []; // chamadas para a ElevenLabs / OpenAI
let conv = { status: 'in-progress', metadata: {} };
async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  el.push({ host: u.host, path: u.pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.pathname === '/v1/convai/agents/create') return ok({ agent_id: 'el_agent_1' });
  if (u.pathname.startsWith('/v1/convai/agents/')) return ok({});
  if (u.pathname === '/v1/convai/whatsapp-accounts') return ok({ items: [{ phone_number_id: '1098765', phone_number: '+55 11 4000-1000', phone_number_name: 'Ligações', business_account_id: 'b', business_account_name: 'Loja' }] });
  if (u.pathname === '/v1/convai/whatsapp/outbound-call') return ok({ success: true, message: 'ok', conversation_id: `conv_${el.length}` });
  if (u.pathname.startsWith('/v1/convai/conversations/')) return ok(conv);
  if (u.pathname.startsWith('/v1/realtime/calls/')) return ok({});
  throw new Error('rede não esperada: ' + url);
}
const rings = [];
const whatsapp = { ringCall: async (orgId, phone, secs) => { rings.push([phone, secs]); return { ok: true }; } };

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: URL_, max: 4 });
  va = createVoiceAgents({ pool, secretKey: KEY, fetchImpl: fakeFetch, publicBaseUrl: 'https://api.kobly.test' });
  flows = createFlowRuntime({ pool, whatsapp, autoKick: false, voice: va });
  va.setCallDoneHandler((c) => flows.onCallDone(c));
  A.org = (await pool.query(`insert into public.organizations (nome) values ('Loja Voz ${stamp}') returning id`)).rows[0].id;
  A.outra = (await pool.query(`insert into public.organizations (nome) values ('Outra Voz ${stamp}') returning id`)).rows[0].id;
  await pool.query(`insert into public.voice_credentials (organization_id, key_enc, key_hint) values ($1,$2,'…abcd')`, [A.org, encrypt('sk_eleven_teste_0000000000', KEY)]);
  await pool.query(`insert into public.ai_credentials (organization_id, provider, key_enc, key_hint, model, is_active) values ($1,'openai',$2,'…x','gpt-4o-mini',true)`, [A.org, encrypt('sk-openai-teste', KEY)]);
  A.lead = (await pool.query(`insert into public.leads (organization_id, nome, telefone) values ($1,'Bia','5511988887777') returning id`, [A.org])).rows[0].id;
});
after(async () => { if (!skip) await pool.end(); });
const ctx = (orgId = A.org, role = 'Cliente') => ({ orgId, role });

test('criar agente sincroniza na ElevenLabs; configurar número e permissão', { skip }, async () => {
  el.length = 0;
  const r = await va.handle(ctx(), {}, { action: 'save', name: 'Vendedor', provider: 'elevenlabs', language: 'pt', voice_id: 'voz1', instructions: 'Você liga para quem gerou Pix e ajuda a pagar.',
    first_message: 'Oi {{nome}}, tudo bem?', outcomes: [{ label: 'Vai pagar' }, { label: 'Sem interesse' }] });
  assert.equal(r.sync_error, null); A.agent = r.id;
  assert.deepEqual(r.outcomes.map((o) => o.key), ['vai_pagar', 'sem_interesse']);
  assert.equal(el[0].path, '/v1/convai/agents/create'); assert.equal(el[0].headers['xi-api-key'], 'sk_eleven_teste_0000000000');
  const acc = await va.handle(ctx(), {}, { action: 'el_accounts' });
  assert.equal(acc.accounts[0].phone_number_id, '1098765');
  // sem número configurado, ligar falha com mensagem clara
  await assert.rejects(va.handle(ctx(), {}, { action: 'test_call', id: A.agent, phone: '5511988887777' }), /número de ligação/);
  await assert.rejects(va.handle(ctx(), {}, { action: 'save_settings', permission_template: 'Pedido Ligação' }), /minúsculas/);
  const s = await va.handle(ctx(), {}, { action: 'save_settings', el_phone_number_id: '1098765', el_phone_label: 'Ligações', permission_template: 'pedido_ligacao', permission_language: 'pt_BR' });
  assert.equal(s.settings.el_phone_number_id, '1098765');
  // outra empresa não vê nem usa
  await assert.rejects(va.handle(ctx(A.outra), {}, { action: 'test_call', id: A.agent, phone: '5511988887777' }), /não encontrado/);
  await assert.rejects(va.handle(ctx(A.org, 'Suporte'), {}, { action: 'save', name: 'x', instructions: 'xxxxxxxxxxxx' }), /não pode/);
});

const graph = (callData, next) => ({ version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'c' } }, { ref: 'c', type: 'call', data: callData, next }, { ref: 'pagar', type: 'end', data: {}, next: {} }, { ref: 'nao', type: 'end', data: {}, next: {} }] });
async function startFlow(g) {
  const camp = (await pool.query(`insert into public.campaigns (organization_id, nome, status_campanha) values ($1,$2,'Ativa') returning id`, [A.org, `Voz ${Math.random()}`])).rows[0].id;
  const f = (await pool.query(`insert into public.campaign_flows (campaign_id, organization_id) values ($1,$2) returning id`, [camp, A.org])).rows[0].id;
  await pool.query(`insert into public.flow_graph_versions (organization_id, flow_id, version, graph, is_active) values ($1,$2,1,$3::jsonb,true)`, [A.org, f, JSON.stringify(g)]);
  await pool.query(`update public.flow_executions set status = 'cancelled' where lead_id = $1 and status in ('running','waiting')`, [A.lead]);
  await flows.startForLead({ orgId: A.org, campaignId: camp, leadId: A.lead });
  return camp;
}
const ex = async (camp) => (await pool.query(`select * from public.flow_executions where campaign_id = $1`, [camp])).rows[0];

test('bloco Ligação "só tocar": toca pelo QR Code e segue por Atendeu', { skip }, async () => {
  rings.length = 0;
  const camp = await startFlow(graph({ mode: 'ring', ring_seconds: 15 }, { answered: 'pagar', no_answer: 'nao' }));
  await flows.tick();
  assert.deepEqual(rings, [['5511988887777', 15]]);
  const e = await ex(camp);
  assert.equal(e.status, 'completed'); assert.equal(e.current_ref, 'pagar'); assert.equal(e.variables.ligacao_status, 'tocou');
});

test('bloco Ligação com agente: liga, espera e retoma pela saída escolhida', { skip }, async () => {
  el.length = 0;
  conv = { status: 'in-progress', metadata: {} };
  const camp = await startFlow(graph({ mode: 'agent', voice_agent_id: A.agent, outcomes: [{ key: 'vai_pagar', label: 'Vai pagar' }] }, { out_vai_pagar: 'pagar', no_answer: 'nao', answered: 'nao' }));
  await flows.tick();
  const call = el.find((c) => c.path === '/v1/convai/whatsapp/outbound-call');
  assert.equal(call.body.whatsapp_user_id, '5511988887777');
  assert.equal(call.body.whatsapp_call_permission_request_template_name, 'pedido_ligacao');
  assert.equal(call.body.agent_id, 'el_agent_1');
  assert.equal(call.body.conversation_initiation_client_data.dynamic_variables.nome, 'Bia');
  let e = await ex(camp);
  assert.equal(e.status, 'waiting'); assert.equal(e.variables.ligacao_status, 'chamando');
  // ainda em andamento: nada muda
  await pool.query(`update public.voice_calls set check_after = now() - interval '1 second' where execution_id = $1`, [e.id]);
  assert.equal((await va.poll()).done, 0);
  // terminou: atendeu e escolheu "vai_pagar"
  conv = { status: 'done', metadata: { call_duration_secs: 42, whatsapp: { call_result: 'answered' } }, analysis: { transcript_summary: 'Vai pagar hoje.', data_collection_results: { saida: { value: 'vai_pagar' } } }, transcript: [{ role: 'user', message: 'Pago hoje' }] };
  await pool.query(`update public.voice_calls set check_after = now() - interval '1 second' where execution_id = $1`, [e.id]);
  assert.equal((await va.poll()).done, 1);
  await flows.tick();
  e = await ex(camp);
  assert.equal(e.status, 'completed'); assert.equal(e.current_ref, 'pagar');
  assert.equal(e.variables.ligacao_status, 'atendida'); assert.equal(e.variables.ligacao_saida, 'vai_pagar'); assert.equal(e.variables.ligacao_duracao, 42);
  const list = await va.handle(ctx(), {}, { action: 'calls' });
  assert.equal(list.calls[0].result, 'answered'); assert.equal(list.calls[0].summary, 'Vai pagar hoje.');
});

test('lead recusou: segue por Recusou (ou Não atendeu sem essa ligação)', { skip }, async () => {
  conv = { status: 'done', metadata: { whatsapp: { call_permission_request: { state: 'declined' } } } };
  const camp = await startFlow(graph({ mode: 'agent', voice_agent_id: A.agent }, { rejected: 'nao', answered: 'pagar' }));
  await flows.tick();
  const e0 = await ex(camp);
  await pool.query(`update public.voice_calls set check_after = now() - interval '1 second' where execution_id = $1`, [e0.id]);
  await va.poll(); await flows.tick();
  const e = await ex(camp);
  assert.equal(e.current_ref, 'nao'); assert.equal(e.variables.ligacao_status, 'recusada');
});

test('OpenAI atende quem liga: webhook assinado aceita com as instruções do agente', { skip }, async () => {
  const oa = await va.handle(ctx(), {}, { action: 'save', name: 'Recepção', provider: 'openai', voice_id: 'marin', instructions: 'Você atende quem liga para a loja.', first_message: 'Loja X, bom dia!' });
  const secret = `whsec_${randomBytes(24).toString('base64')}`;
  const s = await va.handle(ctx(), {}, { action: 'save_settings', openai_project_id: 'proj_abc12345XYZ', openai_webhook_secret: secret, openai_agent_id: oa.id });
  assert.match(s.settings.openai_webhook_url, /^https:\/\/api\.kobly\.test\/webhooks\/openai-calls\/[0-9a-f-]{36}$/);
  assert.equal(s.settings.openai_sip_uri, 'sip:proj_abc12345XYZ@sip.api.openai.com;transport=tls');
  assert.equal(s.settings.openai_secret_set, true); assert.equal(JSON.stringify(s).includes(secret), false);
  const hookId = s.settings.openai_webhook_url.split('/').pop();
  const raw = JSON.stringify({ type: 'realtime.call.incoming', data: { call_id: 'rtc_123', sip_headers: [{ name: 'From', value: '<sip:+5511988887777@wa.meta.vc>' }] } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`m1.${ts}.${raw}`).digest('base64');
  assert.equal((await va.receiveOpenAiWebhook(hookId, { 'webhook-id': 'm1', 'webhook-timestamp': ts, 'webhook-signature': 'v1,errada' }, raw)).status, 401);
  el.length = 0;
  assert.equal((await va.receiveOpenAiWebhook(hookId, { 'webhook-id': 'm1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, raw)).status, 200);
  const acc = el.find((c) => c.path === '/v1/realtime/calls/rtc_123/accept');
  assert.equal(acc.headers.Authorization, 'Bearer sk-openai-teste');
  assert.equal(acc.body.audio.output.voice, 'marin'); assert.match(acc.body.instructions, /Loja X, bom dia!/);
  const row = (await pool.query(`select lead_id, direction, result from public.voice_calls where external_id = 'rtc_123'`)).rows[0];
  assert.deepEqual(row, { lead_id: A.lead, direction: 'inbound', result: 'answered' });
});
