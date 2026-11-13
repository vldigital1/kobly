import { describe, it, expect } from 'vitest';
import { startSim, reply, choose, simVars } from '@/lib/flowSim.js';

const graph = {
  version: 1, start: 'ini',
  nodes: [
    { ref: 'ini', type: 'trigger', data: { source: 'message', mode: 'keywords', keywords: ['quero'] }, next: { default: 't1' } },
    { ref: 't1', type: 'send_text', data: { text: 'Oi {{primeiro_nome}}! Pode pagar?' }, next: { sent: 'd1' } },
    { ref: 'd1', type: 'delay', data: { min_seconds: 3, max_seconds: 6, typing: true }, next: { default: 'w1' } },
    { ref: 'w1', type: 'wait_reply', data: { save_as: 'comp', timeout_minutes: 60 }, next: { reply: 'c1', timeout: 'fim' } },
    { ref: 'c1', type: 'condition', data: { match: 'all', rules: [{ kind: 'var', name: 'comp', op: 'contains', value: 'sim' }] }, next: { yes: 'tg', no: 'ia' } },
    { ref: 'tg', type: 'tag', data: { add: ['t-1'], remove: [] }, next: { default: 'nt' } },
    { ref: 'nt', type: 'notify', data: { channel_id: '', text: 'venda' }, next: { default: 'fim' } },
    { ref: 'ia', type: 'ai_classify', data: { input: '{{comp}}', outputs: [{ key: 'sim', description: 'aceitou' }] }, next: { out_sim: 'tg', other: 'fim' } },
    { ref: 'fim', type: 'end', data: {}, next: {} },
  ],
};
const lookups = { tags: [{ id: 't-1', nome: 'Comprador' }], channels: [] };

describe('simulador do fluxo', () => {
  it('roda até esperar a resposta, avalia a condição igual ao servidor e termina', () => {
    let st = startSim(graph, { lookups });
    expect(st.log[0]).toMatchObject({ kind: 'in', text: 'quero' });
    expect(st.log.find((x) => x.kind === 'out').text).toBe('Oi Maria! Pode pagar?');
    expect(st.log.some((x) => x.kind === 'sys' && /Aguardando 3s a 6s/.test(x.text))).toBe(true);
    expect(st.wait).toMatchObject({ kind: 'reply', ref: 'w1' });
    st = reply(st, 'Sim, mandei');
    expect(st.log.some((x) => x.text === 'Condição avaliada → Sim')).toBe(true);
    expect(st.log.some((x) => x.text === 'Etiquetas: + Comprador')).toBe(true);
    expect(st.log.some((x) => x.text === 'Alerta sem canal: bloco pulado')).toBe(true);
    expect(st.done).toBe(true);
    expect(simVars(st).find(([k]) => k === 'comp')[1]).toBe('Sim, mandei');
  });

  it('IA vira escolha na tela; resposta "não" cai no Não da condição', () => {
    let st = startSim(graph, { lookups });
    st = reply(st, 'ainda não');
    expect(st.log.some((x) => x.text === 'Condição avaliada → Não')).toBe(true);
    expect(st.wait).toMatchObject({ kind: 'choose', ref: 'ia' });
    st = choose(st, 'out_sim');
    expect(st.log.some((x) => x.text === 'Etiquetas: + Comprador')).toBe(true);
    expect(st.done).toBe(true);
  });

  it('Instagram: comentário mostra a resposta pública e a regra "segue o perfil"', () => {
    const g = { version: 1, start: 'ini', nodes: [
      { ref: 'ini', type: 'trigger', data: { source: 'ig_comment', mode: 'keywords', keywords: ['eu quero'], replies: ['Te chamei no Direct!'] }, next: { default: 'c' } },
      { ref: 'c', type: 'condition', data: { match: 'all', rules: [{ kind: 'ig_follows', op: 'follows' }] }, next: { yes: 't', no: 'fim' } },
      { ref: 't', type: 'send_text', data: { text: 'Link: {{comentario}}' }, next: { sent: 'fim' } },
      { ref: 'fim', type: 'end', data: {}, next: {} },
    ] };
    const st = startSim(g);
    expect(st.log[0].text).toBe('Gatilho: Maria comentou "eu quero" num post');
    expect(st.log.some((x) => /Resposta pública no comentário: "Te chamei no Direct!"/.test(x.text))).toBe(true);
    expect(st.log.find((x) => x.kind === 'out').text).toBe('Link: eu quero');
    expect(st.done).toBe(true);
  });

  it('saída sem ligação encerra com aviso; laço sem espera é interrompido', () => {
    const solto = { version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'a' } }, { ref: 'a', type: 'send_text', data: { text: 'x' }, next: {} }] };
    const st = startSim(solto);
    expect(st.log.at(-1).text).toMatch(/não está ligada/);
    const laco = { version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: { events: ['Pix Gerado'] }, next: { default: 'a' } }, { ref: 'a', type: 'checkpoint', data: { name: 'x' }, next: { default: 'b' } }, { ref: 'b', type: 'checkpoint', data: { name: 'y' }, next: { default: 'a' } }] };
    expect(startSim(laco).log.at(-1).text).toMatch(/laço/);
  });
});
