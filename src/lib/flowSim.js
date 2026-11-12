// Simulador do fluxo (botão Conferir do editor): roda o grafo bloco a bloco com um contato de teste, no visual do
// WhatsApp. Nada é enviado e nenhuma conexão é usada. Variáveis e condições usam o MESMO código do servidor
// (server/src/flows/vars.js), então "Sim/Não" sai igual ao que acontece de verdade. O que depende de fora
// (IA, pagamento, ligação) vira uma escolha na tela; etiquetas, pixel, webhook e alertas aparecem como aviso.
import { render, evalCondition, applySetVar, buildFields } from '../../server/src/flows/vars.js';

export const TEST_LEAD = { nome: 'Maria', sobrenome: 'Silva', telefone: '5511999990000', email: 'maria.silva@exemplo.com', produto: 'Produto de teste', valor_compra: 97 };
const MAX_STEPS = 300;
const nrm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const fmtSecs = (s) => (s >= 3600 ? `${Math.round(s / 360) / 10} h` : s >= 60 ? `${Math.round(s / 6) / 10} min` : `${Math.round(s)}s`);

// estado novo do teste
export function startSim(graph, { lookups = {}, now = () => new Date(), tz } = {}) {
  const byRef = new Map((graph.nodes || []).map((n) => [n.ref, n]));
  const start = byRef.get(graph.start) || (graph.nodes || []).find((n) => n.type === 'trigger');
  const trig = start && start.type === 'trigger' ? (start.data || {}) : {};
  const st = {
    byRef, lookups, now, tz, log: [], vars: {}, tags: new Set(), comprou: false, steps: 0, done: false, wait: null, cur: start ? start.ref : null, path: [],
    lead: { ...TEST_LEAD }, evento: { tipo: '', valor: 97, produto: TEST_LEAD.produto },
  };
  if (!start) { push(st, { kind: 'sys', tone: 'warn', text: 'O fluxo não tem Gatilho.' }); st.done = true; return st; }
  // começo: mensagem do contato (gatilho por mensagem) ou evento do checkout
  if (trig.source === 'message') {
    const kw = (trig.keywords || []).filter(Boolean);
    const first = trig.mode === 'keywords' && kw.length ? kw[0] : 'Oi';
    push(st, { kind: 'in', text: first });
    st.vars.ultima_mensagem = first; st.vars.resposta = first;
    push(st, { kind: 'sys', icon: 'zap', text: trig.mode === 'keywords' && kw.length ? `Gatilho: mensagem com "${first}"` : 'Gatilho: qualquer mensagem' });
  } else {
    const ev = (trig.events || [])[0] || 'Pix Gerado';
    st.evento.tipo = ev;
    push(st, { kind: 'sys', icon: 'zap', text: `Gatilho: evento do checkout "${ev}" (simulado)` });
  }
  advance(st, start, 'default');
  return run(st);
}

function push(st, item) { st.log.push({ id: st.log.length + 1, at: st.now(), ...item }); }
function ctxOf(st) { return { lead: st.lead, evento: st.evento, vars: st.vars, tags: st.tags, comprou: st.comprou, janelaAberta: true, agora: st.now(), tz: st.tz }; }
const txt = (st, s) => render(String(s ?? ''), ctxOf(st));

// segue a saída; sem ligação → fim
function advance(st, node, exit) {
  const to = node.next && node.next[exit];
  if (to && st.byRef.has(to)) { st.cur = to; return; }
  st.cur = null; st.done = true;
  const label = { default: 'Próximo', sent: 'Enviado', yes: 'Sim', no: 'Não', timeout: 'Sem resposta', other: 'Outra resposta', reply: 'Respondeu', error: 'Erro' }[exit] || exit;
  push(st, { kind: 'sys', icon: 'flag', text: node.type === 'end' ? 'Fim do fluxo' : `Fim do fluxo (a saída "${label}" de ${node.ref} não está ligada)` });
}

function choice(st, node, text, options) {
  st.wait = { kind: 'choose', ref: node.ref, text, options };
  push(st, { kind: 'sys', icon: 'hand', tone: 'ask', text });
}

