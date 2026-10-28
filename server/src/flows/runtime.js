// Motor de fluxos em grafo: uma execução por lead, avançando bloco a bloco.
//
// Ciclo: o gatilho (evento de checkout) cria a execução → tick() pega as execuções vencidas
// (lease + skip locked, dois workers não pegam a mesma) → roda blocos instantâneos em sequência
// até um bloco que pausa (Esperar / Aguardar resposta) ou o fim. Uma resposta do lead no WhatsApp
// retoma na hora a execução que aguardava (saída "reply"); sem resposta no prazo, sai por "timeout".
//
// Garantias: estado salvo a cada bloco; envio com falha temporária repete com espera crescente
// (MAX_ATTEMPTS) e depois segue pela saída "failed"; lead que pediu SAIR encerra a execução;
// compra aprovada encerra execuções de recuperação (stop_on_purchase).
import { nodeOf, nextOf, EVENTOS_RECUPERACAO, MAX_WAIT_MINUTES, delaySecondsRange } from './graph.js';
import { render, renderHtml, buildFields, evalCondition, applySetVar, isWindowOpen, inboundText, digitsOf, DEFAULT_TZ, nextBusinessStart, parseLocalDateTime } from './vars.js';
import { resolveCtaLink, retryable } from '../engine/steps.js';

export const MAX_STEPS_PER_RUN = 25;
export const MAX_ATTEMPTS = 4;
const BATCH = 25;
const LEASE_MIN = 5;
const RETRY_BACKOFF_MIN = 2;

// Valores do modelo da Meta: "{{...}}" é renderizado; nome de campo conhecido vira o valor; o resto é texto fixo.
export function templateValues(list, ctx) {
  const fields = buildFields(ctx);
  return (Array.isArray(list) ? list : []).map((m) => {
    const s = String(m ?? '');
    if (s.includes('{{')) return render(s, ctx);
    const k = s.trim();
    return k in fields ? String(fields[k] ?? '') : s;
  });
}
// Sufixo do botão de URL do modelo ({{1}} no fim do endereço) a partir do link de recuperação.
export function buttonSuffix(components, ctaLink) {
  const btn = ((components || []).find((c) => String(c.type).toUpperCase() === 'BUTTONS') || {}).buttons?.find((b) => String(b.type).toUpperCase() === 'URL' && /\{\{\s*1\s*\}\}/.test(b.url || ''));
  if (!btn) return undefined;
  const prefix = btn.url.split('{{')[0];
  return ctaLink && ctaLink.startsWith(prefix) ? ctaLink.slice(prefix.length) : '';
}
export const delaySeconds = (d, rnd = Math.random) => { const [a, b] = delaySecondsRange(d); return Math.round(a + rnd() * (b - a)); };

// Mensagem interativa da Meta: até 3 opções viram botões; de 4 a 10, lista.
export function buildInteractive(d, text) {
  const opts = d.options || [];
  if (opts.length <= 3) return { type: 'button', body: { text }, action: { buttons: opts.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.title } })) } };
  return { type: 'list', body: { text }, action: { button: (d.list_button || 'Ver opções').slice(0, 20), sections: [{ title: 'Opções', rows: opts.map((o) => ({ id: o.id, title: o.title, ...(o.description ? { description: String(o.description).slice(0, 72) } : {}) })) }] } };
}
// Qual saída seguir quando o lead responde: opção tocada (id), texto igual ao da opção, número da opção, ou "other".
const normTxt = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
export function replyExit(options, message, text) {
  if (!Array.isArray(options) || !options.length) return 'reply';
  const i = (message && message.interactive) || {};
  const id = (i.button_reply && i.button_reply.id) || (i.list_reply && i.list_reply.id) || (message && message.button && message.button.payload) || null;
  let hit = id && options.find((o) => o.id === id);
  if (!hit) { const t = normTxt(text); hit = options.find((o, k) => normTxt(o.title) === t || String(k + 1) === t); }
  return hit ? `opt_${hit.id}` : 'other';
}

// Valor digitado ou vindo de variável → número. Aceita 45 | 45,90 | 1.234,50 | 1,234.50 | "$ 45".
// Com vírgula e ponto, o separador que vem por último é o decimal; só vírgula com 1–2 casas no fim é decimal.
function plainNumber(v) {
  if (v === null || v === undefined) return NaN;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (!/\d/.test(s)) return NaN;
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c > -1 && d > -1) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c > -1) s = /,\d{1,2}$/.test(s) ? s.slice(0, c).replace(/,/g, '') + '.' + s.slice(c + 1) : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
export { plainNumber };

// Teste A/B: sorteio pelos pesos (a escolha fica guardada na execução para não sortear de novo).
export function pickVariant(variants, r) {
  const total = variants.reduce((s, v) => s + v.weight, 0);
  let acc = 0; const x = r * total;
  for (const v of variants) { acc += v.weight; if (x < acc) return v.id; }
  return variants[variants.length - 1].id;
}

