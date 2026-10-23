import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph } from '../src/flows/graph.js';
import { render, evalRule, evalCondition, applySetVar, isWindowOpen, inboundText } from '../src/flows/vars.js';
import { createFlowRuntime, templateValues, buttonSuffix, delayMinutes } from '../src/flows/runtime.js';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // etiqueta
const g = (nodes, start = 'ini') => ({ version: 1, start, nodes });
const trig = (next = 'fim', events = ['Pix Gerado']) => ({ ref: 'ini', type: 'trigger', data: { events }, next: { default: next } });
const fim = { ref: 'fim', type: 'end', data: {}, next: {} };

// ---- validação do grafo -------------------------------------------------------
test('grafo válido: gatilho → texto → aguardar → condição → fim', () => {
  const v = validateGraph(g([
    trig('msg'),
    { ref: 'msg', type: 'send_text', data: { text: 'Oi {{primeiro_nome}}' }, next: { sent: 'esp' } },
    { ref: 'esp', type: 'wait_reply', data: { save_as: 'resposta', timeout_minutes: 60 }, next: { reply: 'cond', timeout: 'fim' } },
    { ref: 'cond', type: 'condition', data: { rules: [{ kind: 'var', name: 'resposta', op: 'contains', value: 'sim' }] }, next: { yes: 'fim', no: 'fim' } },
    fim,
  ]));
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(v.warnings, []);
});
test('grafo inválido: sem gatilho, saída inexistente, alvo inexistente, saída obrigatória solta', () => {
  assert.match(validateGraph(g([fim], 'fim')).errors.join(), /começar por um Gatilho/);
  assert.match(validateGraph(g([trig(), { ...fim, next: { yes: 'ini' } }])).errors.join(), /saída "yes" não existe/);
  assert.match(validateGraph(g([trig('nada')])).errors.join(), /aponta para "nada", que não existe/);
  assert.match(validateGraph(g([trig('m'), { ref: 'm', type: 'send_text', data: { text: 'x' }, next: {} }])).errors.join(), /ligue a saída "sent"/);
  assert.match(validateGraph(g([trig(), fim, { ...fim }])).errors.join(), /repetido/);
  assert.match(validateGraph(g([trig('fim', ['Evento X']), fim])).errors.join(), /evento desconhecido/);
});
test('laço sem espera é erro; laço passando por Esperar é permitido', () => {
  const semEspera = validateGraph(g([trig('a'), { ref: 'a', type: 'set_var', data: { name: 'n', value: '1' }, next: { default: 'b' } }, { ref: 'b', type: 'set_var', data: { name: 'n', value: '2' }, next: { default: 'a' } }]));
  assert.match(semEspera.errors.join(), /Laço sem espera/);
  const comEspera = validateGraph(g([trig('a'), { ref: 'a', type: 'delay', data: { minutes: 5 }, next: { default: 'b' } }, { ref: 'b', type: 'set_var', data: { name: 'n', value: '2' }, next: { default: 'a' } }]));
  assert.equal(comEspera.ok, true, comEspera.errors.join());
});
test('bloco solto vira aviso; regras de condição são conferidas', () => {
  const v = validateGraph(g([trig(), fim, { ref: 'solto', type: 'end', data: {}, next: {} }]));
  assert.equal(v.ok, true); assert.match(v.warnings.join(), /"solto" não é alcançado/);
  const c = (rules) => validateGraph(g([trig('c'), { ref: 'c', type: 'condition', data: { rules }, next: { yes: 'fim' } }, fim])).errors.join();
  assert.match(c([{ kind: 'var', name: 'X!', op: 'eq', value: '1' }]), /nome de variável inválido/);
  assert.match(c([{ kind: 'time_between', from: '9h', to: '18:00' }]), /HH:MM/);
  assert.match(c([{ kind: 'weekday', days: [7] }]), /0 \(domingo\) a 6/);
  assert.match(c([{ kind: 'tag', op: 'talvez', tag_id: T }]), /operador "talvez"/);
  assert.equal(c([{ kind: 'country', ddi: ['52', '57'] }, { kind: 'window_open' }]), '');
});

