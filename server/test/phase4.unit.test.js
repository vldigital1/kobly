import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { validateGraph } from '../src/flows/graph.js';
import { createFlowRuntime, pickVariant } from '../src/flows/runtime.js';
import { createNotifier } from '../src/notify/telegram.js';
import { encrypt } from '../src/whatsapp/crypto.js';

const g = (nodes) => ({ version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: nodes[0].ref } }, ...nodes, { ref: 'fim', type: 'end', data: {}, next: {} }] });

// banco em memória com o mínimo que o motor usa
function fakeDb({ graph, lead, clock }) {
  const db = { exec: null, events: [], clock };
  const pool = {
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ');
      const r = (rows, rowCount = rows.length) => ({ rows, rowCount });
      if (/stop_on_purchase returning id/.test(s)) return r([]);
      if (/join public.flow_graph_versions v on v.flow_id = f.id and v.is_active/.test(s)) return r([{ campaign_id: 'c1', flow_id: 'f1', version_id: 'v1', graph }]);
      if (/insert into public.flow_executions/.test(s)) { db.exec = { id: 'e1', organization_id: p[0], campaign_id: p[1], flow_id: p[2], graph_version_id: p[3], lead_id: p[4], current_ref: p[6], variables: JSON.parse(p[8]), status: 'running', attempts: 0, steps_count: 0, started_at: new Date(0).toISOString(), run_at: new Date(0).toISOString() }; return r([{ id: 'e1' }]); }
      if (/with due as/.test(s)) { const ok = db.exec && ['running', 'waiting'].includes(db.exec.status) && new Date(db.exec.run_at) <= db.clock() && !db.exec.lease_until; if (!ok) return r([]); db.exec.lease_until = 'x'; return r([{ ...db.exec, variables: { ...db.exec.variables } }]); }
      if (/select id, variables from public.flow_executions where lead_id/.test(s)) return r(db.exec && db.exec.status === 'waiting' && db.exec.wait_kind === 'reply' && !db.exec.resume_exit ? [{ id: 'e1', variables: { ...db.exec.variables } }] : []);
      if (/set variables = \$2::jsonb, resume_exit = \$3/.test(s)) { db.exec.variables = JSON.parse(p[1]); db.exec.resume_exit = p[2]; db.exec.run_at = db.clock().toISOString(); return r([{ id: 'e1' }]); }
      if (/^update public.flow_executions set /.test(s)) {
        const m = /set (.+), lease_until = /.exec(s);
        for (const part of m[1].split(', ')) { const [col, ph] = part.split(' = '); let v = p[Number(ph.slice(1)) - 1]; if (col === 'variables') v = JSON.parse(v); db.exec[col] = v; }
        db.exec.lease_until = /lease_until = null/.test(s) ? null : 'x'; return r([], 1);
      }
      if (/from public.flow_graph_versions where id/.test(s)) return r([{ graph }]);
      if (/insert into public.flow_execution_events/.test(s)) { db.events.push(`${p[3]}:${p[5]}`); return r([]); }
      if (/from public.leads where id = \$1/.test(s)) return r([lead]);
      if (/select timezone/.test(s)) return r([{ timezone: 'America/Sao_Paulo' }]);
      if (/left join public.brands b/.test(s)) return r([{}]);
      if (/bulk_reserve_usage/.test(s)) return r([{ ok: true }]);
      if (/insert into public.email_events|update public.(lead_metrics|campaign_stats)/.test(s)) return r([], 1);
      if (/insert into public.whatsapp_inbound_messages/.test(s)) return r([{ id: 'in' + Math.random() }]);
      if (/from public.leads where organization_id = \$1 and right/.test(s)) return r([{ id: lead.id }]);
      if (/update public.whatsapp_inbound_messages|whatsapp_last_inbound_at = now/.test(s)) { if (/whatsapp_last_inbound_at/.test(s)) lead.whatsapp_last_inbound_at = db.clock().toISOString(); return r([], 1); }
      throw new Error('SQL não esperado: ' + s.slice(0, 120));
    },
  };
  return { db, pool };
}