export function createFlowRuntime({ pool, whatsapp, email = null, llm = null, payments = null, pixel = null, notifier = null, now = () => new Date(), rnd = Math.random, autoKick = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // IA da empresa (chave própria, ai/router.js) ou um cliente fixo (testes / ambiente com uma chave só)
  const aiOf = async (ex) => (llm && llm.forOrg ? llm.forOrg(ex.organization_id) : llm);
  const graphCache = new Map(); // versões são imutáveis: cache seguro
  async function loadGraph(versionId) {
    if (graphCache.has(versionId)) return graphCache.get(versionId);
    const { rows } = await pool.query(`select graph from public.flow_graph_versions where id = $1`, [versionId]);
    const g = rows[0] ? rows[0].graph : null;
    if (g) { if (graphCache.size > 500) graphCache.clear(); graphCache.set(versionId, g); }
    return g;
  }
  const logEvent = (ex, node, outcome, detail = null) => pool.query(
    `insert into public.flow_execution_events (organization_id, execution_id, flow_id, ref, node_type, outcome, detail) values ($1,$2,$3,$4,$5,$6,$7)`,
    [ex.organization_id, ex.id, ex.flow_id, node ? node.ref : ex.current_ref, node ? node.type : '?', outcome, detail ? String(detail).slice(0, 300) : null]).catch((e) => console.error('[flows] trilha falhou:', e.message));

  // ---- Início: evento de checkout ------------------------------------------
  // Encerra recuperações do lead quando a compra é aprovada e inicia os fluxos cujo gatilho casa.
  async function startForEvent({ orgId, tokenId, leadId, webhookEventId, tipo }) {
    let stopped = 0;
    if (tipo === 'Compra Aprovada') {
      const r = await pool.query(`update public.flow_executions set status = 'completed', finished_at = now(), lease_until = null, last_error = 'encerrado: compra aprovada'
        where organization_id = $1 and lead_id = $2 and status in ('running','waiting') and stop_on_purchase returning id`, [orgId, leadId]);
      stopped = r.rowCount;
    }
    const paused = (await pool.query(`select automation_paused from public.leads where id = $1`, [leadId])).rows[0];
    if (paused && paused.automation_paused) return { started: [], stopped, paused: true };
    const { rows } = await pool.query(`
      select c.id as campaign_id, f.id as flow_id, v.id as version_id, v.graph
        from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
        join public.flow_graph_versions v on v.flow_id = f.id and v.is_active
       where c.organization_id = $1 and c.status_campanha = 'Ativa' and (c.postback_token_id is null or c.postback_token_id = $2)`, [orgId, tokenId]);
    const started = [];
    for (const r of rows) {
      const start = nodeOf(r.graph, r.graph.start);
      if (!start || start.type !== 'trigger' || !(start.data.events || []).includes(tipo)) continue;
      const stop = typeof start.data.stop_on_purchase === 'boolean' ? start.data.stop_on_purchase : EVENTOS_RECUPERACAO.has(tipo);
      const ins = await pool.query(`
        insert into public.flow_executions (organization_id, campaign_id, flow_id, graph_version_id, lead_id, webhook_event_id, current_ref, stop_on_purchase, variables)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        on conflict (campaign_id, lead_id) where status in ('running','waiting') do nothing returning id`,
        [orgId, r.campaign_id, r.flow_id, r.version_id, leadId, webhookEventId, start.ref, stop, JSON.stringify({ evento_tipo: tipo })]);
      if (ins.rows[0]) started.push(r.campaign_id);
    }
    if (started.length) kick();
    return { started, stopped };
  }

  // Disparo em massa: coloca UM lead no início de um fluxo publicado (sem depender do evento do gatilho).
  async function startForLead({ orgId, campaignId, leadId, tipo = 'Disparo em massa' }) {
    const lead = (await pool.query(`select automation_paused from public.leads where id = $1 and organization_id = $2`, [leadId, orgId])).rows[0];
    if (!lead) return { started: false, reason: 'lead não encontrado' };
    if (lead.automation_paused) return { started: false, reason: 'automação pausada para este lead' };
    const r = (await pool.query(`select f.id as flow_id, v.id as version_id, v.graph from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
      join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where c.id = $1 and c.organization_id = $2`, [campaignId, orgId])).rows[0];
    if (!r) return { started: false, reason: 'fluxo sem versão publicada' };
    const ins = await pool.query(`insert into public.flow_executions (organization_id, campaign_id, flow_id, graph_version_id, lead_id, current_ref, stop_on_purchase, variables)
      values ($1,$2,$3,$4,$5,$6,true,$7::jsonb) on conflict (campaign_id, lead_id) where status in ('running','waiting') do nothing returning id`,
      [orgId, campaignId, r.flow_id, r.version_id, leadId, r.graph.start, JSON.stringify({ evento_tipo: tipo })]);
    if (!ins.rows[0]) return { started: false, reason: 'o lead já está nesse fluxo' };
    kick();
    return { started: true };
  }

  // ---- Entrada: mensagem do lead -------------------------------------------
  async function onInbound({ orgId, accountId, instanceId = null, message, contacts }) {
    const from = digitsOf(message.from);
    if (!message.id || from.length < 8) return false;
    const text = inboundText(message).slice(0, 4096);
    const ins = await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, account_id, instance_id, wa_message_id, from_phone, msg_type, body, payload)
      values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict (wa_message_id) do nothing returning id`,
      [orgId, accountId, instanceId, message.id, from, message.type || 'unknown', text, JSON.stringify({ message, contact: (contacts || [])[0] || null })]);
    if (!ins.rows[0]) return false; // reentrega da Meta: já tratada
    const tail = from.slice(-10); // casa com ou sem DDI e com/sem o 9 (mesma regra do descadastro)
    const lead = (await pool.query(`select id, automation_paused from public.leads where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2 order by updated_at desc limit 1`, [orgId, tail])).rows[0];
    if (!lead) return true;
    await pool.query(`update public.whatsapp_inbound_messages set lead_id = $2 where id = $1`, [ins.rows[0].id, lead.id]);
    await pool.query(`update public.leads set whatsapp_last_inbound_at = now() where id = $1`, [lead.id]);
    return resumeFor(lead, message, text);
  }
  // Instagram Direct / Messenger: a mensagem já foi guardada e ligada ao lead; só retoma o fluxo que esperava resposta
  async function onInboundLead({ leadId, text }) {
    const lead = (await pool.query(`select id, automation_paused from public.leads where id = $1`, [leadId])).rows[0];
    if (!lead) return false;
    return resumeFor(lead, { type: 'text', text: { body: text } }, String(text || '').slice(0, 4096));
  }
  async function resumeFor(lead, message, text) {
    if (lead.automation_paused) return true; // uma pessoa está atendendo no chat ao vivo
    const waiting = (await pool.query(`select id, variables from public.flow_executions where lead_id = $1 and status = 'waiting' and wait_kind = 'reply' and resume_exit is null`, [lead.id])).rows;
    let resumed = 0;
    for (const w of waiting) {
      const vars = { ...(w.variables || {}) };
      const exit = replyExit(vars._wait_options, message, text);
      vars[vars._wait_var || 'resposta'] = text;
      vars.ultima_mensagem = text;
      // só retoma se ainda estiver esperando (o prazo pode ter vencido no meio do caminho)
      const r = await pool.query(`update public.flow_executions set variables = $2::jsonb, resume_exit = $3, run_at = now()
        where id = $1 and status = 'waiting' and wait_kind = 'reply' and resume_exit is null returning id`, [w.id, JSON.stringify(vars), exit]);
      resumed += r.rowCount;
    }
    if (resumed) kick();
    return true;
  }

  // ---- Pagamento confirmado: puxa a execução para a saída "payment_approved" -------------
  // Vale esteja o lead onde estiver no fluxo (esperando resposta, num delay, ou até já encerrado),
  // enquanto a cobrança estiver "escutando" (listen_until). Não é uma espera: é uma preempção.
  async function onPaymentConfirmed(charge) {
    if (!charge.execution_id || !charge.node_ref) return { preempted: false, reason: 'cobrança sem execução' };
    if (charge.listen_until && new Date(charge.listen_until) < now()) return { preempted: false, reason: 'fora do prazo de escuta' };
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      const ex = (await pool.query(`select * from public.flow_executions where id = $1`, [charge.execution_id])).rows[0];
      if (!ex) return { preempted: false, reason: 'execução removida' };
      const graph = await loadGraph(ex.graph_version_id);
      const node = nodeOf(graph, charge.node_ref);
      if (!node || !nextOf(node, 'payment_approved')) { await logEvent(ex, node, 'payment_approved', 'pagamento confirmado; saída "pagamento aprovado" não está ligada'); return { preempted: false, reason: 'saída não ligada' }; }
      const prefix = ((node.data || {}).save_as) || 'pagamento';
      const extra = { [`${prefix}_status`]: 'confirmed', [`${prefix}_valor_pago`]: charge.paid_amount != null ? String(charge.paid_amount) : String(charge.amount ?? ''), _last_charge_id: charge.id, _last_charge_prefix: prefix };
      const alive = ['running', 'waiting'].includes(ex.status);
      if (!alive) { // execução já terminou: reabre (encerrando outra viva da mesma campanha para o mesmo lead)
        await pool.query(`update public.flow_executions set status = 'cancelled', finished_at = now(), lease_until = null, last_error = 'substituída: pagamento aprovado em execução anterior'
          where campaign_id = $1 and lead_id = $2 and id <> $3 and status in ('running','waiting')`, [ex.campaign_id, ex.lead_id, ex.id]);
      }
      // só mexe se ninguém estiver processando a execução agora (lease livre); senão tenta de novo em instantes
      const r = await pool.query(`update public.flow_executions set status = 'waiting', wait_kind = 'timer', resume_exit = 'payment_approved', current_ref = $2,
          variables = variables || $3::jsonb, run_at = now(), finished_at = null, last_error = null, attempts = 0
        where id = $1 and (lease_until is null or lease_until < now()) returning id`, [ex.id, node.ref, JSON.stringify(extra)]);
      if (r.rowCount) { await logEvent(ex, node, 'payment_confirmed', `cobrança ${charge.id}`); kick(); return { preempted: true }; }
      await sleep(2000);
    }
    return { preempted: false, reason: 'execução ocupada' };
  }

  // ---- Contexto do lead ------------------------------------------------------
  async function contextFor(ex) {
    const lead = (await pool.query(`select id, organization_id, nome, sobrenome, email, telefone, produto, valor_compra, link_recuperacao, whatsapp_opt_out, whatsapp_last_inbound_at, custom_fields, ig_user_id, fb_psid from public.leads where id = $1`, [ex.lead_id])).rows[0] || null;
    // para onde mandar: telefone (WhatsApp) ou ig:<id> / fb:<id> (Instagram Direct / Messenger)
    if (lead) lead.dest = lead.telefone || (lead.ig_user_id ? `ig:${lead.ig_user_id}` : lead.fb_psid ? `fb:${lead.fb_psid}` : null);
    const globals = Object.fromEntries((await pool.query(`select key, value from public.global_variables where organization_id = $1`, [ex.organization_id])).rows.map((r) => [r.key, r.value]));
    const org = (await pool.query(`select timezone from public.organizations where id = $1`, [ex.organization_id])).rows[0] || {};
    const ev = ex.webhook_event_id ? (await pool.query(`select tipo_evento, checkout_url, produto, valor_produto from public.webhook_events where id = $1`, [ex.webhook_event_id])).rows[0] : null;
    const brand = (await pool.query(`select b.nome, b.link_loja, b.link_area_membros from public.campaigns c
      left join public.brands b on b.id = coalesce(c.brand_id, (select id from public.brands where organization_id = c.organization_id order by ordem limit 1))
      where c.id = $1`, [ex.campaign_id])).rows[0] || {};
    const ctaLink = resolveCtaLink({ evento: ev && ev.checkout_url, lead: lead && lead.link_recuperacao, brand: brand.link_loja, tipoEvento: ev && ev.tipo_evento, areaMembros: brand.link_area_membros });
    return {
      lead, brand, tz: org.timezone || DEFAULT_TZ, agora: now(), ctaLink: ctaLink === '#' ? '' : ctaLink,
      evento: ev ? { tipo: ev.tipo_evento, checkout_url: ev.checkout_url, produto: ev.produto, valor: ev.valor_produto } : {},
      vars: { ...(ex.variables || {}) }, globals, campos: (lead && lead.custom_fields) || {},
    };
  }
  async function factsFor(ex, ctx) {
    const tags = new Set((await pool.query(`select tag_id from public.lead_tags where lead_id = $1`, [ex.lead_id])).rows.map((r) => r.tag_id));
    // comprou: compra aprovada no checkout OU cobrança do próprio fluxo confirmada, desde o início da execução
    const comprou = (await pool.query(`select 1 from public.webhook_events where organization_id = $1 and lead_id = $2 and tipo_evento = 'Compra Aprovada' and created_at >= $3
      union all select 1 from public.payment_charges where organization_id = $1 and lead_id = $2 and status = 'confirmed' and confirmed_at >= $3 limit 1`, [ex.organization_id, ex.lead_id, ex.started_at])).rows.length > 0;
    return { ...ctx, tags, comprou, janelaAberta: isWindowOpen(ctx.lead && ctx.lead.whatsapp_last_inbound_at, ctx.agora) };
  }

  // ---- Envio ------------------------------------------------------------------
  async function recordSend(ex, ctx, { ok, msgId, err }) {
    await pool.query(`insert into public.email_events (organization_id, campaign_id, event, channel, email, status, sg_message_id, reason, "timestamp") values ($1,$2,'send','whatsapp',$3,$4,$5,$6, now())`,
      [ex.organization_id, ex.campaign_id, ctx.lead.email, ok ? 'enviado' : 'falhou', msgId, err]);
    if (!ok) return;
    const lm = await pool.query(`update public.lead_metrics set enviados = coalesce(enviados,0) + 1 where lead_id = $1 returning id`, [ex.lead_id]);
    if (!lm.rowCount) await pool.query(`insert into public.lead_metrics (lead_id, organization_id, enviados) values ($1,$2,1)`, [ex.lead_id, ex.organization_id]);
    const cs = await pool.query(`update public.campaign_stats set whatsapp_enviados = coalesce(whatsapp_enviados,0) + 1, ultimo_calculo = now() where campaign_id = $1 returning id`, [ex.campaign_id]);
    if (!cs.rowCount) await pool.query(`insert into public.campaign_stats (campaign_id, organization_id, whatsapp_enviados, ultimo_calculo) values ($1,$2,1,now())`, [ex.campaign_id, ex.organization_id]);
  }
  // preview = texto que aparece no chat ao vivo; source = fluxo | agente
  async function send(ex, ctx, fn, preview = '', source = 'fluxo', deleteOnTag = null) {
    const reserved = await pool.query(`select public.bulk_reserve_usage($1, 1) as ok`, [ex.organization_id]).then((r) => r.rows[0].ok !== false).catch(() => false);
    try {
      const out = await fn();
      await recordSend(ex, ctx, { ok: true, msgId: out.id });
      await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, campaign_id, to_phone, source, body, wa_message_id, channel) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ex.organization_id, ex.lead_id, ex.campaign_id, out.to || ctx.lead.dest, source, String(preview || '').slice(0, 4096), out.id || null, ['uazapi', 'instagram', 'messenger'].includes(out.channel) ? out.channel : 'oficial']).catch((e) => console.error('[flows] conversa não registrada:', e.message));
      if (deleteOnTag && out.channel === 'uazapi' && out.id && out.instanceId) await scheduleDeletion(ex, deleteOnTag, out).catch((e) => console.error('[flows] apagar-ao-etiquetar não registrado:', e.message));
      return { exit: 'sent', detail: out.id };
    } catch (e) {
      const err = String(e.message || e).slice(0, 200);
      if (reserved) await pool.query(`select public.scheduled_step_release_usage($1, 1)`, [ex.organization_id]).catch(() => {});
      if (retryable(e.status, e.code)) return { retry: err };
      await recordSend(ex, ctx, { ok: false, err });
      return { exit: 'failed', detail: err };
    }
  }
  // "Apagar mensagem ao aplicar etiqueta": se o lead já tem a etiqueta, apaga na próxima volta
  const TAG_ID = /^[0-9a-f-]{36}$/i;
  async function scheduleDeletion(ex, tagId, out) {
    await pool.query(`insert into public.flow_message_deletions (organization_id, lead_id, tag_id, instance_id, wa_message_id, status, due_at)
      select $1, $2, t.id, $4, $5,
             case when exists (select 1 from public.lead_tags lt where lt.lead_id = $2 and lt.tag_id = t.id) then 'due' else 'waiting' end,
             case when exists (select 1 from public.lead_tags lt where lt.lead_id = $2 and lt.tag_id = t.id) then now() end
        from public.tags t where t.id = $3::uuid and t.organization_id = $1`, [ex.organization_id, ex.lead_id, tagId, out.instanceId, out.id]);
  }
  async function processDeletions() {
    if (!whatsapp.deleteMessage) return 0;
    const { rows } = await pool.query(`update public.flow_message_deletions d set due_at = now() + interval '5 minutes', attempts = attempts + 1
       where d.id in (select id from public.flow_message_deletions where status = 'due' and due_at <= now() order by due_at limit 50 for update skip locked)
       returning d.*`);
    for (const r of rows) {
      try {
        await whatsapp.deleteMessage(r.organization_id, { instanceId: r.instance_id, messageId: r.wa_message_id });
        await pool.query(`update public.flow_message_deletions set status = 'done', done_at = now(), last_error = null where id = $1`, [r.id]);
      } catch (e) {
        const err = String(e.message || e).slice(0, 200);
        await pool.query(`update public.flow_message_deletions set status = case when attempts >= 3 then 'failed' else 'due' end, last_error = $2 where id = $1`, [r.id, err]);
      }
    }
    return rows.length;
  }
  // Bloco "Enviar e-mail": segue em frente também quando não há o que enviar (lead sem e-mail ou descadastrado),
  // para o fluxo continuar pelos outros canais. Falha definitiva encerra o fluxo do lead.
  async function sendEmail(ex, node, ctx) {
    const d = node.data || {};
    const lead = ctx.lead;
    if (!lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return { exit: 'default', detail: 'pulado: lead sem e-mail' };
    if (!email) return { stop: 'failed', detail: 'envio de e-mail não configurado neste servidor' };
    const em = (await pool.query(`select assunto, corpo_html, remetente from public.emails where id::text = $1 and organization_id = $2`, [String(d.email_id || ''), ex.organization_id])).rows[0];
    if (!em) return { stop: 'failed', detail: 'e-mail do bloco não encontrado' };
    const ectx = { ...ctx, ctaLink: ctx.ctaLink || '#' };
    const reserved = await pool.query(`select public.bulk_reserve_usage($1, 1) as ok`, [ex.organization_id]).then((r) => r.rows[0].ok).catch(() => null);
    if (reserved === false) return { exit: 'default', detail: 'pulado: limite do plano atingido' };
    const release = () => (reserved ? pool.query(`select public.scheduled_step_release_usage($1, 1)`, [ex.organization_id]).catch(() => {}) : null);
    const log = (status, msgId, reason) => pool.query(`insert into public.email_events (organization_id, campaign_id, event, channel, email, status, sg_message_id, reason, "timestamp") values ($1,$2,'send','email',$3,$4,$5,$6, now())`,
      [ex.organization_id, ex.campaign_id, lead.email, status, msgId, reason]).catch((e) => console.error('[flows] evento de e-mail:', e.message));
    let out;
    try {
      out = await email.send(ex.organization_id, { to: lead.email, subject: render(em.assunto || '', ectx), html: renderHtml(em.corpo_html || '', ectx), fromName: em.remetente || (ctx.brand && ctx.brand.nome) });
    } catch (e) {
      await release(); await log('falhou', null, String(e.message).slice(0, 200));
      return e.fatal ? { stop: 'failed', detail: String(e.message).slice(0, 200) } : { retry: String(e.message).slice(0, 200) };
    }
    if (out.skipped) { await release(); return { exit: 'default', detail: `pulado: ${out.skipped}` }; }
    await log('enviado', out.id, null);
    const lm = await pool.query(`update public.lead_metrics set enviados = coalesce(enviados,0) + 1 where lead_id = $1 returning id`, [ex.lead_id]);
    if (!lm.rowCount) await pool.query(`insert into public.lead_metrics (lead_id, organization_id, enviados) values ($1,$2,1)`, [ex.lead_id, ex.organization_id]);
    const cs = await pool.query(`update public.campaign_stats set emails_enviados = coalesce(emails_enviados,0) + 1, ultimo_calculo = now() where campaign_id = $1 returning id`, [ex.campaign_id]);
    if (!cs.rowCount) await pool.query(`insert into public.campaign_stats (campaign_id, organization_id, emails_enviados, ultimo_calculo) values ($1,$2,1,now())`, [ex.campaign_id, ex.organization_id]);
    return { exit: 'default', detail: `e-mail enviado${out.id ? ' ' + out.id : ''}` };
  }
  async function sendTemplate(ex, ctx, templateId, varsList) {
    const tpl = (await pool.query(`select id, name, components from public.whatsapp_templates where id::text = $1 and organization_id = $2`, [String(templateId), ex.organization_id])).rows[0];
    if (!tpl) return { exit: 'failed', detail: 'modelo do WhatsApp não encontrado' };
    return send(ex, ctx, () => whatsapp.sendTemplateTo(ex.organization_id, { to: ctx.lead.dest, template_id: tpl.id, variables: templateValues(varsList, ctx), button_suffix: buttonSuffix(tpl.components, ctx.ctaLink) }), `[modelo] ${tpl.name}`);
  }

  // ---- Um bloco ---------------------------------------------------------------
  async function runNode(ex, node, ctx) {
    const d = node.data || {};
    if (ctx.lead && ctx.lead.dest === undefined) ctx.lead.dest = ctx.lead.telefone || (ctx.lead.ig_user_id ? `ig:${ctx.lead.ig_user_id}` : ctx.lead.fb_psid ? `fb:${ctx.lead.fb_psid}` : null);
    switch (node.type) {
      case 'trigger': return { exit: 'default' };
      case 'delay': {
        const s = Math.max(0, Math.min(MAX_WAIT_MINUTES * 60, delaySeconds(d, rnd)));
        // "digitando..." durante a espera (só com a janela aberta; a Meta exige uma mensagem do lead para marcar)
        if (d.typing && s > 0 && isWindowOpen(ctx.lead.whatsapp_last_inbound_at, ctx.agora) && whatsapp.typingFor) {
          const last = (await pool.query(`select wa_message_id from public.whatsapp_inbound_messages where lead_id = $1 order by received_at desc limit 1`, [ex.lead_id])).rows[0];
          if (last) await whatsapp.typingFor(ex.organization_id, last.wa_message_id);
        }
        return s === 0 ? { exit: 'default' } : { wait: { kind: 'timer', seconds: s } };
      }
      case 'wait_reply': {
        ctx.vars._wait_var = d.save_as || 'resposta';
        delete ctx.vars._wait_options;
        return { wait: { kind: 'reply', seconds: (d.timeout_minutes || MAX_WAIT_MINUTES) * 60 } };
      }
      case 'send_media':
      case 'send_buttons': {
        if (ctx.lead.whatsapp_opt_out) return { stop: 'cancelled', detail: 'lead pediu para não receber WhatsApp' };
        if (!ctx.lead.dest) return { exit: 'failed', detail: 'lead sem telefone' };
        const livre = node.type === 'send_media' && whatsapp.freeTextAllowed ? await whatsapp.freeTextAllowed(ex.organization_id, ctx.lead.dest) : false;
        if (!livre && !isWindowOpen(ctx.lead.whatsapp_last_inbound_at, ctx.agora)) {
          const fechada = node.type === 'send_media' && nextOf(node, 'window_closed') ? 'window_closed' : 'failed';
          return { exit: fechada, detail: 'janela de 24 h fechada (mídia e botões só com conversa aberta; use um modelo antes)' };
        }
        if (node.type === 'send_media') {
          const url = render(d.url, ctx).trim();
          if (!/^https:\/\/\S+$/i.test(url)) return { exit: 'failed', detail: `link da mídia inválido ou vazio${/\{\{/.test(d.url) ? ` (a variável ${d.url} não tem um link https)` : ''}` };
          return send(ex, ctx, () => whatsapp.sendMediaTo(ex.organization_id, { to: ctx.lead.dest, kind: d.kind, url, caption: d.caption ? render(d.caption, ctx) : undefined, filename: d.filename ? render(d.filename, ctx) : undefined }), `[${d.kind || 'mídia'}] ${d.caption ? render(d.caption, ctx) : url}`, 'fluxo', TAG_ID.test(String(d.delete_on_tag || '')) ? d.delete_on_tag : null);
        }
        const r = await send(ex, ctx, () => whatsapp.sendInteractiveTo(ex.organization_id, { to: ctx.lead.dest, interactive: buildInteractive(d, render(d.text, ctx)) }), render(d.text, ctx));
        if (r.exit !== 'sent') return r;
        ctx.vars._wait_var = d.save_as || 'resposta';
        ctx.vars._wait_options = (d.options || []).map((o) => ({ id: o.id, title: o.title }));
        return { wait: { kind: 'reply', seconds: (d.timeout_minutes || MAX_WAIT_MINUTES) * 60 }, detail: r.detail };
      }
      case 'ai_agent': {
        if (d.agent_id) {
          const ag = (await pool.query(`select objective, knowledge, tone, opening, max_turns, timeout_minutes from public.ai_agents where id::text = $1 and organization_id = $2`, [String(d.agent_id), ex.organization_id])).rows[0];
          if (!ag) return { exit: 'error', detail: 'agente de IA salvo não encontrado' };
          // o que o bloco preencher sobrepõe o agente salvo
          const local = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== '' && v != null));
          return runNode(ex, { ...node, data: { ...ag, ...local, agent_id: null } }, ctx);
        }
        const hk = `_agent_${node.ref}`;
        const saveAs = d.save_as || 'resposta';
        const timeoutS = (d.timeout_minutes || 60) * 60;
        let st = ctx.vars[hk] || { h: [], turns: 0 };
        const waitAgain = (detail) => { ctx.vars[hk] = st; ctx.vars._wait_var = saveAs; delete ctx.vars._wait_options; return { wait: { kind: 'reply', seconds: timeoutS }, detail }; };
        if (ctx.lead.whatsapp_opt_out) return { stop: 'cancelled', detail: 'lead pediu para não receber WhatsApp' };
        if (!ctx.vars._agent_pending) {
          // entrada no bloco: começa uma conversa nova
          st = { h: [], turns: 0 };
          const ultima = ctx.vars[saveAs] || ctx.vars.ultima_mensagem;
          if (d.opening) {
            if (!isWindowOpen(ctx.lead.whatsapp_last_inbound_at, ctx.agora)) return { exit: 'error', detail: 'janela de 24 h fechada: o agente só conversa depois que o lead escreve (use um modelo antes)' };
            const text = render(d.opening, ctx);
            const s = await send(ex, ctx, () => whatsapp.sendTextTo(ex.organization_id, { to: ctx.lead.dest, text }), text, 'agente');
            if (s.retry) return s;
            if (s.exit !== 'sent') return { exit: 'error', detail: s.detail };
            st.h.push({ r: 'agent', t: text });
            return waitAgain('abertura enviada');
          }
          if (d.reply_on_entry === false || !ultima) return waitAgain('aguardando o lead');
          ctx.vars[saveAs] = ultima; // responde já a última mensagem do lead
        }
        // turno: o lead respondeu → IA responde
        delete ctx.vars._agent_pending;
        const text = String(ctx.vars[saveAs] ?? ctx.vars.ultima_mensagem ?? '');
        st.h.push({ r: 'lead', t: text });
        const llm = await aiOf(ex);
        if (!llm) return { exit: 'error', detail: 'IA não configurada' };
        let out;
        try {
          out = await llm.agentReply({ objective: render(d.objective, ctx), knowledge: render(d.knowledge || '', ctx), tone: d.tone, history: st.h, leadName: (ctx.lead.nome || '').split(' ')[0] });
        } catch (e) {
          if (retryable(e.status, e.code) && e.code !== 'ai_unconfigured') { st.h.pop(); ctx.vars[hk] = st; ctx.vars._agent_pending = true; return { retry: String(e.message).slice(0, 200) }; }
          return { exit: 'error', detail: String(e.message).slice(0, 200) };
        }
        if (out.resposta) {
          const s = await send(ex, ctx, () => whatsapp.sendTextTo(ex.organization_id, { to: ctx.lead.dest, text: out.resposta }), out.resposta, 'agente');
          if (s.retry) { st.h.pop(); ctx.vars[hk] = st; ctx.vars._agent_pending = true; return s; }
          if (s.exit !== 'sent') return { exit: 'error', detail: s.detail };
          st.h.push({ r: 'agent', t: out.resposta });
        }
        st.turns++;
        if (st.h.length > 24) st.h = st.h.slice(-24);
        ctx.vars[hk] = st;
        ctx.vars.agente_resposta = out.resposta;
        if (out.acao === 'concluido') return { exit: 'done', detail: `concluído em ${st.turns} resposta(s)` };
        if (out.acao === 'humano') return { exit: 'handoff', detail: 'pediu atendimento humano' };
        if (st.turns >= (d.max_turns || 10)) return { exit: 'done', detail: `limite de ${st.turns} respostas` };
        return waitAgain(`resposta ${st.turns}`);
      }
      case 'split': {
        const key = `_split_${node.ref}`;
        const vs = d.variants || [];
        let id = ctx.vars[key];
        if (!vs.some((v) => v.id === id)) { id = pickVariant(vs, rnd()); ctx.vars[key] = id; }
        return { exit: `var_${id}` };
      }
      case 'checkpoint': return { exit: 'default', detail: String(d.name || '').slice(0, 60) };
      case 'wait_until': {
        let at = null;
        if (d.mode === 'business_hours') at = nextBusinessStart(ctx.agora, ctx.tz, d.days || [], d.from, d.to);
        else {
          const t = parseLocalDateTime(render(String(d.at || ''), ctx), ctx.tz);
          if (!t) return { exit: 'default', detail: `data inválida (${render(String(d.at || ''), ctx) || 'vazia'}) — seguiu sem esperar` };
          at = t > ctx.agora ? t : null;
        }
        if (!at) return { exit: 'default', detail: 'já está no horário' };
        const secs = Math.min(MAX_WAIT_MINUTES * 60, Math.ceil((at.getTime() - ctx.agora.getTime()) / 1000));
        return { wait: { kind: 'timer', seconds: secs }, detail: `até ${at.toISOString()}` };
      }
      case 'notify': {
        if (!notifier) return { exit: 'default', detail: 'alertas indisponíveis neste ambiente' };
        const r = await notifier.send({ orgId: ex.organization_id, channelId: d.channel_id, text: render(d.text, ctx), chatId: d.chat_id ? render(String(d.chat_id), ctx) : undefined });
        return { exit: 'default', detail: r.ok ? 'alerta enviado' : `alerta falhou: ${r.detail}` }; // o fluxo segue mesmo se o alerta falhar
      }
      case 'payment': {
        if (!payments) return { exit: 'error', detail: 'pagamentos indisponíveis neste ambiente' };
        const prefix = d.save_as || 'pagamento';
        // cada NOVA passagem pelo bloco gera uma cobrança nova (ex.: OXXO venceu → volta e gera outro);
        // a repetição após falha temporária reaproveita a mesma (mesmo external_id = idempotente no gateway)
        const seqKey = `_pay_seq_${node.ref}`;
        if (!ex.attempts) ctx.vars[seqKey] = (Number(ctx.vars[seqKey]) || 0) + 1;
        const externalId = `kb-${ex.id}-${node.ref}-${ctx.vars[seqKey] || 1}`;
        const amount = d.open_amount ? null : plainNumber(render(String(d.amount ?? ''), ctx));
        if (!d.open_amount && !(amount > 0)) return { exit: 'error', detail: `valor da cobrança inválido (${render(String(d.amount ?? ''), ctx) || 'vazio'})` };
        try {
          const ch = await payments.createCharge({
            ex, nodeRef: node.ref, integrationId: d.integration_id, currency: d.currency, method: d.method, amount, openAmount: !!d.open_amount,
            payer: { name: render(d.payer_name || '{{nome}}', ctx) || 'Cliente', document: d.document ? render(d.document, ctx) : undefined, email: ctx.lead.email || undefined, phone: ctx.lead.telefone || undefined },
            description: d.description ? render(d.description, ctx) : undefined, externalId, listenHours: d.listen_hours || 48,
          });
          Object.assign(ctx.vars, {
            [`${prefix}_codigo`]: ch.payment_code || '', [`${prefix}_qr`]: ch.payment_qr || '', [`${prefix}_link`]: ch.checkout_url || '',
            [`${prefix}_valor`]: ch.amount != null ? String(ch.amount) : '', [`${prefix}_moeda`]: d.currency, [`${prefix}_metodo`]: d.method,
            [`${prefix}_id`]: ch.id, [`${prefix}_status`]: ch.status, _last_charge_id: ch.id, _last_charge_prefix: prefix,
          });
          for (const [k, v] of Object.entries(ch.extra || {})) ctx.vars[`${prefix}_${k}`] = v;
          return { exit: 'charge_created', detail: `${d.currency} ${d.method}${amount ? ' ' + amount : ' valor livre'}` };
        } catch (e) {
          if (e.status >= 500 || e.status === 429) return { retry: `${e.code || ''} ${e.message}`.trim().slice(0, 200) };
          return { exit: 'error', detail: `${e.code || 'erro'}: ${String(e.message).slice(0, 180)}` };
        }
      }
      case 'record_sale': {
        const prefix = ctx.vars._last_charge_prefix || 'pagamento';
        const amount = plainNumber(render(String(d.amount ?? `{{${prefix}_valor_pago}}`), ctx)) || plainNumber(render(`{{${prefix}_valor}}`, ctx));
        if (!(amount > 0)) return { exit: 'default', detail: 'venda não registrada: sem valor' };
        const currency = (render(String(d.currency || `{{${prefix}_moeda}}`), ctx) || 'BRL').toUpperCase().slice(0, 3) || 'BRL';
        const product = render(String(d.product || '{{produto}}'), ctx) || null;
        const chargeId = ctx.vars._last_charge_id && /^[0-9a-f-]{36}$/i.test(ctx.vars._last_charge_id) ? ctx.vars._last_charge_id : null;
        const ins = await pool.query(`insert into public.flow_sales (organization_id, campaign_id, execution_id, lead_id, charge_id, amount, currency, product)
          values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (charge_id) where charge_id is not null do nothing returning id`,
          [ex.organization_id, ex.campaign_id, ex.id, ex.lead_id, chargeId, amount, currency, product]);
        if (!ins.rows[0]) return { exit: 'default', detail: 'venda já registrada para esta cobrança' };
        await pool.query(`select public.increment_vendas_recuperadas($1)`, [ex.campaign_id]).catch((e) => console.error('[flows] vendas_recuperadas:', e.message));
        ctx.vars.venda_registrada = 'sim';
        return { exit: 'default', detail: `${currency} ${amount}` };
      }
      case 'pixel': {
        if (!pixel) return { exit: 'default', detail: 'pixel indisponível neste ambiente' };
        const prefix = ctx.vars._last_charge_prefix || 'pagamento';
        const value = d.value ? plainNumber(render(String(d.value), ctx)) : d.event === 'Purchase' ? (plainNumber(render(`{{${prefix}_valor_pago}}`, ctx)) || plainNumber(render(`{{${prefix}_valor}}`, ctx))) : null;
        // compra: mesmo event_id da cobrança → a Meta não conta duas vezes se outro sistema também enviar
        const eventId = d.event === 'Purchase' && ctx.vars._last_charge_id ? String(ctx.vars._last_charge_id) : `${ex.id}:${node.ref}`;
        const r = await pixel.send({ orgId: ex.organization_id, configId: d.pixel_config_id, eventName: d.event, eventId, lead: ctx.lead,
          value: Number.isFinite(value) ? value : null, currency: d.currency || ctx.vars[`${prefix}_moeda`] || 'BRL' });
        return { exit: 'default', detail: `${d.event}: ${r.ok ? 'enviado' : 'falhou'} (${r.detail})` }; // o fluxo segue mesmo se o Pixel falhar
      }
      case 'ai_classify':
      case 'ai_extract': {
        const llm = await aiOf(ex);
        if (!llm) return { exit: 'error', detail: 'IA não configurada' };
        const text = render(d.input || '{{resposta}}', ctx);
        try {
          if (node.type === 'ai_classify') {
            const key = await llm.classify({ text, outputs: d.outputs || [], instructions: d.instructions });
            if (key) ctx.vars[d.save_as || 'classificacao'] = key;
            return { exit: key ? `out_${key}` : 'other', detail: key || 'nenhuma saída' };
          }
          const got = await llm.extract({ text, fields: d.fields || [], instructions: d.instructions });
          const faltando = [];
          for (const f of d.fields || []) { if (got[f.name] !== null) ctx.vars[f.name] = got[f.name]; else if (f.required !== false) faltando.push(f.name); }
          return faltando.length ? { exit: 'missing', detail: `faltou: ${faltando.join(', ')}` } : { exit: 'ok' };
        } catch (e) {
          if (retryable(e.status, e.code) && e.code !== 'ai_unconfigured') return { retry: String(e.message).slice(0, 200) };
          return { exit: 'error', detail: String(e.message).slice(0, 200) };
        }
      }
      case 'condition': return { exit: evalCondition(d, await factsFor(ex, ctx)) ? 'yes' : 'no' };
      case 'set_var': { ctx.vars[d.name] = applySetVar(d, ctx); return { exit: 'default', detail: `${d.name}=${String(ctx.vars[d.name]).slice(0, 60)}` }; }
      case 'tag': {
        const ids = (a) => (Array.isArray(a) ? a : []).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x)));
        const add = ids(d.add), rem = ids(d.remove);
        if (add.length) await pool.query(`insert into public.lead_tags (lead_id, tag_id) select $1, t.id from public.tags t where t.organization_id = $2 and t.id = any($3::uuid[]) on conflict do nothing`, [ex.lead_id, ex.organization_id, add]);
        if (rem.length) await pool.query(`delete from public.lead_tags where lead_id = $1 and tag_id = any($2::uuid[])`, [ex.lead_id, rem]);
        return { exit: 'default' };
      }
      case 'send_email': return sendEmail(ex, node, ctx);
      case 'send_template':
      case 'send_text': {
        if (ctx.lead.whatsapp_opt_out) return { stop: 'cancelled', detail: 'lead pediu para não receber WhatsApp' };
        if (!ctx.lead.dest) return { exit: 'failed', detail: 'lead sem telefone' };
        if (node.type === 'send_template') return sendTemplate(ex, ctx, d.template_id, d.vars);
        // WhatsApp comum (QR Code, sem API oficial) não tem janela de 24 h
        const aberta = isWindowOpen(ctx.lead.whatsapp_last_inbound_at, ctx.agora) || (whatsapp.freeTextAllowed ? await whatsapp.freeTextAllowed(ex.organization_id, ctx.lead.dest) : false);
        if (aberta) { const text = render(d.text, ctx); return send(ex, ctx, () => whatsapp.sendTextTo(ex.organization_id, { to: ctx.lead.dest, text }), text, 'fluxo', TAG_ID.test(String(d.delete_on_tag || '')) ? d.delete_on_tag : null); }
        // Janela fechada: com modelo reserva, troca sozinho para o modelo aprovado (diferencial Kobly).
        if (d.fallback_template_id) { const r = await sendTemplate(ex, ctx, d.fallback_template_id, d.fallback_vars); return { ...r, detail: `janela fechada → modelo reserva${r.detail ? ': ' + r.detail : ''}` }; }
        return { exit: nextOf(node, 'window_closed') ? 'window_closed' : 'failed', detail: 'janela de 24 h fechada e sem modelo reserva' };
      }
      case 'end': return { stop: 'completed' };
      default: return { stop: 'failed', detail: `tipo de bloco desconhecido: ${node.type}` };
    }
  }

  // ---- Uma execução -----------------------------------------------------------
  // release=false mantém a reserva (lease) enquanto a execução segue neste worker; ela só é solta ao pausar/terminar.
  async function save(ex, patch, { release = true } = {}) {
    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const lease = release ? 'null' : `now() + interval '${LEASE_MIN} minutes'`;
    await pool.query(`update public.flow_executions set ${sets}, lease_until = ${lease} where id = $1`, [ex.id, ...cols.map((c) => (c === 'variables' ? JSON.stringify(patch[c]) : patch[c]))]);
  }
  const finish = (ex, ctx, status, err = null, ref = ex.current_ref) =>
    save(ex, { status, last_error: err, current_ref: ref, variables: ctx ? ctx.vars : ex.variables, finished_at: now().toISOString(), wait_kind: null, resume_exit: null });

  async function process(ex) {
    const graph = await loadGraph(ex.graph_version_id);
    if (!graph) return finish(ex, null, 'failed', 'versão do fluxo não encontrada');
    const ctx = await contextFor(ex);
    if (!ctx.lead) return finish(ex, ctx, 'cancelled', 'lead removido');
    let ref = ex.current_ref;
    let steps = ex.steps_count;

    if (ex.status === 'waiting') {
      const node = nodeOf(graph, ref);
      let exit = ex.resume_exit || (ex.wait_kind === 'reply' ? 'timeout' : 'default');
      delete ctx.vars._wait_var; delete ctx.vars._wait_options;
      if (node && node.type === 'ai_agent' && exit === 'reply') {
        // o agente continua no mesmo bloco: a resposta do lead vira o próximo turno da conversa
        ctx.vars._agent_pending = true;
        await logEvent(ex, node, 'reply');
      } else {
        if (node && node.type === 'ai_agent' && exit === 'timeout') exit = 'expiration';
        await logEvent(ex, node, exit);
        ref = nextOf(node, exit);
        if (!ref) return finish(ex, ctx, 'completed', null, ex.current_ref);
      }
    }

    for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
      const node = nodeOf(graph, ref);
      if (!node) return finish(ex, ctx, 'failed', `bloco "${ref}" não existe nesta versão`, ref);
      steps++;
      let r;
      try { r = await runNode(ex, node, ctx); } catch (e) { r = { retry: String(e.message || e).slice(0, 200) }; }

      if (r.retry) {
        const attempts = ex.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) r = { exit: node.type.startsWith('ai_') || node.type === 'payment' ? 'error' : 'failed', detail: `desistiu após ${attempts} tentativas: ${r.retry}` };
        else {
          await logEvent(ex, node, 'retry', r.retry);
          return save(ex, { status: 'running', current_ref: ref, variables: ctx.vars, attempts, last_error: r.retry, steps_count: steps, run_at: new Date(now().getTime() + RETRY_BACKOFF_MIN * 60000 * attempts).toISOString() });
        }
      }
      if (r.stop) { await logEvent(ex, node, r.stop, r.detail); return finish(ex, ctx, r.stop, r.detail || null, ref); }
      if (r.wait) {
        const secs = r.wait.seconds;
        await logEvent(ex, node, r.wait.kind === 'reply' ? 'waiting_reply' : 'waiting', secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`);
        await save(ex, { status: 'waiting', current_ref: ref, wait_kind: r.wait.kind, resume_exit: null, variables: ctx.vars, attempts: 0, last_error: null, steps_count: steps,
          run_at: new Date(now().getTime() + secs * 1000).toISOString() });
        // espera curta (pausas de "humanização"): retoma no segundo certo em vez de esperar o próximo ciclo
        if (r.wait.kind === 'timer' && secs < 60 && autoKick) setTimeout(kick, secs * 1000 + 50).unref?.();
        return;
      }
      await logEvent(ex, node, r.exit, r.detail);
      ex.attempts = 0;
      const nxt = nextOf(node, r.exit);
      if (!nxt) {
        const err = r.exit === 'failed' || r.exit === 'error' ? (r.detail || 'falhou') : null;
        return finish(ex, ctx, err ? 'failed' : 'completed', err, ref);
      }
      ref = nxt;
      // salva o avanço a cada bloco: se o processo cair, ninguém recebe a mesma mensagem duas vezes
      await save(ex, { status: 'running', current_ref: ref, variables: ctx.vars, attempts: 0, steps_count: steps, wait_kind: null, resume_exit: null }, { release: false });
    }
    // muitos blocos seguidos: continua no próximo ciclo (evita prender o worker)
    return save(ex, { status: 'running', current_ref: ref, variables: ctx.vars, steps_count: steps, run_at: now().toISOString() });
  }

  async function claim() {
    const { rows } = await pool.query(`
      with due as (
        select id from public.flow_executions
         where status in ('running','waiting') and run_at <= now() and (lease_until is null or lease_until < now())
         order by run_at limit $1 for update skip locked)
      update public.flow_executions e set lease_until = now() + ($2 || ' minutes')::interval
        from due where e.id = due.id returning e.*`, [BATCH, String(LEASE_MIN)]);
    return rows;
  }

  let running = false, again = false;
  async function tick() {
    if (running) { again = true; return { busy: true }; }
    running = true;
    const stats = { claimed: 0, ok: 0, failed: 0 };
    try {
      do {
        again = false;
        const due = await claim(); stats.claimed += due.length;
        for (const ex of due) {
          try { await process(ex); stats.ok++; }
          catch (e) {
            stats.failed++; console.error('[flows] execução', ex.id, e.message);
            await pool.query(`update public.flow_executions set lease_until = null, attempts = attempts + 1, last_error = $2, run_at = now() + interval '2 minutes' where id = $1`, [ex.id, String(e.message).slice(0, 200)]).catch(() => {});
          }
        }
        if (due.length === BATCH) again = true;
      } while (again);
      stats.deleted = await processDeletions().catch((e) => { console.error('[flows] apagar mensagens:', e.message); return 0; });
    } finally { running = false; }
    return stats;
  }
  // Retomada rápida (resposta do lead / evento novo) sem esperar o próximo ciclo.
  function kick() { if (autoKick) setImmediate(() => { tick().catch((e) => console.error('[flows] tick:', e.message)); }); }

  return { startForEvent, startForLead, onInbound, onInboundLead, onPaymentConfirmed, tick, kick, process, runNode, loadGraph, processDeletions };
}