// ---- variáveis e condições ----------------------------------------------------
const agora = new Date('2026-10-19T17:30:00Z'); // segunda, 14:30 em São Paulo
const ctx = (extra = {}) => ({ lead: { nome: 'Maria Silva', email: 'm@x.test', telefone: '5215512345678', produto: 'Curso', valor_compra: 45 }, evento: { tipo: 'Pix Gerado' }, vars: { resposta: 'Sim, quero!' }, agora, tz: 'America/Sao_Paulo', tags: new Set([T]), ...extra });
test('textos: campos do lead, variáveis e caminho explícito; desconhecido vira vazio', () => {
  assert.equal(render('Oi {{primeiro_nome}}, {{produto}} por {{valor}}. {{var.resposta}} {{nada}}|', ctx()), `Oi Maria, Curso por ${(45).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. Sim, quero! |`);
  assert.equal(render('{{hora_atual}} {{dia_semana}} {{evento.tipo}}', ctx()), '14:30 segunda-feira Pix Gerado');
});
test('condições: variável (sem acento/maiúscula), etiqueta, horário, dia, país, janela, compra', () => {
  assert.equal(evalRule({ kind: 'var', name: 'resposta', op: 'contains', value: 'SIM' }, ctx()), true);
  assert.equal(evalRule({ kind: 'var', name: 'resposta', op: 'eq', value: 'nao' }, ctx({ vars: { resposta: 'Não' } })), true);
  assert.equal(evalRule({ kind: 'var', name: 'total', op: 'gt', value: '10' }, ctx({ vars: { total: '12,5' } })), true);
  assert.equal(evalRule({ kind: 'tag', tag_id: T, op: 'not_has' }, ctx()), false);
  assert.equal(evalRule({ kind: 'time_between', from: '09:00', to: '18:00' }, ctx()), true);
  assert.equal(evalRule({ kind: 'time_between', from: '22:00', to: '06:00' }, ctx()), false);
  assert.equal(evalRule({ kind: 'weekday', days: [1, 2, 3, 4, 5] }, ctx()), true);
  assert.equal(evalRule({ kind: 'country', ddi: ['52'] }, ctx()), true);
  assert.equal(evalCondition({ match: 'any', rules: [{ kind: 'window_open' }, { kind: 'purchased' }] }, ctx({ comprou: true })), true);
  assert.equal(evalCondition({ rules: [{ kind: 'window_open' }, { kind: 'purchased' }] }, ctx({ comprou: true })), false);
});
test('definir variável, janela de 24 h e texto de qualquer tipo de mensagem', () => {
  assert.equal(applySetVar({ name: 'total', op: 'add', value: '2,5' }, ctx({ vars: { total: 10 } })), 12.5);
  assert.equal(applySetVar({ name: 'saudacao', value: 'Olá {{primeiro_nome}}' }, ctx()), 'Olá Maria');
  assert.equal(isWindowOpen(new Date(agora - 23 * 3600e3), agora), true);
  assert.equal(isWindowOpen(new Date(agora - 25 * 3600e3), agora), false);
  assert.equal(isWindowOpen(null, agora), false);
  assert.equal(inboundText({ type: 'interactive', interactive: { button_reply: { title: 'Quero' } } }), 'Quero');
  assert.equal(inboundText({ type: 'image', image: { caption: 'comprovante' } }), 'comprovante');
  assert.equal(inboundText({ type: 'audio', audio: {} }), '[audio]');
});
test('modelo: valores, sufixo do botão e espera aleatória', () => {
  assert.deepEqual(templateValues(['nome', '{{primeiro_nome}}!', 'texto fixo'], ctx()), ['Maria Silva', 'Maria!', 'texto fixo']);
  const comps = [{ type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://loja.test/c/{{1}}' }] }];
  assert.equal(buttonSuffix(comps, 'https://loja.test/c/abc'), 'abc');
  assert.equal(buttonSuffix(comps, 'https://outra.test/x'), '');
  assert.equal(buttonSuffix([], 'https://loja.test'), undefined);
  assert.equal(delayMinutes({ min_minutes: 10, max_minutes: 20 }, () => 0.5), 15);
  assert.equal(delayMinutes({ minutes: 7 }), 7);
});

// ---- motor ponta a ponta (banco em memória) -----------------------------------
function fakeDb({ graph, lead }) {
  const db = { exec: null, events: [], sends: [], tags: new Set(), inbound: new Set(), emailEvents: 0 };
  const applyPatch = (sql, params) => {
    const m = /set (.+), lease_until = /s.exec(sql);
    for (const part of m[1].split(', ')) {
      const [col, ph] = part.split(' = ');
      let v = params[Number(ph.slice(1)) - 1];
      if (col === 'variables') v = JSON.parse(v);
      db.exec[col] = v;
    }
    db.exec.lease_until = /lease_until = null/.test(sql) ? null : 'leased';
  };
  const pool = {
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ');
      const r = (rows, rowCount = rows.length) => ({ rows, rowCount });
      if (/stop_on_purchase returning id/.test(s)) return r([]);
      if (/join public.flow_graph_versions v on v.flow_id = f.id and v.is_active/.test(s)) return r([{ campaign_id: 'c1', flow_id: 'f1', version_id: 'v1', graph }]);
      if (/insert into public.flow_executions/.test(s)) {
        if (db.exec && ['running', 'waiting'].includes(db.exec.status)) return r([]);
        db.exec = { id: 'e1', organization_id: p[0], campaign_id: p[1], flow_id: p[2], graph_version_id: p[3], lead_id: p[4], webhook_event_id: p[5], current_ref: p[6], stop_on_purchase: p[7], variables: JSON.parse(p[8]), status: 'running', attempts: 0, steps_count: 0, started_at: new Date(0).toISOString(), run_at: new Date(0).toISOString() };
        return r([{ id: 'e1' }]);
      }
      if (/with due as/.test(s)) {
        const due = db.exec && ['running', 'waiting'].includes(db.exec.status) && new Date(db.exec.run_at) <= db.clock() && !db.exec.lease_until;
        if (!due) return r([]);
        db.exec.lease_until = 'leased'; return r([{ ...db.exec, variables: { ...db.exec.variables } }]);
      }
      if (/update public.flow_executions set variables = jsonb_set/.test(s)) {
        if (!(db.exec && db.exec.status === 'waiting' && db.exec.wait_kind === 'reply' && !db.exec.resume_exit)) return r([]);
        const key = db.exec.variables._wait_var || 'resposta';
        db.exec.variables = { ...db.exec.variables, ultima_mensagem: p[1], [key]: p[1] };
        db.exec.resume_exit = 'reply'; db.exec.run_at = db.clock().toISOString(); return r([{ id: 'e1' }]);
      }
      if (/^update public.flow_executions set /.test(s)) { applyPatch(s, p); return r([], 1); }
      if (/from public.flow_graph_versions where id/.test(s)) return r([{ graph }]);
      if (/insert into public.flow_execution_events/.test(s)) { db.events.push(`${p[3]}:${p[5]}`); return r([]); }
      if (/from public.leads where id = \$1/.test(s)) return r([lead]);
      if (/select timezone from public.organizations/.test(s)) return r([{ timezone: 'America/Sao_Paulo' }]);
      if (/from public.webhook_events where id = \$1/.test(s)) return r([{ tipo_evento: 'Pix Gerado', checkout_url: 'https://loja.test/c/abc' }]);
      if (/left join public.brands b/.test(s)) return r([{}]);
      if (/select tag_id from public.lead_tags/.test(s)) return r([...db.tags].map((tag_id) => ({ tag_id })));
      if (/tipo_evento = 'Compra Aprovada' and created_at/.test(s)) return r([]);
      if (/bulk_reserve_usage/.test(s)) return r([{ ok: true }]);
      if (/insert into public.lead_tags/.test(s)) { for (const t of p[2]) db.tags.add(t); return r([], 1); }
      if (/from public.whatsapp_templates where id::text/.test(s)) return r([{ id: p[0], components: [] }]);
      if (/insert into public.email_events/.test(s)) { db.emailEvents++; return r([]); }
      if (/update public.(lead_metrics|campaign_stats)/.test(s)) return r([], 1);
      if (/insert into public.whatsapp_inbound_messages/.test(s)) { if (db.inbound.has(p[2])) return r([]); db.inbound.add(p[2]); return r([{ id: 'in1' }]); }
      if (/from public.leads where organization_id = \$1 and right/.test(s)) return r([{ id: lead.id }]);
      if (/update public.whatsapp_inbound_messages|update public.leads set whatsapp_last_inbound_at/.test(s)) { if (/whatsapp_last_inbound_at/.test(s)) lead.whatsapp_last_inbound_at = db.clock().toISOString(); return r([], 1); }
      throw new Error('SQL não esperado no teste: ' + s.slice(0, 120));
    },
  };
  return { db, pool };
}

test('motor: inicia no Pix Gerado, usa modelo reserva com janela fechada, espera resposta, condiciona e etiqueta', async () => {
  const graph = g([
    trig('msg'),
    { ref: 'msg', type: 'send_text', data: { text: 'Oi {{primeiro_nome}}', fallback_template_id: 'tpl-1', fallback_vars: ['primeiro_nome'] }, next: { sent: 'esp' } },
    { ref: 'esp', type: 'wait_reply', data: { save_as: 'resp', timeout_minutes: 60 }, next: { reply: 'cond', timeout: 'fim' } },
    { ref: 'cond', type: 'condition', data: { rules: [{ kind: 'var', name: 'resp', op: 'contains', value: 'sim' }] }, next: { yes: 'tag', no: 'fim' } },
    { ref: 'tag', type: 'tag', data: { add: [T] }, next: { default: 'resp2' } },
    { ref: 'resp2', type: 'send_text', data: { text: 'Perfeito, {{primeiro_nome}}! Você disse: {{resp}}' }, next: { sent: 'fim' } },
    fim,
  ]);
  assert.equal(validateGraph(graph).ok, true);
  const lead = { id: 'l1', nome: 'Maria', telefone: '5511999990000', email: 'm@x.test', whatsapp_opt_out: false, whatsapp_last_inbound_at: null };
  const { db, pool } = fakeDb({ graph, lead });
  let clock = new Date('2026-10-19T17:30:00Z'); db.clock = () => clock;
  const sent = [];
  const whatsapp = {
    sendTemplateTo: async (org, a) => { sent.push(['template', a.template_id, a.variables.join('|')]); return { id: 'wamid.t' }; },
    sendTextTo: async (org, a) => { sent.push(['texto', a.text]); return { id: 'wamid.x' }; },
  };
  const rt = createFlowRuntime({ pool, whatsapp, now: () => clock, autoKick: false });

  const st = await rt.startForEvent({ orgId: 'o1', tokenId: 'k1', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  assert.deepEqual(st.started, ['c1']);
  await rt.tick();
  assert.deepEqual(sent, [['template', 'tpl-1', 'Maria']], 'janela fechada → modelo reserva');
  assert.equal(db.exec.status, 'waiting'); assert.equal(db.exec.current_ref, 'esp');

  // reentrega do mesmo evento não cria segunda execução
  assert.deepEqual((await rt.startForEvent({ orgId: 'o1', tokenId: 'k1', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' })).started, []);

  clock = new Date(clock.getTime() + 5 * 60e3);
  const msg = { id: 'wamid.in1', from: '5511999990000', type: 'text', text: { body: 'Sim, quero' } };
  assert.equal(await rt.onInbound({ orgId: 'o1', accountId: 'a1', message: msg, contacts: [] }), true);
  assert.equal(await rt.onInbound({ orgId: 'o1', accountId: 'a1', message: msg, contacts: [] }), false, 'reentrega da Meta é ignorada');
  await rt.tick();
  assert.deepEqual(sent[1], ['texto', 'Perfeito, Maria! Você disse: Sim, quero'], 'janela aberta → texto livre');
  assert.equal(db.exec.status, 'completed');
  assert.ok(db.tags.has(T));
  assert.deepEqual(db.events, ['ini:default', 'msg:sent', 'esp:waiting_reply', 'esp:reply', 'cond:yes', 'tag:default', 'resp2:sent', 'fim:completed']);
  assert.equal(db.emailEvents, 2, 'cada envio entra nas métricas do dashboard');
});

test('motor: sem resposta no prazo sai por "timeout"; falha temporária repete e depois segue por "failed"', async () => {
  const graph = g([
    trig('esp'),
    { ref: 'esp', type: 'wait_reply', data: { timeout_minutes: 30 }, next: { reply: 'fim', timeout: 'msg' } },
    { ref: 'msg', type: 'send_template', data: { template_id: 'tpl-2', vars: [] }, next: { sent: 'fim', failed: 'fim' } },
    fim,
  ]);
  const lead = { id: 'l1', nome: 'Ana', telefone: '5511988887777', email: 'a@x.test', whatsapp_opt_out: false };
  const { db, pool } = fakeDb({ graph, lead });
  let clock = new Date('2026-10-19T12:00:00Z'); db.clock = () => clock;
  let calls = 0;
  const whatsapp = { sendTemplateTo: async () => { calls++; throw Object.assign(new Error('Meta fora do ar'), { status: 503 }); } };
  const rt = createFlowRuntime({ pool, whatsapp, now: () => clock, autoKick: false });
  await rt.startForEvent({ orgId: 'o1', tokenId: 'k1', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  await rt.tick();
  assert.equal(db.exec.status, 'waiting');
  for (let i = 0; i < 6; i++) { clock = new Date(clock.getTime() + 40 * 60e3); await rt.tick(); }
  assert.equal(calls, 4, 'tenta até MAX_ATTEMPTS');
  assert.equal(db.exec.status, 'completed', 'segue pela saída failed (ligada ao fim)');
  assert.ok(db.events.includes('esp:timeout'));
  assert.ok(db.events.some((e) => e.startsWith('msg:failed')));
});

test('motor: lead que pediu SAIR encerra a execução sem enviar', async () => {
  const graph = g([trig('msg'), { ref: 'msg', type: 'send_template', data: { template_id: 'tpl' }, next: { sent: 'fim' } }, fim]);
  const lead = { id: 'l1', telefone: '5511900000000', whatsapp_opt_out: true };
  const { db, pool } = fakeDb({ graph, lead });
  const clock = new Date(); db.clock = () => clock;
  const rt = createFlowRuntime({ pool, whatsapp: { sendTemplateTo: async () => assert.fail('não deveria enviar') }, now: () => clock, autoKick: false });
  await rt.startForEvent({ orgId: 'o1', tokenId: 'k1', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  await rt.tick();
  assert.equal(db.exec.status, 'cancelled');
});
