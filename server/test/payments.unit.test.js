import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCashin, normalizeCharge, parseWebhook, createXpag, PaymentError } from '../src/payments/xpag.js';
import { buildCapiEvent } from '../src/payments/pixel.js';
import { validateGraph } from '../src/flows/graph.js';
import { createFlowRuntime, plainNumber } from '../src/flows/runtime.js';

const base = { externalId: 'kb-1', webhookUrl: 'https://api.kobly.test/webhooks/payments/xpag/tok' };

test('XPag: corpo do /cashin por moeda e método', () => {
  assert.deepEqual(buildCashin({ ...base, currency: 'BRL', method: 'PIX', amount: 45, name: 'Ana', document: '123.456.789-00' }),
    { currency: 'BRL', external_id: 'kb-1', webhook_url: base.webhookUrl, amount: 45, name: 'Ana', document: '12345678900' });
  const oxxo = buildCashin({ ...base, currency: 'MXN', method: 'OXXO', amount: 250, name: 'Luis', email: 'l@x.test' });
  assert.equal(oxxo.method, 'OXXO'); assert.deepEqual(oxxo.payerData, { name: 'Luis', email: 'l@x.test' }); assert.equal(oxxo.generateCheckout, false);
  const spei = buildCashin({ ...base, currency: 'MXN', method: 'SPEI', openAmount: true });
  assert.equal('amount' in spei, false, 'valor livre: sem amount');
  assert.equal(buildCashin({ ...base, currency: 'COP', method: 'NEQUI', amount: 20000, phone: '+57 300 123 4567' }).method, 'NEQUI_QR');
  assert.equal(buildCashin({ ...base, currency: 'COP', method: 'BREB', amount: 20000 }).method, 'BREB');
  assert.equal(buildCashin({ ...base, currency: 'ARS', method: 'BANK_TRANSFER', amount: 1000, name: 'Juan', document: '20-12345678-9' }).document_type, 'CUIT');
});

test('XPag: resposta de cada país vira o mesmo formato (código, QR, link)', () => {
  const pix = normalizeCharge('BRL', 'PIX', { ok: true, copyPaste: '000201abc', transaction_id: 'pr_1', request_number: 'pr_1' });
  assert.equal(pix.code, '000201abc'); assert.match(pix.qr, /^https:\/\/quickchart\.io\/qr\?size=480&text=000201abc$/);
  const spei = normalizeCharge('MXN', 'SPEI', { clabe: '012345678901234567', reference: 'REF1', bank_name: 'STP', transaction_id: 'pr_2', status: 'pending' });
  assert.equal(spei.code, '012345678901234567'); assert.equal(spei.extra.referencia, 'REF1');
  const oxxo = normalizeCharge('MXN', 'OXXO', { transaction_id: 'oxxo_1', payee_data: { reference: '8204240000119882', barcode: 'https://static.test/b.png' } });
  assert.equal(oxxo.code, '8204240000119882'); assert.equal(oxxo.qr, 'https://static.test/b.png');
  const ars = normalizeCharge('ARS', 'BANK_TRANSFER', { awaiting_instruction: true, payee_data: null, transaction_id: 'ars_1' });
  assert.equal(ars.code, null); assert.equal(ars.awaitingInstruction, true);
});