test('validação fase 4: agente, A/B, contador, horário comercial e alerta', () => {
  const ok = validateGraph(g([
    { ref: 'ab', type: 'split', data: { variants: [{ id: 'a', weight: 50 }, { id: 'b', weight: 50 }] }, next: { var_a: 'cnt', var_b: 'hc' } },
    { ref: 'cnt', type: 'checkpoint', data: { name: 'viu oferta A' }, next: { default: 'ag' } },
    { ref: 'hc', type: 'wait_until', data: { mode: 'business_hours', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }, next: { default: 'ag' } },
    { ref: 'ag', type: 'ai_agent', data: { objective: 'Tirar dúvidas e levar ao pagamento', max_turns: 8 }, next: { done: 'al', handoff: 'al', expiration: 'fim' } },
    { ref: 'al', type: 'notify', data: { channel_id: 'ch1', text: 'Lead {{nome}} precisa de atenção' }, next: { default: 'fim' } },
  ]));
  assert.equal(ok.ok, true, ok.errors.join('; '));
  const e = (n) => validateGraph(g([{ next: {}, ...n, ref: 'x' }])).errors.join();
  assert.match(e({ type: 'ai_agent', data: {} }), /objetivo do agente/);
  assert.match(e({ type: 'split', data: { variants: [{ id: 'a', weight: 50 }, { id: 'b', weight: 50 }] }, next: { var_a: 'fim' } }), /ligue o caminho "b"/);
  assert.match(e({ type: 'split', data: { variants: [{ id: 'a', weight: 0 }, { id: 'b', weight: 50 }] }, next: { var_a: 'fim', var_b: 'fim' } }), /peso do caminho "a"/);
  assert.match(e({ type: 'wait_until', data: { mode: 'business_hours', days: [1], from: '18:00', to: '09:00' }, next: { default: 'fim' } }), /início antes do fim/);
  assert.match(e({ type: 'notify', data: { text: 'x' }, next: { default: 'fim' } }), /canal de alerta/);
});

test('A/B: sorteio respeita os pesos', () => {
  const vs = [{ id: 'a', weight: 70 }, { id: 'b', weight: 30 }];
  assert.equal(pickVariant(vs, 0), 'a'); assert.equal(pickVariant(vs, 0.69), 'a'); assert.equal(pickVariant(vs, 0.71), 'b'); assert.equal(pickVariant(vs, 0.9999), 'b');
  let a = 0; for (let i = 0; i < 1000; i++) if (pickVariant(vs, i / 1000) === 'a') a++;
  assert.equal(a, 700);
});

