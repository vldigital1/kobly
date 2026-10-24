// Fluxo em grafo: blocos ligados por saídas nomeadas.
// Formato salvo (flow_graph_versions.graph):
//   { version: 1, start: 'inicio', nodes: [ { ref, type, data, next: { <saida>: <ref> } } ] }
// Este módulo é puro (sem banco): descreve os tipos de bloco e valida um grafo antes de salvar.

export const MAX_NODES = 300;
export const MAX_WAIT_MINUTES = 30 * 24 * 60; // 30 dias
export const TIPOS_EVENTO = ['Abandono de carrinho', 'Boleto Gerado', 'Compra cancelada', 'Depósito Solicitado', 'Pix Gerado',
  'Chargeback', 'Cancelamento de Assinatura', 'Compra Reembolsada', 'Compra Aprovada', 'Compra Recusada'];
export const EVENTOS_RECUPERACAO = new Set(['Abandono de carrinho', 'Boleto Gerado', 'Depósito Solicitado', 'Pix Gerado', 'Compra Recusada']);

const VAR_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// exits: saídas que o bloco pode ter. required: saídas que precisam estar ligadas.
// Blocos com saídas DINÂMICAS (botões, IA) calculam as saídas a partir dos dados: ver exitsOf().
export const NODE_TYPES = {
  trigger: { label: 'Gatilho', exits: ['default'], required: ['default'] },
  send_template: { label: 'Modelo do WhatsApp', exits: ['sent', 'failed'], required: ['sent'] },
  send_text: { label: 'Mensagem de texto', exits: ['sent', 'failed', 'window_closed'], required: ['sent'] },
  send_media: { label: 'Mídia', exits: ['sent', 'failed', 'window_closed'], required: ['sent'] },
  send_buttons: { label: 'Botões / lista', exits: ['other', 'timeout', 'failed'], dynamic: (d) => (d.options || []).map((o) => `opt_${o.id}`), required: [] },
  delay: { label: 'Esperar', exits: ['default'], required: ['default'] },
  wait_reply: { label: 'Aguardar resposta', exits: ['reply', 'timeout'], required: ['reply'] },
  condition: { label: 'Condição', exits: ['yes', 'no'], required: [] },
  ai_classify: { label: 'IA: entender resposta', exits: ['other', 'error'], dynamic: (d) => (d.outputs || []).map((o) => `out_${o.key}`), required: [] },
  ai_extract: { label: 'IA: extrair dados', exits: ['ok', 'missing', 'error'], required: ['ok'] },
  payment: { label: 'Cobrança', exits: ['charge_created', 'payment_approved', 'error'], required: ['charge_created'] },
  record_sale: { label: 'Registrar venda', exits: ['default'], required: [] },
  pixel: { label: 'Pixel da Meta', exits: ['default'], required: [] },
  tag: { label: 'Etiquetas', exits: ['default'], required: [] },
  set_var: { label: 'Definir variável', exits: ['default'], required: [] },
  end: { label: 'Fim', exits: [], required: [] },
};
export const exitsOf = (node) => {
  const spec = NODE_TYPES[node && node.type];
  if (!spec) return [];
  const d = (node && node.data) || {};
  return [...(spec.dynamic ? spec.dynamic(d) : []), ...spec.exits];
};
export const MEDIA_KINDS = ['image', 'audio', 'video', 'document'];
// Moeda → métodos do bloco de cobrança (espelha payments/xpag.js; o graph.js fica sem dependências).
export const PAYMENT_METHODS = { BRL: ['PIX'], MXN: ['SPEI', 'OXXO'], COP: ['NEQUI', 'BREB'], ARS: ['BANK_TRANSFER'], CLP: ['BANK_TRANSFER', 'CARD', 'WALLET'] };
const KEY = /^[a-z0-9_]{1,20}$/;

