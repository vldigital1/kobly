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
    exits: [['sent', 'Enviado']], make: () => ({ template_id: '', vars: [] }) },
  send_text: { label: 'Texto', group: 'Mensagens', icon: 'message-circle', tone: 'green', hint: 'Mensagem de texto. Na API Oficial, escolha um modelo reserva para quando a janela de 24 h estiver fechada.',
    exits: [['sent', 'Enviado']], make: () => ({ text: 'Oi {{primeiro_nome}}!' }) },
  send_media: { label: 'Mídia', group: 'Mensagens', icon: 'image', tone: 'green', hint: 'Imagem, vídeo, áudio ou arquivo: envie do computador ou use um link.',
    exits: [['sent', 'Enviado']], make: (kind = 'image') => ({ kind, url: '', caption: '' }) },
  send_buttons: { label: 'Botões / lista', group: 'Mensagens', icon: 'list', tone: 'green', hint: 'Pergunta com opções; cada opção vira uma saída. Espera a resposta.',
    exits: [['other', 'Outra resposta'], ['timeout', 'Sem resposta']],
    dynamic: (d) => (d.options || []).map((o) => [`opt_${o.id}`, o.title || o.id]),
    make: () => ({ text: 'Posso te enviar agora?', options: [{ id: 'sim', title: 'Sim' }, { id: 'nao', title: 'Não' }], timeout_minutes: 60 }) },
  send_email: { label: 'E-mail', group: 'Mensagens', icon: 'mail', tone: 'blue', hint: 'E-mail com a marca da empresa e link de descadastro. Lead sem e-mail ou descadastrado segue o fluxo sem receber.',
    exits: [['default', 'Próximo']], make: () => ({ email_id: '' }) },
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
  payment: { label: 'Cobrança', group: 'Dinheiro', icon: 'credit-card', tone: 'accent', hint: 'Gera Pix, SPEI, OXXO, Nequi... no gateway e segue. Se o lead pagar (até 48 h), o fluxo pula para "Pago".',
    exits: [['charge_created', 'Cobrança gerada'], ['payment_approved', 'Pago'], ['error', 'Erro']],
    make: () => ({ integration_id: '', currency: 'BRL', method: 'PIX', amount: '{{valor}}', listen_hours: 48 }) },
  record_sale: { label: 'Registrar venda', group: 'Dinheiro', icon: 'receipt', tone: 'accent', hint: 'Conta a venda recuperada no dashboard (uma vez por cobrança).',
    exits: [['default', 'Próximo']], make: () => ({}) },
  pixel: { label: 'Pixel da Meta', group: 'Dinheiro', icon: 'target', tone: 'accent', hint: 'Envia Lead ou Purchase para a Meta (API de Conversões).',
    exits: [['default', 'Próximo']], make: () => ({ pixel_config_id: '', event: 'Purchase' }) },
  ai_agent: { label: 'Agente de IA', group: 'IA', icon: 'bot', tone: 'purple', hint: 'Conversa com o lead em vários turnos até concluir o objetivo, pedir um humano ou o lead sumir.',
    exits: [['done', 'Concluiu'], ['handoff', 'Pediu humano'], ['expiration', 'Sem resposta'], ['error', 'Erro']],
    make: () => ({ objective: 'Tirar dúvidas sobre o produto e levar o lead a pagar.', knowledge: '', max_turns: 10, timeout_minutes: 60 }) },
  split: { label: 'Teste A/B', group: 'Controle', icon: 'split', tone: 'blue', hint: 'Divide os leads entre caminhos pelos pesos. Cada lead fica sempre no mesmo caminho.',
    exits: [], dynamic: (d) => (d.variants || []).map((v) => [`var_${v.id}`, `${v.id.toUpperCase()} · ${v.weight}%`]),
    make: () => ({ variants: [{ id: 'a', weight: 50 }, { id: 'b', weight: 50 }] }) },
  checkpoint: { label: 'Contador', group: 'Controle', icon: 'flag-triangle-right', tone: 'blue', hint: 'Marca um ponto do funil para contar quantos leads chegam até aqui.',
    exits: [['default', 'Próximo']], make: () => ({ name: 'Etapa' }) },
  wait_until: { label: 'Horário comercial', group: 'Controle', icon: 'calendar-clock', tone: 'amber', hint: 'Espera o próximo horário de atendimento (no fuso da empresa) ou uma data e hora.',
    exits: [['default', 'Depois']], make: () => ({ mode: 'business_hours', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }) },
  notify: { label: 'Alerta (Telegram)', group: 'Ações', icon: 'bell', tone: 'neutral', hint: 'Avisa a equipe no Telegram (venda, erro de pagamento, lead pedindo humano).',
    exits: [['default', 'Próximo']], make: () => ({ channel_id: '', text: '🔔 {{nome}} ({{telefone}}) — {{evento}}' }) },
  tag: { label: 'Etiquetas', group: 'Ações', icon: 'tag', tone: 'neutral', hint: 'Adiciona ou remove etiquetas do lead.',
    exits: [['default', 'Próximo']], make: () => ({ add: [], remove: [] }) },
  set_var: { label: 'Definir variável', group: 'Ações', icon: 'pencil', tone: 'neutral', hint: 'Grava texto ou faz conta numa variável.',
    exits: [['default', 'Próximo']], make: () => ({ name: 'etapa', op: 'set', value: '1' }) },
  end: { label: 'Fim', group: null, icon: 'flag', tone: 'neutral', hint: 'Encerra o fluxo para o lead.', exits: [], make: () => ({}) },
};
export const PALETTE_GROUPS = ['Mensagens', 'Controle', 'IA', 'Dinheiro', 'Ações'];

