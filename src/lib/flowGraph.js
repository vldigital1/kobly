// Fluxo em grafo (editor visual): catálogo de blocos e conversão grafo ⇄ canvas (React Flow).
// O formato salvo é o mesmo validado pelo servidor (server/src/flows/graph.js):
//   { version: 1, start: 'ini', nodes: [{ ref, type, data, next: { <saída>: <ref> }, position }] }
// O servidor é a autoridade da validação; aqui só ajudamos a montar e a mostrar.

export const TIPOS_EVENTO = ['Abandono de carrinho', 'Pix Gerado', 'Boleto Gerado', 'Compra Recusada', 'Depósito Solicitado',
  'Compra Aprovada', 'Compra cancelada', 'Compra Reembolsada', 'Chargeback', 'Cancelamento de Assinatura'];

// group: seção da paleta. exits: [saída, rótulo]. dynamic: saídas que vêm dos dados (opções / saídas da IA).
export const BLOCKS = {
  trigger: { label: 'Gatilho', group: null, icon: 'play', tone: 'accent', hint: 'Evento de checkout que inicia o fluxo',
    exits: [['default', 'Próximo']], make: () => ({ events: ['Pix Gerado'] }) },
  send_template: { label: 'Modelo do WhatsApp', group: 'Mensagens', icon: 'file-text', tone: 'green', hint: 'Modelo aprovado pela Meta. Funciona mesmo com a janela de 24 h fechada.',
    exits: [['sent', 'Enviado'], ['failed', 'Falhou']], make: () => ({ template_id: '', vars: [] }) },
  send_text: { label: 'Texto', group: 'Mensagens', icon: 'message-circle', tone: 'green', hint: 'Texto livre (janela de 24 h aberta). Com modelo reserva, troca sozinho quando a janela fecha.',
    exits: [['sent', 'Enviado'], ['window_closed', 'Janela fechada'], ['failed', 'Falhou']], make: () => ({ text: 'Oi {{primeiro_nome}}!' }) },
  send_media: { label: 'Mídia', group: 'Mensagens', icon: 'image', tone: 'green', hint: 'Imagem, áudio, vídeo ou PDF por link https.',
    exits: [['sent', 'Enviado'], ['window_closed', 'Janela fechada'], ['failed', 'Falhou']], make: () => ({ kind: 'document', url: '', caption: '' }) },
  send_buttons: { label: 'Botões / lista', group: 'Mensagens', icon: 'list', tone: 'green', hint: 'Pergunta com opções; cada opção vira uma saída. Espera a resposta.',
    exits: [['other', 'Outra resposta'], ['timeout', 'Sem resposta'], ['failed', 'Falhou']],
    dynamic: (d) => (d.options || []).map((o) => [`opt_${o.id}`, o.title || o.id]),
    make: () => ({ text: 'Posso te enviar agora?', options: [{ id: 'sim', title: 'Sim' }, { id: 'nao', title: 'Não' }], timeout_minutes: 60 }) },
  delay: { label: 'Esperar', group: 'Controle', icon: 'clock', tone: 'amber', hint: 'Pausa fixa ou aleatória, com "digitando..."',
    exits: [['default', 'Depois']], make: () => ({ min_seconds: 3, max_seconds: 6, typing: true }) },
  wait_reply: { label: 'Aguardar resposta', group: 'Controle', icon: 'message-square-reply', tone: 'amber', hint: 'Espera o lead responder e guarda o texto numa variável.',
    exits: [['reply', 'Respondeu'], ['timeout', 'Sem resposta']], make: () => ({ save_as: 'resposta', timeout_minutes: 60 }) },
  condition: { label: 'Condição', group: 'Controle', icon: 'git-branch', tone: 'blue', hint: 'Etiqueta, variável, compra, janela, dia, horário ou país.',
    exits: [['yes', 'Sim'], ['no', 'Não']], make: () => ({ match: 'all', rules: [{ kind: 'var', name: 'resposta', op: 'contains', value: 'sim' }] }) },
  ai_classify: { label: 'IA: entender resposta', group: 'IA', icon: 'sparkles', tone: 'purple', hint: 'A IA escolhe uma saída conforme o que o lead quis dizer.',
    exits: [['other', 'Nenhuma'], ['error', 'Erro']],
    dynamic: (d) => (d.outputs || []).map((o) => [`out_${o.key}`, o.key]),
    make: () => ({ input: '{{resposta}}', outputs: [{ key: 'sim', description: 'aceitou ou quer continuar' }, { key: 'nao', description: 'recusou' }] }) },
  ai_extract: { label: 'IA: extrair dados', group: 'IA', icon: 'search', tone: 'purple', hint: 'Tira campos da resposta (cidade, plano...) e salva em variáveis.',
    exits: [['ok', 'Extraiu'], ['missing', 'Faltou dado'], ['error', 'Erro']], make: () => ({ input: '{{resposta}}', fields: [{ name: 'cidade', description: 'cidade do cliente', required: true }] }) },
  tag: { label: 'Etiquetas', group: 'Ações', icon: 'tag', tone: 'neutral', hint: 'Adiciona ou remove etiquetas do lead.',
    exits: [['default', 'Próximo']], make: () => ({ add: [], remove: [] }) },
  set_var: { label: 'Definir variável', group: 'Ações', icon: 'pencil', tone: 'neutral', hint: 'Grava texto ou faz conta numa variável.',
    exits: [['default', 'Próximo']], make: () => ({ name: 'etapa', op: 'set', value: '1' }) },
  end: { label: 'Fim', group: 'Ações', icon: 'flag', tone: 'neutral', hint: 'Encerra o fluxo para o lead.', exits: [], make: () => ({}) },
};
export const PALETTE_GROUPS = ['Mensagens', 'Controle', 'IA', 'Ações'];
export const TONES = {
  accent: 'var(--accent)', green: 'var(--green-500)', amber: 'var(--amber-500)', blue: '#4C8DFF', purple: '#9B6CFF', neutral: 'var(--ink-400)',
};

