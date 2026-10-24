import { describe, it, expect } from 'vitest';
import { BLOCKS, exitsOf, newRef, emptyGraph, toCanvas, fromCanvas, summaryOf } from '@/lib/flowGraph.js';

describe('fluxo em grafo (editor)', () => {
  it('grafo ⇄ canvas preserva blocos, ligações e posições', () => {
    const g = {
      version: 1, start: 'ini', nodes: [
        { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'b' }, position: { x: 0, y: 0 } },
        { ref: 'b', type: 'send_buttons', data: { text: 'Quer?', options: [{ id: 'sim', title: 'Sim' }, { id: 'nao', title: 'Não' }] }, next: { opt_sim: 'fim', opt_nao: 'fim' }, position: { x: 300, y: 40 } },
        { ref: 'fim', type: 'end', data: {}, next: {}, position: { x: 600, y: 40 } },
      ],
    };
    const c = toCanvas(g);
    expect(c.nodes.find((n) => n.id === 'ini').deletable).toBe(false);
    expect(c.edges.map((e) => e.id).sort()).toEqual(['b:opt_nao', 'b:opt_sim', 'ini:default']);
    expect(fromCanvas(c.nodes, c.edges)).toEqual(g);
  });

  it('ligação de saída que não existe mais (opção removida) é descartada ao salvar', () => {
    const c = toCanvas({ version: 1, start: 'ini', nodes: [
      { ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'b' } },
      { ref: 'b', type: 'send_buttons', data: { text: 'Q', options: [{ id: 'sim', title: 'Sim' }] }, next: { opt_sim: 'ini' } },
    ] });
    const edges = [...c.edges, { id: 'b:opt_velha', source: 'b', sourceHandle: 'opt_velha', target: 'ini' }];
    expect(fromCanvas(c.nodes, edges).nodes[1].next).toEqual({ opt_sim: 'ini' });
  });

  it('saídas dinâmicas e identificadores únicos', () => {
    expect(exitsOf({ type: 'ai_classify', data: { outputs: [{ key: 'pix' }, { key: 'oxxo' }] } }).map(([k]) => k)).toEqual(['out_pix', 'out_oxxo', 'other', 'error']);
    expect(exitsOf({ type: 'end' })).toEqual([]);
    expect(newRef('send_text', new Set(['text-1', 'text-2']))).toBe('text-3');
    expect(emptyGraph().nodes[0].type).toBe('trigger');
  });

  it('todo bloco da paleta nasce com dados e resumo', () => {
    for (const [type, b] of Object.entries(BLOCKS)) {
      expect(typeof b.make()).toBe('object');
      expect(typeof summaryOf(type, b.make(), { templates: [] })).toBe('string');
    }
    expect(summaryOf('delay', { min_seconds: 3, max_seconds: 5, typing: true })).toBe('3 s a 5 s · digitando');
  });
});