// Cada tipo de mídia é um bloco próprio na paleta e no canvas (o bloco salvo continua send_media + kind).
export const MEDIA = {
  image: { label: 'Imagem', icon: 'image', accept: 'image/jpeg,image/png,image/webp', maxMb: 5, formats: 'JPG, PNG ou WEBP · até 5 MB' },
  video: { label: 'Vídeo', icon: 'video', accept: 'video/mp4,video/3gpp', maxMb: 16, formats: 'MP4 · até 16 MB' },
  audio: { label: 'Áudio', icon: 'mic', accept: 'audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr,.ogg,.opus,.mp3,.m4a', maxMb: 16, formats: 'OGG, MP3 ou M4A · até 16 MB · chega como áudio gravado' },
  document: { label: 'Arquivo', icon: 'paperclip', accept: '.pdf,.doc,.docx,.txt,.xls,.xlsx,.csv,.ppt,.pptx', maxMb: 30, formats: 'PDF, DOC, DOCX, TXT, XLS, XLSX · até 30 MB' },
};
// Itens da paleta por grupo: o bloco "Mídia" vira Imagem, Vídeo, Áudio e Arquivo.
export function paletteItems(group) {
  const out = [];
  for (const [type, b] of Object.entries(BLOCKS)) {
    if (b.group !== group) continue;
    if (type === 'send_media') for (const [kind, m] of Object.entries(MEDIA)) out.push({ key: `send_media:${kind}`, type, kind, label: m.label, icon: m.icon, tone: b.tone, hint: m.formats });
    else out.push({ key: type, type, label: b.label, icon: b.icon, tone: b.tone, hint: b.hint });
  }
  return out;
}
// Rótulo e ícone do bloco no canvas (mídia mostra o tipo).
export function metaOf(type, d = {}) {
  const b = BLOCKS[type] || { label: type, icon: 'circle', tone: 'neutral', hint: '' };
  if (type === 'send_media' && MEDIA[d.kind]) return { ...b, label: MEDIA[d.kind].label, icon: MEDIA[d.kind].icon, hint: MEDIA[d.kind].formats };
  return b;
}
// Cor da linha pela saída: falha/erro em vermelho, desvios em âmbar, o resto no tom da marca.
export function edgeTone(exit) {
  if (['failed', 'error'].includes(exit)) return 'danger';
  if (['window_closed', 'timeout', 'other', 'missing', 'no', 'expiration'].includes(exit)) return 'warn';
  return 'ok';
}
// Moeda → métodos do bloco Cobrança (espelha o servidor).
export const PAYMENT_METHODS = {
  BRL: [['PIX', 'Pix']], MXN: [['SPEI', 'SPEI (transferência)'], ['OXXO', 'OXXO (dinheiro na loja)']], COP: [['NEQUI', 'Nequi'], ['BREB', 'Bre-B']],
  ARS: [['BANK_TRANSFER', 'Transferência (CVU)']], CLP: [['BANK_TRANSFER', 'Transferência'], ['CARD', 'Cartão'], ['WALLET', 'Carteira']],
};
export const CURRENCY_LABEL = { BRL: 'Brasil — Real (BRL)', MXN: 'México — Peso (MXN)', COP: 'Colômbia — Peso (COP)', ARS: 'Argentina — Peso (ARS)', CLP: 'Chile — Peso (CLP)' };
export const TONES = {
  accent: 'var(--accent)', green: 'var(--green-500)', amber: 'var(--amber-500)', blue: '#4C8DFF', purple: '#ffb485', neutral: 'var(--ink-400)',
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

// fluxo novo criado pela tela Fluxos: só o Gatilho (onde a última ligação acaba, o fluxo termina)
export function starterGraph() {
  return emptyGraph();
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
    if (target) edges.push({ id: `${n.ref}:${exit}`, source: n.ref, sourceHandle: exit, target, type: 'kobly' });
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
    case 'send_media': return d.url ? (d.filename || decodeURIComponent(d.url.split('/').pop() || '')) + (d.caption ? ` · ${d.caption}` : '') : 'Envie um arquivo ou cole um link';
    case 'send_buttons': return d.text || '';
    case 'send_email': { const e = (lookups.emails || []).find((x) => x.id === d.email_id); return e ? (e.assunto || e.titulo || 'E-mail') : 'Crie o e-mail deste bloco'; }
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
    case 'payment': {
      const m = (PAYMENT_METHODS[d.currency] || []).find(([k]) => k === d.method);
      return `${d.currency || '?'} · ${m ? m[1] : d.method || '?'} · ${d.open_amount ? 'valor livre' : d.amount || '?'}`;
    }
    case 'record_sale': return d.amount ? `Valor ${d.amount}` : 'Valor pago na cobrança';
    case 'ai_agent': return d.agent_id ? `Agente: ${(lookups.agents || []).find((a) => a.id === d.agent_id)?.name || 'salvo'}` : (d.objective || '');
    case 'split': return (d.variants || []).map((v) => `${v.id.toUpperCase()} ${v.weight}%`).join(' · ');
    case 'checkpoint': return d.name || '';
    case 'wait_until': {
      if (d.mode === 'datetime') return `Até ${d.at || '?'}`;
      const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
      return `${(d.days || []).map((x) => DIAS[x]).join(', ')} · ${d.from || '?'}–${d.to || '?'}`;
    }
    case 'notify': return d.text || '';
    case 'pixel': return `${d.event || 'Purchase'} → ${(lookups.pixels || []).find((p) => p.id === d.pixel_config_id)?.label || 'escolha o Pixel'}`;
    default: return '';
  }
}