test('XPag: aviso só serve de gatilho; erros viram códigos e falha temporária repete', async () => {
  assert.deepEqual(parseWebhook({ type: 'cashin', status: 'confirmed', transaction_id: 'pr_1', external_id: 'kb-1', e2e: 'E1' }),
    { transactionId: 'pr_1', externalId: 'kb-1', status: 'confirmed', dedupeKey: 'E1:confirmed' });
  assert.equal(parseWebhook({ type: 'cashout', status: 'completed' }), null);
  const fail = (status, body) => async () => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
  const cred = { clientId: 'a', clientSecret: 'b' };
  await assert.rejects(createXpag({ fetchImpl: fail(422, { ok: false, error: 'Valor abaixo do mínimo', error_code: 'amount_below_min' }) }).createCharge(cred, { ...base, currency: 'MXN', method: 'OXXO', amount: 1 }),
    (e) => e instanceof PaymentError && e.code === 'amount_below_min' && e.status === 422);
  await assert.rejects(createXpag({ fetchImpl: fail(400, { ok: false, error: 'indisponível', error_code: 'provider_unavailable' }) }).createCharge(cred, { ...base, currency: 'BRL', method: 'PIX', amount: 5 }),
    (e) => e.status === 503, 'provider_unavailable é temporário');
  let seen = null;
  const ok = async (url, init) => { seen = { url: String(url), headers: init.headers }; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, status: 'confirmed', amount: 45 }) }; };
  assert.deepEqual(await createXpag({ fetchImpl: ok }).consult(cred, { transactionId: 'pr_9' }), { status: 'confirmed', amount: 45 });
  assert.match(seen.url, /\/consult-transaction\?transaction_id=pr_9$/); assert.equal(seen.headers['X-Client-Id'], 'a');
});

test('Pixel (API de Conversões): dados pessoais só em hash; valor e moeda na compra', () => {
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  const ev = buildCapiEvent({ eventName: 'Purchase', eventId: 'ch-1', eventTime: 1, lead: { id: 'l1', email: ' Ana@X.test ', telefone: '+52 1 55 1234 5678' }, value: 45, currency: 'MXN' });
  assert.deepEqual(ev.user_data, { em: [sha('ana@x.test')], ph: [sha('5215512345678')], external_id: [sha('l1')] });
  assert.deepEqual(ev.custom_data, { value: 45, currency: 'MXN' });
  assert.equal(JSON.stringify(ev).includes('Ana@X'), false);
  assert.equal(buildCapiEvent({ eventName: 'Lead', eventId: 'x', eventTime: 1, lead: {} }).custom_data, undefined);
});

test('valor: aceita "45", "45,90", "1.234,50" e "$ 1,234.50"', () => {
  assert.equal(plainNumber('45'), 45); assert.equal(plainNumber('45,90'), 45.9);
  assert.equal(plainNumber('1234.5'), 1234.5); assert.equal(plainNumber('$ 1,234.50'), 1234.5);
  assert.equal(plainNumber('1.234,50'), 1234.5); assert.equal(plainNumber('R$ 10.000,00'), 10000); assert.equal(plainNumber('20,000'), 20000);
  assert.ok(Number.isNaN(plainNumber(''))); assert.ok(Number.isNaN(plainNumber('abc')));
});

test('validação do bloco de cobrança', () => {
  const g = (data, next = { charge_created: 'fim' }) => validateGraph({ version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'pg' } },
    { ref: 'pg', type: 'payment', data, next }, { ref: 'fim', type: 'end', data: {}, next: {} }] });
  assert.equal(g({ integration_id: 'i1', currency: 'MXN', method: 'OXXO', amount: '100' }).ok, true);
  assert.equal(g({ integration_id: 'i1', currency: 'MXN', method: 'SPEI', open_amount: true }).ok, true);
  assert.match(g({ integration_id: 'i1', currency: 'MXN', method: 'OXXO', amount: '5' }).errors.join(), /10 a 10\.000/);
  assert.match(g({ integration_id: 'i1', currency: 'MXN', method: 'OXXO', open_amount: true }).errors.join(), /valor livre só existe/);
  assert.match(g({ integration_id: 'i1', currency: 'BRL', method: 'SPEI', amount: '10' }).errors.join(), /para BRL use PIX/);
  assert.match(g({ currency: 'BRL', method: 'PIX', amount: '10' }).errors.join(), /conta do gateway/);
  assert.equal(g({ integration_id: 'i1', currency: 'BRL', method: 'PIX', amount: '{{valor_oferta}}' }).ok, true, 'valor por variável');
});

