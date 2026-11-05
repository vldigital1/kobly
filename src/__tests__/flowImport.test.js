import { describe, it, expect } from 'vitest';
import { convertFlowJson, convertVars } from '@/lib/flowImport.js';
import { validateGraph } from '../../server/src/flows/graph.js';

// Formatos reais (resumidos) do ZapData (MCP / editor) e da Leona.
const zap = { fluxo: { name: 'Mente Viva', trigger: { type: 'keyword', keywords: ['saber más'], match: 'contains' }, blocks: [
  { ref: 'd1', type: 'delay', data: { unit: 'seconds', delayType: 'variable', minDelay: 3, maxDelay: 6, presence: 'composing' }, next: { default: 't1' } },
  { ref: 't1', type: 'text', data: { message: 'Hola {{nome}}! {{spei_clabe}}', reactToLastMessage: true, reactionEmoji: '❤️' }, next: { default: 'w1' } },
  { ref: 'w1', type: 'waitInput', data: { variableName: 'resposta1', timeoutEnabled: true, timeout: 30, timeoutUnit: 'minutes' }, next: { default: 'c1', no_response: 'a1' } },
  { ref: 'c1', type: 'condition', data: { conditions: [{ type: 'ia', iaPromptYes: 'aceita', iaPromptNo: 'recusa' }] }, next: { yes: 'tg', no: 'a1', error: 'a1' } },
  { ref: 'tg', type: 'tag', data: { actionType: 'add_tag', tagName: 'MV PARTE 1' }, next: { default: 'c2' } },
  { ref: 'c2', type: 'condition', data: { conditions: [{ type: 'tag', tagName: 'MV PARTE 1', tagCondition: 'has' }], logicOperator: 'and' }, next: { yes: 'a1', no: 'a1' } },
  { ref: 'a1', type: 'audio', data: { mediaUrl: 'https://cdn.x/a.ogg', sendAsForwarded: true, viewOnce: true }, next: { default: 'm1' } },
  { ref: 'm1', type: 'interactiveBlock', data: { text: 'Escolha', choices: ['Sim', 'Não', 'Site|https://x.com'] }, next: { 'choice-0': 'p1', 'choice-1': 'x1' } },
  { ref: 'p1', type: 'pixApi', data: { country: 'MX', method: 'spei', amount: '100', caption: 'CLABE {{spei_clabe}}' }, next: { sucesso: 'x1', erro: 'x1' } },
  { ref: 'x1', type: 'carousel', data: {}, next: {} },
] } };

const leona = { flow: { name: 'Funil MX' }, nodes: [
  { id: 1, node_type: 'start', actions: [] },
  { id: 2, node_type: 'message', name: 'Oi', position: { x: 0, y: 0 }, actions: [
    { order: 1, action_type: 'send_message', config: { message_text: 'Hola {full_name}', typing_delay_seconds: 3 } },
    { order: 2, action_type: 'send_multi_media', config: { media_type: 'audio', media_url: 'https://cdn/a.ogg', audio_forward: true } }] },
  { id: 3, node_type: 'wait_response', actions: [{ action_type: 'wait_for_response', config: { wait_indefinitely: false, timeout_value: 2, timeout_unit: 'hours' } }, { action_type: 'save_user_data', config: { field_name: 'resposta' } }] },
  { id: 4, node_type: 'ai', actions: [{ action_type: 'ai_call', config: { user_message: '{resposta}', output_conditions: [{ output_key: 'SIM', prompt: 'aceitou' }, { output_key: 'NAO', prompt: 'recusou' }] } }] },
  { id: 5, node_type: 'payment', name: 'SPEI', actions: [{ action_type: 'create_payment_charge', config: { currency: 'MXN', method: 'SPEI', amount: '100,00', open_amount: true, gateway: 'xpag' } }] },
  { id: 6, node_type: 'tags', actions: [{ action_type: 'add_tags', config: { tags: ['PARTE 1'], action: 'add' } }] },
], connections: [
  { from_node_id: 1, to_node_id: 2, condition_config: { type: 'always' } },
  { from_node_id: 2, to_node_id: 3, condition_config: { type: 'always' } },
  { from_node_id: 3, to_node_id: 4, condition_config: { source_handle: 'client-response' } },
  { from_node_id: 3, to_node_id: 6, condition_type: 'timeout_or_unknown', condition_config: { source_handle: 'timeout' } },
  { from_node_id: 4, to_node_id: 5, condition_config: { output_key: 'SIM' } },
  { from_node_id: 4, to_node_id: 6, condition_config: { output_key: 'NAO' } },
  { from_node_id: 5, to_node_id: 6, condition_config: { condition_result: 'charge_created' } },
] };