// roda até o próximo ponto que precisa do contato (ou do teste)
export function run(st) {
  while (!st.done && !st.wait && st.cur) {
    if (++st.steps > MAX_STEPS) { push(st, { kind: 'sys', tone: 'warn', text: 'Parei o teste: muitos blocos seguidos sem esperar o contato (pode ter um laço).' }); st.done = true; break; }
    const node = st.byRef.get(st.cur);
    st.path.push(node.ref);
    const d = node.data || {};
    switch (node.type) {
      case 'trigger': advance(st, node, 'default'); break;
      case 'send_text': push(st, { kind: 'out', ref: node.ref, text: txt(st, d.text) }); advance(st, node, 'sent'); break;
      case 'send_template': {
        const t = (st.lookups.templates || []).find((x) => x.id === d.template_id);
        // corpo do modelo com {{1}}, {{2}}… trocados pelas variáveis escolhidas no bloco
        const body = t && t.body_text ? String(t.body_text).replace(/\{\{(\d+)\}\}/g, (_, i) => txt(st, `{{${(d.vars || [])[Number(i) - 1] || ''}}}`)) : '';
        push(st, { kind: 'out', ref: node.ref, text: t ? (body || `📄 Modelo "${t.name || t.nome}"`) : '📄 Modelo do WhatsApp (nenhum escolhido)', template: true });
        advance(st, node, 'sent'); break;
      }
      case 'send_media':
        push(st, { kind: 'media', ref: node.ref, media: d.kind || 'image', url: d.url || '', caption: txt(st, d.caption), name: d.filename || d.file_name || decodeURIComponent(String(d.url || '').split(/[?#]/)[0].split('/').pop() || ''), ptt: !!d.ptt });
        advance(st, node, 'sent'); break;
      case 'send_buttons':
        push(st, { kind: 'out', ref: node.ref, text: txt(st, d.text), buttons: (d.options || []).map((o) => o.title || o.id) });
        st.wait = { kind: 'buttons', ref: node.ref, options: (d.options || []).map((o) => ({ id: o.id, label: o.title || o.id })), timeout: d.timeout_minutes };
        break;
      case 'send_email': {
        const e = (st.lookups.emails || []).find((x) => x.id === d.email_id);
        push(st, { kind: 'sys', icon: 'mail', text: `E-mail${e ? ` "${e.assunto || e.titulo}"` : ''} para ${st.lead.email} (não enviado no teste)` });
        advance(st, node, 'default'); break;
      }
      case 'delay': {
        const a = Number(d.min_seconds) || 0, b = Math.max(a, Number(d.max_seconds) || a);
        push(st, { kind: 'sys', icon: 'clock', text: `Aguardando ${a === b ? fmtSecs(a) : `${fmtSecs(a)} a ${fmtSecs(b)}`}${d.typing ? ' · digitando…' : '…'}`, pause: Math.min(1400, 350 + Math.min(b, 30) * 60) });
        advance(st, node, 'default'); break;
      }
      case 'wait_reply':
        st.wait = { kind: 'reply', ref: node.ref, save_as: d.save_as || 'resposta', timeout: d.timeout_minutes };
        push(st, { kind: 'sys', icon: 'keyboard', text: `Aguardando resposta do contato… (→ ${d.save_as || 'resposta'})` });
        break;
      case 'condition': {
        const ok = evalCondition(d, ctxOf(st));
        push(st, { kind: 'sys', icon: 'git-branch', text: `Condição avaliada → ${ok ? 'Sim' : 'Não'}`, detail: (d.rules || []).map((r) => ruleText(st, r)).join(d.match === 'any' ? ' OU ' : ' E ') });
        advance(st, node, ok ? 'yes' : 'no'); break;
      }
      case 'ai_classify': {
        const outs = (d.outputs || []).map((o) => ({ id: `out_${o.key}`, label: o.key, hint: o.description }));
        choice(st, node, `IA: entender resposta — o que a IA entenderia de "${txt(st, d.input || '{{ultima_mensagem}}').slice(0, 80)}"?`, [...outs, { id: 'other', label: 'Nenhuma' }, { id: 'error', label: 'Erro' }]);
        break;
      }
      case 'ai_extract':
        choice(st, node, `IA: extrair ${(d.fields || []).map((f) => f.name).join(', ')} — como o teste segue?`, [{ id: 'ok', label: 'Extraiu' }, { id: 'missing', label: 'Faltou dado' }, { id: 'error', label: 'Erro' }]);
        break;
      case 'ai_agent':
        push(st, { kind: 'out', ref: node.ref, ai: true, text: '🤖 [Resposta da IA simulada] — No WhatsApp de verdade, o Agente de IA responderia aqui.' });
        st.wait = { kind: 'agent', ref: node.ref };
        push(st, { kind: 'sys', icon: 'bot', tone: 'ask', text: 'Converse com o agente ou escolha como a conversa termina.' });
        break;
      case 'payment': {
        const val = txt(st, d.amount || '') || (d.open_amount ? 'valor livre' : '');
        push(st, { kind: 'sys', icon: 'credit-card', text: `Cobrança gerada (simulada): ${d.method || 'PIX'} ${d.currency || 'BRL'} ${val}`.trim() });
        st.vars.pagamento_codigo = '00020126...PIX-DE-TESTE'; st.vars.pagamento_link = 'https://exemplo.com/pagar';
        choice(st, node, 'O contato paga?', [{ id: 'payment_approved', label: 'Pagou' }, { id: 'charge_created', label: 'Ainda não pagou' }, { id: 'error', label: 'Erro no gateway' }]);
        break;
      }
      case 'record_sale': st.comprou = true; push(st, { kind: 'sys', icon: 'receipt', text: 'Venda registrada (simulada)' }); advance(st, node, 'default'); break;
      case 'pixel': {
        const p = (st.lookups.pixels || []).find((x) => x.id === d.pixel_config_id);
        push(st, { kind: 'sys', icon: 'target', tone: p ? 'note' : 'warn', text: p ? `Pixel "${p.label || p.nome || 'Meta'}": ${d.event} seria enviado (não enviado no teste)` : 'Pixel sem escolha: bloco pulado' });
        advance(st, node, 'default'); break;
      }
      case 'split': {
        const vs = d.variants || [];
        let r = Math.random() * vs.reduce((s, v) => s + (Number(v.weight) || 0), 0), pick = vs[0];
        for (const v of vs) { r -= Number(v.weight) || 0; if (r <= 0) { pick = v; break; } }
        push(st, { kind: 'sys', icon: 'split', text: `Teste A/B: caiu no caminho ${String(pick ? pick.id : '?').toUpperCase()}` });
        if (pick) advance(st, node, `var_${pick.id}`); else advance(st, node, 'default');
        break;
      }
      case 'checkpoint': push(st, { kind: 'sys', icon: 'flag-triangle-right', text: `Contador: ${d.name}` }); advance(st, node, 'default'); break;
      case 'wait_until': push(st, { kind: 'sys', icon: 'calendar-clock', text: d.mode === 'business_hours' ? `Esperaria o horário comercial (${d.from}–${d.to}) — pulado no teste` : `Esperaria até ${d.at} — pulado no teste` }); advance(st, node, 'default'); break;
      case 'notify': {
        const c = (st.lookups.channels || []).find((x) => x.id === d.channel_id);
        push(st, { kind: 'sys', icon: 'bell', tone: c ? 'note' : 'warn', text: c ? `Alerta para a equipe: "${txt(st, d.text).slice(0, 120)}" (não enviado no teste)` : 'Alerta sem canal: bloco pulado' });
        advance(st, node, 'default'); break;
      }
      case 'tag': {
        const nameOf = (id) => ((st.lookups.tags || []).find((t) => t.id === id) || {}).nome || 'etiqueta';
        for (const t of d.add || []) st.tags.add(t);
        for (const t of d.remove || []) st.tags.delete(t);
        const parts = [...(d.add || []).map((t) => `+ ${nameOf(t)}`), ...(d.remove || []).map((t) => `− ${nameOf(t)}`)];
        push(st, { kind: 'sys', icon: 'tag', tone: 'note', text: parts.length ? `Etiquetas: ${parts.join(', ')}` : 'Etiquetas: nada a mudar' });
        advance(st, node, 'default'); break;
      }
      case 'set_var': st.vars[d.name] = applySetVar(d, ctxOf(st)); push(st, { kind: 'sys', icon: 'pencil', text: `${d.name} = ${String(st.vars[d.name]).slice(0, 60)}` }); advance(st, node, 'default'); break;
      case 'goto_flow': {
        const f = (st.lookups.flows || []).find((x) => x.id === d.campaign_id || x.campaign_id === d.campaign_id);
        push(st, { kind: 'sys', icon: 'git-merge', text: `Iria para o fluxo "${f ? f.nome : 'não escolhido'}"` }); st.cur = null; st.done = true; break;
      }
      case 'webhook':
        push(st, { kind: 'sys', icon: 'webhook', tone: 'note', text: `Webhook ${d.method || 'POST'} ${d.url || '(sem endereço)'} — não chamado no teste` });
        choice(st, node, 'Como o webhook responde?', [{ id: 'success', label: 'Sucesso' }, { id: 'error', label: 'Erro' }]);
        break;
      case 'call': {
        const outs = d.mode === 'agent' ? (d.outcomes || []).map((o) => ({ id: `out_${o.key}`, label: o.label || o.key })) : [];
        push(st, { kind: 'sys', icon: 'phone-call', text: d.mode === 'agent' ? 'Ligação com agente de voz (simulada)' : 'Ligação: só tocar (simulada)' });
        choice(st, node, 'O que acontece na ligação?', [...outs, { id: 'answered', label: 'Atendeu' }, { id: 'no_answer', label: 'Não atendeu' }, { id: 'rejected', label: 'Recusou' }]);
        break;
      }
      case 'end': advance(st, node, '__end'); break;
      default: push(st, { kind: 'sys', tone: 'warn', text: `Bloco "${node.type}" não é simulado; seguindo.` }); advance(st, node, 'default');
    }
  }
  return st;
}

function ruleText(st, r) {
  switch (r.kind) {
    case 'var': return `${r.name} ${r.op} "${txt(st, r.value)}" (atual: "${String(buildFields(ctxOf(st))[r.name] ?? '∅').slice(0, 40) || '∅'}")`;
    case 'tag': return `${r.op === 'not_has' ? 'não tem' : 'tem'} etiqueta ${((st.lookups.tags || []).find((t) => t.id === r.tag_id) || {}).nome || ''}`;
    case 'purchased': return 'comprou';
    case 'window_open': return 'janela 24 h aberta';
    default: return r.kind;
  }
}

// o contato escreveu
export function reply(st, text) {
  const t = String(text || '').trim();
  if (!t || !st.wait) return st;
  push(st, { kind: 'in', text: t });
  st.vars.ultima_mensagem = t;
  const w = st.wait; const node = st.byRef.get(w.ref); st.wait = null;
  if (w.kind === 'reply') { st.vars[w.save_as] = t; advance(st, node, 'reply'); }
  else if (w.kind === 'buttons') {
    const o = w.options.find((x) => nrm(x.label) === nrm(t) || nrm(x.id) === nrm(t));
    st.vars.resposta = t;
    advance(st, node, o ? `opt_${o.id}` : 'other');
  } else if (w.kind === 'agent') {
    push(st, { kind: 'out', ref: node.ref, ai: true, text: '🤖 [Resposta da IA simulada]' });
    st.wait = w; push(st, { kind: 'sys', icon: 'bot', tone: 'ask', text: 'Continue conversando ou escolha como termina.' });
    return st;
  } else { st.wait = w; return st; } // escolha: precisa clicar
  return run(st);
}

// escolha na tela (IA, pagamento, sem resposta…)
export function choose(st, exit) {
  const w = st.wait; if (!w) return st;
  const node = st.byRef.get(w.ref); st.wait = null;
  if (exit === 'payment_approved') st.comprou = true;
  const label = (w.options || []).find((o) => o.id === exit)?.label || { timeout: 'Sem resposta', done: 'Concluiu', handoff: 'Pediu humano', expiration: 'Sem resposta', error: 'Erro' }[exit] || exit;
  push(st, { kind: 'sys', icon: 'check', text: `Escolhido: ${label}` });
  advance(st, node, exit);
  return run(st);
}

// variáveis que o contato tem agora (para o painel "Variáveis do contato")
export function simVars(st) {
  const f = buildFields(ctxOf(st));
  return Object.entries(f).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}
