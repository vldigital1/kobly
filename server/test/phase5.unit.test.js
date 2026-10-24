import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeFlow } from '../src/flows/copilot.js';
import { createMcp, guide, PROTOCOL_VERSIONS } from '../src/mcp/server.js';
import { NODE_TYPES } from '../src/flows/graph.js';

const graph = { version: 1, start: 'ini', nodes: [
  { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'tpl' } },
  { ref: 'tpl', type: 'send_template', data: { template_id: 't' }, next: { sent: 'esp' } },
  { ref: 'esp', type: 'wait_reply', data: {}, next: { reply: 'pg', timeout: 'fim' } },
  { ref: 'pg', type: 'payment', data: {}, next: { charge_created: 'txt', error: 'fim' } },
  { ref: 'txt', type: 'send_text', data: { text: 'código {{pagamento_codigo}}' }, next: { sent: 'fim' } },
  { ref: 'ab', type: 'split', data: { variants: [{ id: 'a', weight: 50 }, { id: 'b', weight: 50 }] }, next: { var_a: 'fim', var_b: 'fim' } },
  { ref: 'fim', type: 'end', data: {}, next: {} },
] };

test('copiloto: aponta onde o funil perde leads, com os números reais', () => {
  const byNode = [
    { ref: 'tpl', outcome: 'sent', leads: 100 }, { ref: 'esp', outcome: 'waiting_reply', leads: 100 },
    { ref: 'esp', outcome: 'reply', leads: 35 }, { ref: 'esp', outcome: 'timeout', leads: 65 },
    { ref: 'pg', outcome: 'charge_created', leads: 30 }, { ref: 'pg', outcome: 'error', leads: 5 }, { ref: 'pg', outcome: 'payment_approved', leads: 2 },
  ];
  const s = analyzeFlow(graph, byNode);
  const t = s.map((x) => `${x.ref}|${x.severity}|${x.title}`);
  assert.ok(t.includes('esp|alta|65% não respondem aqui'), t.join('\n'));
  assert.ok(t.includes('pg|alta|14% das cobranças dão erro'), t.join('\n'));
  assert.ok(t.includes('pg|alta|Só 7% das cobranças são pagas'), t.join('\n'));
  assert.ok(t.includes('pg|alta|Pagamentos confirmados não seguem para lugar nenhum'));
  assert.ok(t.some((x) => x.startsWith('null|media|Vendas do fluxo não entram no dashboard')));
  assert.equal(t.some((x) => x.startsWith('txt|')), false, 'texto que vem depois de uma resposta do lead (via cobrança instantânea) tem a janela aberta');
  const semResp = { ...graph, nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'd' } }, { ref: 'd', type: 'delay', data: { seconds: 60 }, next: { default: 'txt' } }, { ref: 'txt', type: 'send_text', data: { text: 'oi' }, next: { sent: 'fim' } }, { ref: 'fim', type: 'end', data: {}, next: {} }] };
  assert.ok(analyzeFlow(semResp, []).some((x) => x.ref === 'txt' && x.title === 'Texto livre sem plano B'), 'texto direto do gatilho é sinalizado');
  assert.equal(s[0].severity, 'alta', 'ordenado por prioridade');
  // amostra pequena: não opina sobre números
  assert.equal(analyzeFlow(graph, [{ ref: 'esp', outcome: 'timeout', leads: 9 }, { ref: 'esp', outcome: 'reply', leads: 1 }]).some((x) => x.ref === 'esp'), false);
});

test('copiloto: teste A/B compara vendas por caminho e só decide com amostra suficiente', () => {
  const g2 = { ...graph, nodes: [...graph.nodes, { ref: 'venda', type: 'record_sale', data: {}, next: {} }] };
  const paths = [];
  for (let i = 0; i < 40; i++) paths.push(new Set(['ab:var_a', ...(i < 12 ? ['venda:default'] : [])]));
  for (let i = 0; i < 40; i++) paths.push(new Set(['ab:var_b', ...(i < 4 ? ['venda:default'] : [])]));
  const s = analyzeFlow(g2, [], paths).find((x) => x.ref === 'ab');
  assert.equal(s.title, 'Caminho A vende mais'); assert.match(s.detail, /A: 12\/40 \(30%\) · B: 4\/40 \(10%\)/);
  const pouco = analyzeFlow(g2, [], paths.slice(0, 10).concat(paths.slice(40, 50))).find((x) => x.ref === 'ab');
  assert.equal(pouco.title, 'Teste A/B com poucos leads');
});