export function exitsOf(node) {
  const b = BLOCKS[node && node.type];
  if (!b) return [];
  return [...(b.dynamic ? b.dynamic((node && node.data) || {}) : []), ...b.exits];
}

export function newRef(type, taken) {
  const base = type.replace(/^send_/, '').replace(/_/g, '-').slice(0, 12);
  for (let i = 1; i < 1000; i++) { const r = `${base}-${i}`; if (!taken.has(r)) return r; }
  return `${base}-${Date.now()}`;
}

export function emptyGraph() {
  return { version: 1, start: 'ini', nodes: [{ ref: 'ini', type: 'trigger', data: BLOCKS.trigger.make(), next: {}, position: { x: 0, y: 0 } }] };
}

// grafo salvo → nós/arestas do canvas
export function toCanvas(graph) {
  const nodes = (graph.nodes || []).map((n, i) => ({
    id: n.ref, type: 'kobly', position: n.position || { x: (i % 4) * 280, y: Math.floor(i / 4) * 200 },
    data: { type: n.type, data: n.data || {}, isStart: n.ref === graph.start },
    deletable: n.ref !== graph.start,
  }));
  const edges = [];
  for (const n of graph.nodes || []) for (const [exit, target] of Object.entries(n.next || {})) {
    if (target) edges.push({ id: `${n.ref}:${exit}`, source: n.ref, sourceHandle: exit, target, type: 'smoothstep' });
  }
  return { nodes, edges };
}

// canvas → grafo salvo (só arestas de saídas que ainda existem no bloco)
export function fromCanvas(nodes, edges, start = 'ini') {
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  const out = nodes.map((n) => {
    const node = { ref: n.id, type: n.data.type, data: n.data.data || {}, next: {}, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } };
    const valid = new Set(exitsOf(node).map(([k]) => k));
    for (const e of edges) if (e.source === n.id && valid.has(e.sourceHandle) && byNode.has(e.target)) node.next[e.sourceHandle] = e.target;
    return node;
  });
  return { version: 1, start, nodes: out };
}

// Resumo de uma linha mostrado no cartão do bloco.
export function summaryOf(type, d, lookups = {}) {
  switch (type) {
    case 'trigger': return (d.events || []).join(', ') || 'Escolha o evento';
    case 'send_template': return (lookups.templates || []).find((t) => t.id === d.template_id)?.name || 'Escolha o modelo';
    case 'send_text': return d.text || '';
    case 'send_media': return `${{ image: 'Imagem', audio: 'Áudio', video: 'Vídeo', document: 'Documento' }[d.kind] || 'Mídia'}${d.url ? ' · ' + d.url.split('/').pop() : ''}`;
    case 'send_buttons': return d.text || '';
    case 'delay': {
      const a = d.min_seconds ?? d.seconds ?? 0, b = d.max_seconds ?? d.seconds ?? a;
      const f = (s) => (s >= 3600 ? `${Math.round(s / 360) / 10} h` : s >= 60 ? `${Math.round(s / 6) / 10} min` : `${s} s`);
      return `${a === b ? f(a) : `${f(a)} a ${f(b)}`}${d.typing ? ' · digitando' : ''}`;
    }
    case 'wait_reply': return `Salva em {{${d.save_as || 'resposta'}}}${d.timeout_minutes ? ` · até ${d.timeout_minutes} min` : ''}`;
    case 'condition': return `${(d.rules || []).length} regra(s) · ${d.match === 'any' ? 'qualquer uma' : 'todas'}`;
    case 'ai_classify': return `Lê ${d.input || '{{resposta}}'}`;
    case 'ai_extract': return (d.fields || []).map((f) => f.name).join(', ');
    case 'tag': return `${(d.add || []).length ? `+${(d.add || []).length}` : ''} ${(d.remove || []).length ? `−${(d.remove || []).length}` : ''}`.trim() || 'Escolha etiquetas';
    case 'set_var': return `${d.name || '?'} ${d.op && d.op !== 'set' ? d.op : '='} ${d.value ?? ''}`;
    default: return '';
  }
}