export const CONDITION_KINDS = {
  tag: ['has', 'not_has'],
  var: ['eq', 'neq', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'],
  purchased: [],
  window_open: [],
  weekday: [],
  time_between: [],
  country: [],
};

// Faixa da espera em segundos [mín, máx] (aceita segundos ou o formato antigo em minutos).
export function delaySecondsRange(d) {
  if (Number.isFinite(d.seconds)) return [d.seconds, d.seconds];
  if (Number.isFinite(d.min_seconds) && Number.isFinite(d.max_seconds)) return [d.min_seconds, d.max_seconds];
  if (Number.isFinite(d.minutes)) return [d.minutes * 60, d.minutes * 60];
  if (Number.isFinite(d.min_minutes) && Number.isFinite(d.max_minutes)) return [d.min_minutes * 60, d.max_minutes * 60];
  return [0, 0];
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 4096) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function checkData(node, err) {
  const d = isObj(node.data) ? node.data : {};
  const at = `bloco "${node.ref}"`;
  switch (node.type) {
    case 'trigger':
      if (!Array.isArray(d.events) || !d.events.length) err(`${at}: escolha ao menos um evento de checkout.`);
      else for (const e of d.events) if (!TIPOS_EVENTO.includes(e)) err(`${at}: evento desconhecido "${e}".`);
      break;
    case 'send_template':
      if (!str(d.template_id, 64)) err(`${at}: escolha um modelo aprovado do WhatsApp.`);
      if (d.vars !== undefined && !Array.isArray(d.vars)) err(`${at}: variáveis do modelo devem ser uma lista.`);
      break;
    case 'send_text':
      if (!str(d.text, 4096)) err(`${at}: escreva a mensagem (até 4096 caracteres).`);
      if (d.fallback_template_id !== undefined && d.fallback_template_id !== null && !str(d.fallback_template_id, 64)) err(`${at}: modelo reserva inválido.`);
      break;
    case 'delay': {
      // segundos (fixo ou faixa aleatória) ou, no formato antigo, minutos
      const fixed = Number.isFinite(d.seconds) || Number.isFinite(d.minutes);
      const range = (Number.isFinite(d.min_seconds) && Number.isFinite(d.max_seconds)) || (Number.isFinite(d.min_minutes) && Number.isFinite(d.max_minutes));
      if (!fixed && !range) { err(`${at}: informe o tempo de espera.`); break; }
      const s = delaySecondsRange(d);
      if (s.some((x) => x < 0 || x > MAX_WAIT_MINUTES * 60)) err(`${at}: espera deve ficar entre 0 e 30 dias.`);
      if (s[0] > s[1]) err(`${at}: o mínimo não pode passar do máximo.`);
      break;
    }
    case 'send_media':
      if (!MEDIA_KINDS.includes(d.kind)) err(`${at}: escolha o tipo de mídia (imagem, áudio, vídeo ou documento).`);
      // link https fixo ou uma variável (ex.: {{pagamento_qr}} gerado pelo bloco de cobrança)
      if (!(typeof d.url === 'string' && d.url.length <= 2048 && (/^https:\/\/[^\s]+$/i.test(d.url.trim()) || /^\{\{\s*[a-z_][a-z0-9_.]*\s*\}\}$/i.test(d.url.trim())))) err(`${at}: a mídia precisa de um link público https (ou uma variável como {{pagamento_qr}}).`);
      if (d.caption !== undefined && d.caption !== null && (typeof d.caption !== 'string' || d.caption.length > 1024)) err(`${at}: legenda até 1024 caracteres.`);
      if (d.kind === 'audio' && d.caption) err(`${at}: o WhatsApp não aceita legenda em áudio.`);
      break;
    case 'send_buttons': {
      if (!str(d.text, 1024)) err(`${at}: escreva a pergunta (até 1024 caracteres).`);
      const opts = Array.isArray(d.options) ? d.options : [];
      if (opts.length < 1 || opts.length > 10) err(`${at}: use de 1 a 10 opções.`);
      const max = opts.length <= 3 ? 20 : 24; // limite da Meta: botão 20, item de lista 24
      const ids = new Set();
      for (const o of opts) {
        if (!isObj(o) || !KEY.test(String(o.id || ''))) { err(`${at}: cada opção precisa de um id (minúsculas, números e _).`); continue; }
        if (ids.has(o.id)) err(`${at}: opção repetida "${o.id}".`); ids.add(o.id);
        if (!str(o.title, max)) err(`${at}: o texto da opção "${o.id}" deve ter até ${max} caracteres.`);
      }
      if (d.save_as !== undefined && !VAR_NAME.test(String(d.save_as))) err(`${at}: nome da variável inválido.`);
      if (d.timeout_minutes !== undefined && d.timeout_minutes !== null && !(Number.isFinite(d.timeout_minutes) && d.timeout_minutes > 0 && d.timeout_minutes <= MAX_WAIT_MINUTES)) err(`${at}: prazo deve ficar entre 1 minuto e 30 dias.`);
      break;
    }
    case 'ai_classify': {
      const outs = Array.isArray(d.outputs) ? d.outputs : [];
      if (outs.length < 2 || outs.length > 8) err(`${at}: use de 2 a 8 saídas.`);
      const keys = new Set();
      for (const o of outs) {
        if (!isObj(o) || !KEY.test(String(o.key || ''))) { err(`${at}: cada saída precisa de uma chave (minúsculas, números e _).`); continue; }
        if (keys.has(o.key)) err(`${at}: saída repetida "${o.key}".`); keys.add(o.key);
        if (!str(o.description, 500)) err(`${at}: explique quando usar a saída "${o.key}".`);
      }
      if (d.instructions !== undefined && d.instructions !== null && (typeof d.instructions !== 'string' || d.instructions.length > 2000)) err(`${at}: instruções até 2000 caracteres.`);
      break;
    }
    case 'payment': {
      if (!str(d.integration_id, 64)) err(`${at}: escolha a conta do gateway (Integrações → Pagamentos).`);
      const methods = PAYMENT_METHODS[d.currency];
      if (!methods) err(`${at}: moeda não suportada (${Object.keys(PAYMENT_METHODS).join(', ')}).`);
      else if (!methods.includes(d.method)) err(`${at}: para ${d.currency} use ${methods.join(' ou ')}.`);
      const aberto = !!d.open_amount;
      if (aberto && !(d.currency === 'BRL' || (d.currency === 'MXN' && d.method === 'SPEI'))) err(`${at}: valor livre só existe para Pix (BRL) e SPEI (MXN).`);
      if (!aberto && !(str(String(d.amount ?? ''), 64))) err(`${at}: informe o valor (número ou variável, ex.: {{valor_oferta}}).`);
      if (!aberto && /^[\d.,\s]+$/.test(String(d.amount ?? '')) && !(Number(String(d.amount).replace(',', '.')) > 0)) err(`${at}: valor deve ser maior que zero.`);
      if (d.currency === 'MXN' && d.method === 'OXXO' && /^[\d.,]+$/.test(String(d.amount ?? '')) && !(Number(String(d.amount).replace(',', '.')) >= 10 && Number(String(d.amount).replace(',', '.')) <= 10000)) err(`${at}: OXXO aceita de 10 a 10.000 MXN.`);
      if (d.save_as !== undefined && !VAR_NAME.test(String(d.save_as))) err(`${at}: prefixo das variáveis inválido.`);
      if (d.listen_hours !== undefined && !(Number.isFinite(d.listen_hours) && d.listen_hours >= 1 && d.listen_hours <= 168)) err(`${at}: escuta do pagamento entre 1 e 168 horas.`);
      break;
    }
    case 'record_sale':
      if (d.amount !== undefined && d.amount !== null && typeof d.amount !== 'string' && typeof d.amount !== 'number') err(`${at}: valor inválido.`);
      break;
    case 'pixel':
      if (!str(d.pixel_config_id, 64)) err(`${at}: escolha o Pixel (Integrações → Pixel da Meta).`);
      if (!['Purchase', 'Lead', 'InitiateCheckout', 'AddPaymentInfo'].includes(d.event)) err(`${at}: evento inválido.`);
      break;
    case 'ai_extract': {
      const fs = Array.isArray(d.fields) ? d.fields : [];
      if (fs.length < 1 || fs.length > 8) err(`${at}: extraia de 1 a 8 campos.`);
      for (const f of fs) {
        if (!isObj(f) || !VAR_NAME.test(String(f.name || ''))) { err(`${at}: nome de campo inválido (minúsculas, números e _).`); continue; }
        if (!str(f.description, 300)) err(`${at}: descreva o campo "${f.name}".`);
      }
      break;
    }
    case 'wait_reply':
      if (d.save_as !== undefined && !VAR_NAME.test(String(d.save_as))) err(`${at}: nome da variável inválido (minúsculas, números e _).`);
      if (d.timeout_minutes !== undefined && d.timeout_minutes !== null && !(Number.isFinite(d.timeout_minutes) && d.timeout_minutes > 0 && d.timeout_minutes <= MAX_WAIT_MINUTES)) err(`${at}: prazo deve ficar entre 1 minuto e 30 dias.`);
      break;
    case 'condition': {
      if (d.match !== undefined && !['all', 'any'].includes(d.match)) err(`${at}: combine as regras com "all" (E) ou "any" (OU).`);
      if (!Array.isArray(d.rules) || !d.rules.length) { err(`${at}: adicione ao menos uma regra.`); break; }
      for (const r of d.rules) {
        if (!isObj(r) || !(r.kind in CONDITION_KINDS)) { err(`${at}: regra de tipo desconhecido.`); continue; }
        const ops = CONDITION_KINDS[r.kind];
        if (ops.length && !ops.includes(r.op)) err(`${at}: operador "${r.op}" não vale para regra "${r.kind}".`);
        if (r.kind === 'tag' && !str(r.tag_id, 64)) err(`${at}: escolha a etiqueta da regra.`);
        if (r.kind === 'var' && !VAR_NAME.test(String(r.name || ''))) err(`${at}: nome de variável inválido na regra.`);
        if (r.kind === 'weekday' && !(Array.isArray(r.days) && r.days.length && r.days.every((x) => Number.isInteger(x) && x >= 0 && x <= 6))) err(`${at}: dias da semana devem ser de 0 (domingo) a 6 (sábado).`);
        if (r.kind === 'time_between' && !(HHMM.test(String(r.from)) && HHMM.test(String(r.to)))) err(`${at}: horário no formato HH:MM.`);
        if (r.kind === 'country' && !(Array.isArray(r.ddi) && r.ddi.length && r.ddi.every((x) => /^\d{1,4}$/.test(String(x))))) err(`${at}: informe o DDI dos países (ex.: 52).`);
      }
      break;
    }
    case 'tag': {
      const add = d.add ?? [], remove = d.remove ?? [];
      if (!Array.isArray(add) || !Array.isArray(remove) || (!add.length && !remove.length)) err(`${at}: escolha etiquetas para adicionar ou remover.`);
      break;
    }
    case 'set_var':
      if (!VAR_NAME.test(String(d.name || ''))) err(`${at}: nome da variável inválido (minúsculas, números e _).`);
      if (d.op !== undefined && !['set', 'add', 'subtract', 'multiply', 'divide'].includes(d.op)) err(`${at}: operação inválida.`);
      if (typeof d.value !== 'string' && typeof d.value !== 'number') err(`${at}: informe o valor.`);
      break;
    default: break;
  }
}

// Valida um grafo. Erros impedem salvar; avisos só informam (ex.: bloco que ninguém alcança).
export function validateGraph(graph) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  if (!isObj(graph)) return { ok: false, errors: ['Fluxo inválido.'], warnings };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : null;
  if (!nodes || !nodes.length) return { ok: false, errors: ['O fluxo não tem blocos.'], warnings };
  if (nodes.length > MAX_NODES) err(`O fluxo passou de ${MAX_NODES} blocos.`);

  const byRef = new Map();
  for (const n of nodes) {
    if (!isObj(n) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(n.ref || ''))) { err('Bloco sem identificador válido (letras, números, _ e -).'); continue; }
    if (byRef.has(n.ref)) err(`Identificador repetido: "${n.ref}".`);
    byRef.set(n.ref, n);
    if (!(n.type in NODE_TYPES)) { err(`bloco "${n.ref}": tipo desconhecido "${n.type}".`); continue; }
    checkData(n, err);
    const spec = NODE_TYPES[n.type];
    const next = isObj(n.next) ? n.next : {};
    const exits = exitsOf(n);
    for (const [exit, target] of Object.entries(next)) {
      if (!exits.includes(exit)) err(`bloco "${n.ref}": saída "${exit}" não existe em ${spec.label}.`);
      else if (target !== null && target !== undefined && !byRef.has(target) && !nodes.some((m) => m && m.ref === target)) err(`bloco "${n.ref}": a saída "${exit}" aponta para "${target}", que não existe.`);
      if (target === n.ref) err(`bloco "${n.ref}": a saída "${exit}" aponta para ele mesmo.`);
    }
    for (const r of spec.required) if (!next[r]) err(`bloco "${n.ref}": ligue a saída "${r}".`);
  }

  const start = byRef.get(graph.start);
  if (!start) err('Defina o bloco inicial do fluxo.');
  else if (start.type !== 'trigger') err('O fluxo precisa começar por um Gatilho.');
  if (nodes.filter((n) => n && n.type === 'trigger').length > 1) err('Use só um Gatilho por fluxo.');

  // Alcance a partir do início + ciclos sem espera (loop infinito instantâneo).
  if (start) {
    const seen = new Set(); const stack = [start.ref];
    while (stack.length) { const r = stack.pop(); if (seen.has(r)) continue; seen.add(r); const n = byRef.get(r); if (n && isObj(n.next)) for (const t of Object.values(n.next)) if (t) stack.push(t); }
    for (const n of nodes) if (n && n.ref && !seen.has(n.ref)) warn(`O bloco "${n.ref}" não é alcançado a partir do início.`);
    const PAUSA = new Set(['delay', 'wait_reply', 'send_buttons']);
    const color = new Map();
    const dfs = (r) => {
      color.set(r, 1);
      const n = byRef.get(r);
      if (n && !PAUSA.has(n.type) && isObj(n.next)) for (const t of Object.values(n.next)) {
        if (!t || !byRef.has(t)) continue;
        if (color.get(t) === 1) { err(`Laço sem espera passando por "${t}": coloque um Esperar ou Aguardar resposta no caminho.`); continue; }
        if (!color.get(t)) dfs(t);
      }
      color.set(r, 2);
    };
    for (const r of seen) if (!color.get(r)) dfs(r);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings };
}

export const nodeOf = (graph, ref) => (graph && Array.isArray(graph.nodes) ? graph.nodes.find((n) => n.ref === ref) : null) || null;
export const nextOf = (node, exit) => (node && node.next && node.next[exit]) || null;