// ---- ponta a ponta: cobra → espera resposta → pagamento confirmado puxa o fluxo → venda + pixel ----
test('motor: cobrança SPEI, código na mensagem, confirmação puxa para "aprovado", registra venda e envia Pixel', async () => {
  const graph = { version: 1, start: 'ini', nodes: [
    { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'pg' } },
    { ref: 'pg', type: 'payment', data: { integration_id: 'int-1', currency: 'MXN', method: 'SPEI', amount: '{{valor_oferta}}' }, next: { charge_created: 'msg', payment_approved: 'venda', error: 'fim' } },
    { ref: 'msg', type: 'send_text', data: { text: 'CLABE: {{pagamento_codigo}} ({{pagamento_banco}}) — {{pagamento_valor}} MXN' }, next: { sent: 'esp' } },
    { ref: 'esp', type: 'wait_reply', data: { timeout_minutes: 60 }, next: { reply: 'fim', timeout: 'fim' } },
    { ref: 'venda', type: 'record_sale', data: {}, next: { default: 'px' } },
    { ref: 'px', type: 'pixel', data: { pixel_config_id: 'px-1', event: 'Purchase' }, next: { default: 'fim' } },
    { ref: 'fim', type: 'end', data: {}, next: {} },
  ] };
  assert.equal(validateGraph(graph).ok, true, validateGraph(graph).errors.join());

  let clock = new Date('2026-10-20T15:00:00Z');
  const lead = { id: 'l1', nome: 'Rosa', email: 'r@x.test', telefone: '5215512345678', whatsapp_opt_out: false, whatsapp_last_inbound_at: new Date(clock - 60e3).toISOString() };
  const db = { exec: null, events: [], sales: [], vendasRecuperadas: 0 };
  const pool = {
    async query(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ');
      const r = (rows, rowCount = rows.length) => ({ rows, rowCount });
      if (/stop_on_purchase returning id/.test(s)) return r([]);
      if (/join public.flow_graph_versions v on v.flow_id = f.id and v.is_active/.test(s)) return r([{ campaign_id: 'c1', flow_id: 'f1', version_id: 'v1', graph }]);
      if (/insert into public.flow_executions/.test(s)) { db.exec = { id: 'e1', organization_id: p[0], campaign_id: p[1], flow_id: p[2], graph_version_id: p[3], lead_id: p[4], current_ref: p[6], variables: { ...JSON.parse(p[8]), valor_oferta: '45' }, status: 'running', attempts: 0, steps_count: 0, started_at: new Date(0).toISOString(), run_at: new Date(0).toISOString() }; return r([{ id: 'e1' }]); }
      if (/with due as/.test(s)) { const ok = ['running', 'waiting'].includes(db.exec.status) && new Date(db.exec.run_at) <= clock && !db.exec.lease_until; if (!ok) return r([]); db.exec.lease_until = 'x'; return r([{ ...db.exec, variables: { ...db.exec.variables } }]); }
      if (/select \* from public.flow_executions where id/.test(s)) return r([{ ...db.exec }]);
      if (/resume_exit = 'payment_approved'/.test(s)) {
        if (db.exec.lease_until) return r([]);
        Object.assign(db.exec, { status: 'waiting', wait_kind: 'timer', resume_exit: 'payment_approved', current_ref: p[1], variables: { ...db.exec.variables, ...JSON.parse(p[2]) }, run_at: clock.toISOString(), attempts: 0 });
        return r([{ id: 'e1' }]);
      }
      if (/^update public.flow_executions set /.test(s)) {
        const m = /set (.+), lease_until = /.exec(s);
        for (const part of m[1].split(', ')) { const [col, ph] = part.split(' = '); let v = p[Number(ph.slice(1)) - 1]; if (col === 'variables') v = JSON.parse(v); db.exec[col] = v; }
        db.exec.lease_until = /lease_until = null/.test(s) ? null : 'x'; return r([], 1);
      }
      if (/from public.flow_graph_versions where id/.test(s)) return r([{ graph }]);
      if (/insert into public.flow_execution_events/.test(s)) { db.events.push(`${p[3]}:${p[5]}`); return r([]); }
      if (/from public.leads where id = \$1/.test(s)) return r([lead]);
      if (/select timezone/.test(s)) return r([{ timezone: 'America/Mexico_City' }]);
      if (/left join public.brands b/.test(s)) return r([{}]);
      if (/bulk_reserve_usage/.test(s)) return r([{ ok: true }]);
      if (/insert into public.email_events|update public.(lead_metrics|campaign_stats)/.test(s)) return r([], 1);
      if (/insert into public.flow_sales/.test(s)) { if (db.sales.some((x) => x.charge === p[4])) return r([]); db.sales.push({ charge: p[4], amount: p[5], currency: p[6] }); return r([{ id: 's1' }]); }
      if (/increment_vendas_recuperadas/.test(s)) { db.vendasRecuperadas++; return r([]); }
      if (/from public.global_variables/.test(s)) return r([]); // variáveis globais da empresa (0074)
      if (/insert into public.whatsapp_outbound_messages/.test(s)) return r([], 1); // conversa do chat ao vivo
      throw new Error('SQL não esperado: ' + s.slice(0, 120));
    },
  };
  const sent = [];
  const charges = [];
  const payments = {
    async createCharge(a) {
      charges.push(a);
      return { id: '11111111-1111-4111-8111-111111111111', payment_code: '012345678901234567', payment_qr: null, checkout_url: null, amount: a.amount, status: 'pending', extra: { banco: 'STP', referencia: 'REF1' } };
    },
  };
  const pixelCalls = [];
  const pixel = { send: async (a) => { pixelCalls.push(a); return { ok: true, detail: 'recebido: 1' }; } };
  const rt = createFlowRuntime({ pool, whatsapp: { sendTextTo: async (o, a) => { sent.push(a.text); return { id: 'w1' }; } }, payments, pixel, now: () => clock, autoKick: false, sleep: async () => {} });

  await rt.startForEvent({ orgId: 'o1', tokenId: 'k1', leadId: 'l1', webhookEventId: 'w1', tipo: 'Pix Gerado' });
  await rt.tick();
  assert.equal(charges[0].amount, 45); assert.equal(charges[0].externalId, 'kb-e1-pg-1'); assert.equal(charges[0].payer.name, 'Rosa');
  assert.deepEqual(sent, ['CLABE: 012345678901234567 (STP) — 45 MXN']);
  assert.equal(db.exec.status, 'waiting'); assert.equal(db.exec.current_ref, 'esp');

  // pagamento confirmado pelo gateway (já checado na API) puxa o fluxo, mesmo esperando resposta
  clock = new Date(clock.getTime() + 10 * 60e3);
  const pre = await rt.onPaymentConfirmed({ id: '11111111-1111-4111-8111-111111111111', execution_id: 'e1', node_ref: 'pg', amount: 45, paid_amount: 45, listen_until: new Date(clock.getTime() + 3600e3).toISOString() });
  assert.equal(pre.preempted, true);
  await rt.tick();
  assert.equal(db.exec.status, 'completed');
  assert.deepEqual(db.sales, [{ charge: '11111111-1111-4111-8111-111111111111', amount: 45, currency: 'MXN' }]);
  assert.equal(db.vendasRecuperadas, 1);
  assert.equal(pixelCalls[0].eventName, 'Purchase'); assert.equal(pixelCalls[0].value, 45); assert.equal(pixelCalls[0].currency, 'MXN');
  assert.equal(pixelCalls[0].eventId, '11111111-1111-4111-8111-111111111111', 'event_id = cobrança (sem contagem dupla)');
  assert.deepEqual(db.events.slice(-5), ['pg:payment_confirmed', 'pg:payment_approved', 'venda:default', 'px:default', 'fim:completed']);

  // fora do prazo de escuta: não puxa
  assert.equal((await rt.onPaymentConfirmed({ id: 'x', execution_id: 'e1', node_ref: 'pg', listen_until: new Date(clock.getTime() - 1).toISOString() })).preempted, false);
});
