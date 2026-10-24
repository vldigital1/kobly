// Copiloto do funil: lê o que aconteceu em cada bloco (trilha das execuções) e aponta onde o fluxo
// perde leads, com sugestões concretas. As regras são determinísticas (números reais, sem "achismo");
// a IA, se configurada, só resume as sugestões em linguagem natural — nunca inventa números.
export const MIN_SAMPLE = 20;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

// byNode: [{ ref, outcome, leads }]  ·  paths: [Set('ref:outcome', ...)] uma por execução
export function analyzeFlow(graph, byNode, paths = []) {
  const out = [];
  const add = (ref, severity, title, detail, action) => out.push({ ref, severity, title, detail, action });
  const stats = new Map();
  for (const r of byNode) {
    const s = stats.get(r.ref) || { total: 0, outcomes: {} };
    s.outcomes[r.outcome] = (s.outcomes[r.outcome] || 0) + r.leads;
    stats.set(r.ref, s);
  }
  // total de leads que "resolveram" o bloco = soma das saídas finais (sem contar estados intermediários).
  // "reply" é saída final do Aguardar resposta, mas só um turno intermediário no Agente de IA.
  const INTERMED = new Set(['waiting', 'waiting_reply', 'retry', 'payment_confirmed']);
  const typeOf = new Map((graph.nodes || []).map((n) => [n.ref, n.type]));
  for (const [ref, s] of stats) s.total = Object.entries(s.outcomes).filter(([o]) => !INTERMED.has(o) && !(o === 'reply' && typeOf.get(ref) === 'ai_agent')).reduce((a, [, n]) => a + n, 0);
  const o = (ref, k) => (stats.get(ref) ? stats.get(ref).outcomes[k] || 0 : 0);

  for (const node of graph.nodes || []) {
    const s = stats.get(node.ref);
    if (!s || s.total < MIN_SAMPLE) continue;
    const t = s.total;
    switch (node.type) {
      case 'wait_reply': case 'send_buttons': {
        const sem = o(node.ref, 'timeout'); const p = pct(sem, t);
        if (p >= 40) add(node.ref, p >= 60 ? 'alta' : 'media', `${p}% não respondem aqui`, `${sem} de ${t} leads ficaram sem responder no prazo.`,
          node.type === 'send_buttons' ? 'Encurte a pergunta, use 2 opções claras e ligue "Sem resposta" a um lembrete (Esperar + Modelo).' : 'Troque a pergunta por botões, mande um áudio curto antes ou ligue "Sem resposta" a um lembrete com modelo aprovado.');
        if (node.type === 'send_buttons') { const outras = o(node.ref, 'other'); if (pct(outras, t) >= 30) add(node.ref, 'media', `${pct(outras, t)}% respondem fora das opções`, `${outras} leads digitaram algo que não bate com os botões.`, 'Ligue "Outra resposta" a uma IA: entender resposta, ou ajuste o texto das opções.'); }
        break;
      }
      case 'ai_agent': {
        const exp = o(node.ref, 'expiration'), hum = o(node.ref, 'handoff'), done = o(node.ref, 'done');
        if (pct(exp, t) >= 40) add(node.ref, 'media', `${pct(exp, t)}% abandonam a conversa com o agente`, `${exp} de ${t} conversas terminaram sem resposta do lead.`, 'Peça para o agente fazer UMA pergunta por mensagem e reforce a oferta na base de conhecimento.');
        if (pct(hum, t) >= 25) add(node.ref, 'media', `${pct(hum, t)}% pedem atendimento humano`, `${hum} conversas foram para "Pediu humano".`, 'Leia essas conversas e acrescente as dúvidas na base de conhecimento; ligue "Pediu humano" a um Alerta.');
        if (done && pct(done, t) >= 50) add(node.ref, 'info', `Agente concluiu ${pct(done, t)}% das conversas`, `${done} de ${t}.`, 'Bom sinal: considere usar o mesmo agente em outras campanhas.');
        break;
      }
      case 'send_text': case 'send_media': case 'send_template': {
        const f = o(node.ref, 'failed'), w = o(node.ref, 'window_closed');
        if (pct(f, t) >= 10) add(node.ref, 'alta', `${pct(f, t)}% dos envios falham`, `${f} de ${t} mensagens não saíram.`, node.type === 'send_template' ? 'Confira se o modelo segue aprovado e a qualidade do número no painel da Meta.' : 'Confira links de mídia (https público) e o estado da conexão do WhatsApp.');
        if (pct(w, t) >= 20) add(node.ref, 'alta', `${pct(w, t)}% chegam com a janela de 24 h fechada`, `${w} leads não puderam receber texto livre.`, 'Defina um "modelo reserva" no bloco: a Kobly troca sozinha para o modelo aprovado quando a janela fecha.');
        break;
      }
      case 'payment': {
        const err = o(node.ref, 'error'), gen = o(node.ref, 'charge_created'), paid = o(node.ref, 'payment_approved');
        if (pct(err, t) >= 10) add(node.ref, 'alta', `${pct(err, t)}% das cobranças dão erro`, `${err} de ${t} tentativas não geraram cobrança.`, 'Veja o motivo na trilha (valor fora do limite, credencial, método). OXXO aceita de 10 a 10.000 MXN.');
        if (gen >= MIN_SAMPLE) {
          const conv = pct(paid, gen);
          if (conv < 25) add(node.ref, conv < 10 ? 'alta' : 'media', `Só ${conv}% das cobranças são pagas`, `${paid} pagas de ${gen} geradas.`,
            'Depois de "Cobrança gerada", espere algumas horas e mande um lembrete; se não pagar, ofereça outro método (ex.: OXXO → SPEI) gerando nova cobrança.');
          if (!node.next || !node.next.payment_approved) add(node.ref, 'alta', 'Pagamentos confirmados não seguem para lugar nenhum', 'A saída "Pago" não está ligada.', 'Ligue "Pago" a Registrar venda + Pixel + entrega do produto.');
        }
        break;
      }
      case 'ai_classify': {
        const none = o(node.ref, 'other'); if (pct(none, t) >= 30) add(node.ref, 'media', `IA não encaixou ${pct(none, t)}% das respostas`, `${none} de ${t} respostas foram para "Nenhuma".`, 'Descreva melhor quando usar cada saída (com exemplos) ou crie uma saída "dúvida".');
        const err = o(node.ref, 'error'); if (pct(err, t) >= 5) add(node.ref, 'alta', `${pct(err, t)}% de erro na IA`, `${err} chamadas falharam.`, 'Confira a chave e os créditos da IA (AI_API_KEY) e ligue "Erro" a um caminho seguro.');
        break;
      }
      default: break;
    }
  }

  // Teste A/B: compara quantos de cada caminho chegam a uma venda (Registrar venda ou pagamento aprovado).
  for (const node of (graph.nodes || []).filter((n) => n.type === 'split')) {
    const res = (node.data.variants || []).map((v) => {
      const mine = paths.filter((p) => p.has(`${node.ref}:var_${v.id}`));
      const sold = mine.filter((p) => [...p].some((x) => /:payment_approved$/.test(x) || (graph.nodes.find((n) => n.ref === x.split(':')[0]) || {}).type === 'record_sale'));
      return { id: v.id, n: mine.length, sold: sold.length, rate: mine.length ? sold.length / mine.length : 0 };
    });
    if (res.every((r) => r.n >= 30)) {
      const best = [...res].sort((a, b) => b.rate - a.rate)[0], worst = [...res].sort((a, b) => a.rate - b.rate)[0];
      if (best.rate > 0 && best.rate >= worst.rate * 1.2) add(node.ref, 'info', `Caminho ${best.id.toUpperCase()} vende mais`, res.map((r) => `${r.id.toUpperCase()}: ${r.sold}/${r.n} (${Math.round(r.rate * 100)}%)`).join(' · '), `Aumente o peso do caminho ${best.id.toUpperCase()} ou crie uma nova variação para competir com ele.`);
      else add(node.ref, 'info', 'Teste A/B ainda empatado', res.map((r) => `${r.id.toUpperCase()}: ${Math.round(r.rate * 100)}%`).join(' · '), 'Deixe rodar mais ou teste uma diferença maior entre os caminhos.');
    } else if (res.some((r) => r.n > 0)) add(node.ref, 'info', 'Teste A/B com poucos leads', res.map((r) => `${r.id.toUpperCase()}: ${r.n}`).join(' · '), 'Espere pelo menos 30 leads por caminho para comparar.');
  }

  // Estrutura (vale mesmo sem dados)
  const types = new Set((graph.nodes || []).map((n) => n.type));
  if (types.has('payment') && !types.has('record_sale')) add(null, 'media', 'Vendas do fluxo não entram no dashboard', 'O fluxo cobra, mas não tem "Registrar venda".', 'Ligue a saída "Pago" a Registrar venda para medir a venda recuperada.');
  if ((types.has('payment') || types.has('record_sale')) && !types.has('pixel')) add(null, 'info', 'A Meta não fica sabendo das vendas', 'Não há bloco Pixel depois da venda.', 'Adicione Pixel (Purchase) depois de Registrar venda para otimizar os anúncios.');
  // Texto livre sem plano B: anda para trás pelos blocos instantâneos; se algum caminho chega ao início
  // ou a uma espera longa sem passar por uma resposta do lead, a janela de 24 h pode estar fechada.
  const preds = new Map();
  for (const p of graph.nodes || []) for (const t of Object.values(p.next || {})) if (t) preds.set(t, [...(preds.get(t) || []), p]);
  const RESPOSTA = new Set(['wait_reply', 'send_buttons', 'ai_agent']);
  const QUEBRA = new Set(['trigger', 'delay', 'wait_until']);
  const semResposta = (ref, seen = new Set()) => {
    if (seen.has(ref)) return false; seen.add(ref);
    const ps = preds.get(ref) || [];
    if (!ps.length) return true;
    return ps.some((p) => (RESPOSTA.has(p.type) ? false : QUEBRA.has(p.type) ? true : semResposta(p.ref, seen)));
  };
  for (const n of (graph.nodes || []).filter((x) => x.type === 'send_text' && !(x.data && x.data.fallback_template_id) && !(x.next && x.next.window_closed))) {
    if (semResposta(n.ref)) add(n.ref, 'media', 'Texto livre sem plano B', 'Este texto pode chegar com a janela de 24 h fechada (há caminho até ele sem uma resposta recente do lead).', 'Escolha um "modelo reserva" no bloco ou ligue a saída "Janela fechada".');
  }

  const order = { alta: 0, media: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function createCopilot({ pool, llm = null }) {
  async function run(flowId, graph) {
    const byNode = (await pool.query(`select ref, outcome, count(distinct execution_id)::int as leads from public.flow_execution_events where flow_id = $1 group by ref, outcome`, [flowId])).rows;
    const pathsRows = (await pool.query(`select execution_id, array_agg(distinct ref || ':' || outcome) as steps from public.flow_execution_events
      where flow_id = $1 and execution_id in (select id from public.flow_executions where flow_id = $1 order by created_at desc limit 5000) group by execution_id`, [flowId])).rows;
    const suggestions = analyzeFlow(graph, byNode, pathsRows.map((r) => new Set(r.steps)));
    const leads = pathsRows.length;
    let summary = null;
    if (llm && llm.configured && suggestions.length && llm.summarize) {
      try { summary = await llm.summarize({ facts: suggestions.slice(0, 8).map((s) => ({ bloco: s.ref, prioridade: s.severity, fato: `${s.title}. ${s.detail}`, acao: s.action })), leads }); }
      catch { summary = null; } // o resumo é opcional; as sugestões valem sem ele
    }
    return { leads, suggestions, summary };
  }
  return { run };
}