test('agente de IA: responde a última mensagem, conversa em turnos e sai por "concluído"; histórico vai para a IA', async () => {
  let now = new Date('2026-10-20T15:00:00Z');
  const graph = g([
    { ref: 'ag', type: 'ai_agent', data: { objective: 'Vender o guia de receitas por $45', knowledge: 'Entrega por PDF na hora.', max_turns: 5, timeout_minutes: 30 }, next: { done: 'fim', handoff: 'fim', expiration: 'fim' } },
  ]);
  assert.equal(validateGraph(graph).ok, true);
  const lead = { id: 'l1', nome: 'Rosa Diaz', telefone: '5215512345678', email: 'r@x.test', whatsapp_opt_out: false, whatsapp_last_inbound_at: new Date(now - 60e3).toISOString() };
  const { db, pool } = fakeDb({ graph, lead, clock: () => now });
  const sent = [], vistos = [];
  const respostas = [{ resposta: 'Hola Rosa! Es un PDF con 50 recetas.', acao: 'continuar' }, { resposta: '¡Perfecto! Te envío el pago.', acao: 'concluido' }];
  const llm = { agentReply: async (a) => { vistos.push(a.history.map((m) => `${m.r}:${m.t}`)); return respostas.shift(); } };
  const rt = createFlowRuntime({ pool, whatsapp: { sendTextTo: async (o, a) => { sent.push(a.text); return { id: 'w' }; } }, llm, now: () => now, autoKick: false });
  await rt.startForEvent({ orgId: 'o1', tokenId: 'k', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  db.exec.variables.ultima_mensagem = '¿Cómo llega el producto?';
  await rt.tick();
  assert.deepEqual(sent, ['Hola Rosa! Es un PDF con 50 recetas.']);
  assert.equal(db.exec.status, 'waiting'); assert.equal(db.exec.current_ref, 'ag');
  now = new Date(now.getTime() + 60e3);
  await rt.onInbound({ orgId: 'o1', accountId: 'a', message: { id: 'm2', from: lead.telefone, type: 'text', text: { body: 'Ok, lo quiero' } } });
  await rt.tick();
  assert.deepEqual(sent, ['Hola Rosa! Es un PDF con 50 recetas.', '¡Perfecto! Te envío el pago.']);
  assert.equal(db.exec.status, 'completed');
  assert.deepEqual(vistos[1], ['lead:¿Cómo llega el producto?', 'agent:Hola Rosa! Es un PDF con 50 recetas.', 'lead:Ok, lo quiero'], 'a IA recebe a conversa inteira');
  assert.deepEqual(db.events.slice(-3), ['ag:reply', 'ag:done', 'fim:completed']);
});

test('agente de IA: sem resposta no prazo sai por "expiration"', async () => {
  let now = new Date('2026-10-20T15:00:00Z');
  const graph = g([{ ref: 'ag', type: 'ai_agent', data: { objective: 'x', reply_on_entry: false, timeout_minutes: 30 }, next: { expiration: 'fim', done: 'fim' } }]);
  const lead = { id: 'l1', telefone: '5511900000000', whatsapp_opt_out: false, whatsapp_last_inbound_at: new Date(now - 60e3).toISOString() };
  const { db, pool } = fakeDb({ graph, lead, clock: () => now });
  const rt = createFlowRuntime({ pool, whatsapp: {}, llm: { agentReply: async () => assert.fail('não deveria chamar a IA') }, now: () => now, autoKick: false });
  await rt.startForEvent({ orgId: 'o1', tokenId: 'k', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  await rt.tick();
  now = new Date(now.getTime() + 31 * 60e3);
  await rt.tick();
  assert.equal(db.exec.status, 'completed'); assert.ok(db.events.includes('ag:expiration'));
});

test('horário comercial: sexta à noite espera até segunda 09:00 (fuso da empresa) e segue', async () => {
  let now = new Date('2026-10-23T23:30:00Z'); // sexta 20:30 em São Paulo
  const graph = g([{ ref: 'hc', type: 'wait_until', data: { mode: 'business_hours', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }, next: { default: 'fim' } }]);
  const lead = { id: 'l1', telefone: '5511900000000', whatsapp_opt_out: false };
  const { db, pool } = fakeDb({ graph, lead, clock: () => now });
  const rt = createFlowRuntime({ pool, whatsapp: {}, now: () => now, autoKick: false });
  await rt.startForEvent({ orgId: 'o1', tokenId: 'k', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  await rt.tick();
  assert.equal(db.exec.status, 'waiting');
  assert.equal(new Date(db.exec.run_at).toISOString(), '2026-10-26T12:00:00.000Z');
  now = new Date('2026-10-26T12:00:01Z');
  await rt.tick();
  assert.equal(db.exec.status, 'completed');
});

test('A/B no motor: escolha fica guardada; contador e alerta seguem sempre', async () => {
  const now = new Date('2026-10-20T15:00:00Z');
  const graph = g([
    { ref: 'ab', type: 'split', data: { variants: [{ id: 'a', weight: 1 }, { id: 'b', weight: 99 }] }, next: { var_a: 'fim', var_b: 'cnt' } },
    { ref: 'cnt', type: 'checkpoint', data: { name: 'grupo B' }, next: { default: 'al' } },
    { ref: 'al', type: 'notify', data: { channel_id: 'ch', text: 'Lead {{nome}} no grupo B' }, next: { default: 'fim' } },
  ]);
  const lead = { id: 'l1', nome: 'Ana', telefone: '5511900000000', whatsapp_opt_out: false };
  const { db, pool } = fakeDb({ graph, lead, clock: () => now });
  const alertas = [];
  const rt = createFlowRuntime({ pool, whatsapp: {}, rnd: () => 0.5, notifier: { send: async (a) => { alertas.push(a.text); return { ok: false, detail: 'chat não encontrado' }; } }, now: () => now, autoKick: false });
  await rt.startForEvent({ orgId: 'o1', tokenId: 'k', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  await rt.tick();
  assert.equal(db.exec.variables._split_ab, 'b');
  assert.deepEqual(alertas, ['Lead Ana no grupo B']);
  assert.equal(db.exec.status, 'completed', 'alerta que falha não trava o fluxo');
  assert.deepEqual(db.events, ['ini:default', 'ab:var_b', 'cnt:default', 'al:default', 'fim:completed']);
});

test('Telegram: confere o bot ao salvar, cifra o token e envia para o chat padrão', async () => {
  const key = randomBytes(32);
  const token = '123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK';
  const rows = [];
  const pool = { async query(sql, p) {
    if (/insert into public.notification_channels/.test(sql)) { rows.push({ id: 'ch1', organization_id: p[0], label: p[1], token_enc: p[2], default_chat_id: p[3] }); return { rows: [{ id: 'ch1', label: p[1], default_chat_id: p[3] }] }; }
    if (/select \* from public.notification_channels/.test(sql)) return { rows: rows.filter((r) => r.id === p[0] && r.organization_id === p[1]) };
    return { rows: [] };
  } };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'kobly_alertas_bot' } }) }; };
  const n = createNotifier({ pool, secretKey: key, fetchImpl });
  const saved = await n.handle({ orgId: 'o1', role: 'Cliente' }, { action: 'save', bot_token: token, chat_id: '-1001234567890' });
  assert.equal(saved.channel.label, '@kobly_alertas_bot');
  assert.equal(rows[0].token_enc.includes(token), false, 'token cifrado no banco');
  assert.match(calls[0].url, /\/getMe$/);
  const r = await n.send({ orgId: 'o1', channelId: 'ch1', text: 'Venda aprovada: Ana' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[1].body, { chat_id: '-1001234567890', text: 'Venda aprovada: Ana', disable_web_page_preview: true });
  assert.equal((await n.send({ orgId: 'outra', channelId: 'ch1', text: 'x' })).ok, false, 'canal de outra empresa não serve');
  await assert.rejects(n.handle({ orgId: 'o1', role: 'Cliente' }, { action: 'save', bot_token: 'invalido', chat_id: '123' }), /Token do bot inválido/);
  await assert.rejects(n.handle({ orgId: 'o1', role: 'Suporte' }, { action: 'save', bot_token: token, chat_id: '123' }), /não pode alterar/);
});