test('MCP: guia cobre todos os blocos; protocolo, autenticação e limites', async () => {
  const gd = guide();
  assert.deepEqual(gd.blocos.map((b) => b.type).sort(), Object.keys(NODE_TYPES).sort(), 'todo bloco documentado para a IA');
  const token = 'kbmcp_' + 'x'.repeat(43);
  const pool = { async query(sql, p) {
    if (/from public.mcp_tokens where token_hash/.test(sql)) return { rows: p[0] === createHash('sha256').update(token).digest('hex') ? [{ id: 'tk', organization_id: 'o1', last_used_at: new Date().toISOString() }] : [] };
    return { rows: [] };
  } };
  const calls = [];
  const flowAdmin = { handle: async (ctx, user, body) => {
    calls.push({ ctx, body });
    if (body.action === 'validate') return { ok: false, errors: ['bloco "x": ligue a saída "sent".'], warnings: [] };
    if (body.action === 'save_draft') return { ok: true, version: 7, draft: true, warnings: [] };
    if (body.action === 'stats') return { by_status: [{ status: 'completed', n: 3 }], by_ref: [], waiting_at: [], by_node: [], recent: [{ nome: 'Ana', email: 'ana@x.test' }] };
    return {};
  } };
  const mcp = createMcp({ pool, flowAdmin });
  const rpc = (msg, bearer = token) => mcp.handleHttp(bearer, JSON.stringify(msg));

  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'kbmcp_errado')).status, 401);
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.body.result.protocolVersion, '2025-03-26'); assert.equal(init.body.result.serverInfo.name, 'kobly');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).body.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.ok(list.body.result.tools.some((t) => t.name === 'kobly_salvar_rascunho'));
  assert.equal(list.body.result.tools.some((t) => /publicar/i.test(t.name)), false, 'não existe ferramenta de publicar');

  const val = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kobly_validar_fluxo', arguments: { graph: {} } } });
  assert.match(val.body.result.content[0].text, /ligue a saída/);
  const save = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'kobly_salvar_rascunho', arguments: { campaign_id: 'c1', graph: {}, nota: 'nova oferta' } } });
  assert.equal(JSON.parse(save.body.result.content[0].text).version, 7);
  assert.deepEqual(calls.find((c) => c.body.action === 'save_draft').body, { action: 'save_draft', campaign_id: 'c1', graph: {}, note: 'nova oferta', source: 'mcp' });
  assert.equal(calls[0].ctx.orgId, 'o1', 'a empresa vem do token, nunca dos argumentos');
  const met = JSON.parse((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'kobly_metricas', arguments: { campaign_id: 'c1' } } })).body.result.content[0].text);
  assert.equal('recent' in met, false, 'métricas sem dados pessoais'); assert.equal(JSON.stringify(met).includes('ana@x.test'), false);
  const bad = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'kobly_apagar_tudo', arguments: {} } });
  assert.equal(bad.body.result.isError, true);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 8, method: 'resources/list' })).body.error.code, -32601);
});

test('MCP: token aparece uma vez e só o hash vai para o banco; limite por token', async () => {
  const saved = [];
  const pool = { async query(sql, p) {
    if (/insert into public.mcp_tokens/.test(sql)) { saved.push(p); return { rows: [{ id: 'tk', label: p[1], token_prefix: p[2] }] }; }
    if (/token_hash = \$1/.test(sql)) return { rows: [{ id: 'tk', organization_id: 'o1', last_used_at: new Date().toISOString() }] };
    return { rows: [] };
  } };
  let n = 0;
  const mcp = createMcp({ pool, flowAdmin: { handle: async () => ({}) }, limiter: () => ++n <= 2 });
  const r = await mcp.handleTokens({ orgId: 'o1', role: 'Cliente' }, { action: 'create', label: 'Claude' });
  assert.match(r.token, /^kbmcp_[A-Za-z0-9_-]{40,}$/);
  assert.equal(saved[0].includes(r.token), false, 'token inteiro nunca é gravado');
  assert.equal(saved[0][3], createHash('sha256').update(r.token).digest('hex'));
  await assert.rejects(mcp.handleTokens({ orgId: 'o1', role: 'Suporte' }, { action: 'create' }), /não pode gerenciar/);
  const ping = () => mcp.handleHttp(r.token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  assert.equal((await ping()).status, 200); assert.equal((await ping()).status, 200); assert.equal((await ping()).status, 429);
});