const byType = (g) => Object.groupBy ? Object.groupBy(g.nodes, (n) => n.type) : g.nodes.reduce((a, n) => ((a[n.type] = a[n.type] || []).push(n), a), {});

describe('importar fluxo', () => {
  it('variáveis do ZapData e da Leona viram as da Kobly', () => {
    expect(convertVars('Oi {{nome}} {{spei_clabe}} {full_name} {resposta} {{{x}}}')).toBe('Oi {{nome}} {{pagamento_codigo}} {{nome}} {{resposta}} {{{x}}}');
  });

  it('ZapData: gatilho por palavra, opções de envio, IA, etiqueta, botões, cobrança e pendências', () => {
    const r = convertFlowJson(zap);
    expect(r.origem).toBe('ZapData');
    const g = r.graph, T = byType(g);
    expect(g.nodes.find((n) => n.ref === g.start).data).toEqual({ source: 'message', mode: 'keywords', keywords: ['saber más'], match: 'contains' });
    expect(T.delay[0].data).toEqual({ min_seconds: 3, max_seconds: 6, typing: true });
    expect(T.send_text[0].data).toMatchObject({ text: 'Hola {{nome}}! {{pagamento_codigo}}', react_last: true, react_emoji: '❤️' });
    expect(T.wait_reply[0].data).toEqual({ save_as: 'resposta1', timeout_minutes: 30 });
    expect(T.ai_classify[0].data.outputs.map((o) => o.key)).toEqual(['sim', 'nao']);
    expect(T.tag[0].data.add_names).toEqual(['MV PARTE 1']);
    expect(T.condition[0].data.rules[0]).toEqual({ kind: 'tag', op: 'has', tag_name: 'MV PARTE 1' });
    expect(T.send_media[0].data).toMatchObject({ kind: 'audio', forwarded: true, view_once: true });
    expect(T.send_buttons[0].data.options.map((o) => o.id)).toEqual(['sim', 'nao']);
    expect(T.payment[0].data).toMatchObject({ currency: 'MXN', method: 'SPEI', amount: '100' });
    // ligações seguem as saídas certas
    const w = T.wait_reply[0], c = T.ai_classify[0], btn = T.send_buttons[0];
    expect(g.nodes.find((n) => n.ref === w.next.reply).type).toBe('ai_classify');
    expect(w.next.timeout).toBe(T.send_media[0].ref);
    expect(c.next.out_sim).toBe(T.tag[0].ref);
    expect(g.nodes.find((n) => n.ref === btn.next.opt_sim).type).toBe('payment');
    expect(g.nodes.find((n) => n.ref === T.payment[0].next.charge_created).data.text).toBe('CLABE {{pagamento_codigo}}');
    expect(r.pendencias.some((p) => /Carrossel/.test(p))).toBe(true);
    expect(r.pendencias.some((p) => /gateway/.test(p))).toBe(true);
    // fora as pendências de configuração (conta do gateway), o grafo é válido
    const errs = validateGraph(g).errors.filter((e) => !/conta do gateway|etiqueta/.test(e));
    expect(errs).toEqual([]);
  });

  it('Leona: ações do bloco viram uma sequência e as saídas da IA e da cobrança são mantidas', () => {
    const r = convertFlowJson(leona);
    expect(r.origem).toBe('Leona'); expect(r.nome).toBe('Funil MX');
    const g = r.graph, T = byType(g);
    const ini = g.nodes.find((n) => n.ref === g.start);
    expect(g.nodes.find((n) => n.ref === ini.next.default).type).toBe('delay');
    expect(T.send_text[0].data.text).toBe('Hola {{nome}}');
    expect(T.send_media[0].data).toMatchObject({ kind: 'audio', forwarded: true });
    expect(T.wait_reply[0].data).toEqual({ save_as: 'resposta', timeout_minutes: 120 });
    expect(T.ai_classify[0].data.input).toBe('{{resposta}}');
    expect(g.nodes.find((n) => n.ref === T.ai_classify[0].next.out_sim).type).toBe('payment');
    expect(T.payment[0].data).toMatchObject({ currency: 'MXN', method: 'SPEI', open_amount: true });
    expect(g.nodes.find((n) => n.ref === T.payment[0].next.charge_created).type).toBe('tag');
    expect(T.wait_reply[0].next.timeout).toBe(T.tag[0].ref);
    const errs = validateGraph(g).errors.filter((e) => !/conta do gateway|etiqueta/.test(e));
    expect(errs).toEqual([]);
  });

  it('arquivo da própria Kobly volta igual', () => {
    const g = { version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: {} }] };
    expect(convertFlowJson({ kobly: 1, nome: 'X', graph: g })).toMatchObject({ nome: 'X', graph: g, origem: 'Kobly' });
  });
});
