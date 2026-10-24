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
import { render, buildFields, evalCondition, applySetVar, isWindowOpen, inboundText, digitsOf, DEFAULT_TZ } from './vars.js';
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

export function createFlowRuntime({ pool, whatsapp, llm = null, now = () => new Date(), rnd = Math.random, autoKick = true }) {
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

  // ---- Entrada: mensagem do lead -------------------------------------------
  async function onInbound({ orgId, accountId, message, contacts }) {
    const from = digitsOf(message.from);
    if (!message.id || from.length < 8) return false;
    const text = inboundText(message).slice(0, 4096);
    const ins = await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, account_id, wa_message_id, from_phone, msg_type, body, payload)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict (wa_message_id) do nothing returning id`,
      [orgId, accountId, message.id, from, message.type || 'unknown', text, JSON.stringify({ message, contact: (contacts || [])[0] || null })]);
    if (!ins.rows[0]) return false; // reentrega da Meta: já tratada
    const tail = from.slice(-10); // casa com ou sem DDI e com/sem o 9 (mesma regra do descadastro)
    const lead = (await pool.query(`select id from public.leads where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2 order by updated_at desc limit 1`, [orgId, tail])).rows[0];
    if (!lead) return true;
    await pool.query(`update public.whatsapp_inbound_messages set lead_id = $2 where id = $1`, [ins.rows[0].id, lead.id]);
    await pool.query(`update public.leads set whatsapp_last_inbound_at = now() where id = $1`, [lead.id]);
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

  // ---- Contexto do lead ------------------------------------------------------
  async function contextFor(ex) {
    const lead = (await pool.query(`select id, organization_id, nome, sobrenome, email, telefone, produto, valor_compra, link_recuperacao, whatsapp_opt_out, whatsapp_last_inbound_at from public.leads where id = $1`, [ex.lead_id])).rows[0] || null;
    const org = (await pool.query(`select timezone from public.organizations where id = $1`, [ex.organization_id])).rows[0] || {};
    const ev = ex.webhook_event_id ? (await pool.query(`select tipo_evento, checkout_url, produto, valor_produto from public.webhook_events where id = $1`, [ex.webhook_event_id])).rows[0] : null;
    const brand = (await pool.query(`select b.nome, b.link_loja, b.link_area_membros from public.campaigns c
      left join public.brands b on b.id = coalesce(c.brand_id, (select id from public.brands where organization_id = c.organization_id order by ordem limit 1))
      where c.id = $1`, [ex.campaign_id])).rows[0] || {};
    const ctaLink = resolveCtaLink({ evento: ev && ev.checkout_url, lead: lead && lead.link_recuperacao, brand: brand.link_loja, tipoEvento: ev && ev.tipo_evento, areaMembros: brand.link_area_membros });
    return {
      lead, brand, tz: org.timezone || DEFAULT_TZ, agora: now(), ctaLink: ctaLink === '#' ? '' : ctaLink,
      evento: ev ? { tipo: ev.tipo_evento, checkout_url: ev.checkout_url, produto: ev.produto, valor: ev.valor_produto } : {},
      vars: { ...(ex.variables || {}) },
    };
  }
  async function factsFor(ex, ctx) {
    const tags = new Set((await pool.query(`select tag_id from public.lead_tags where lead_id = $1`, [ex.lead_id])).rows.map((r) => r.tag_id));
    const comprou = (await pool.query(`select 1 from public.webhook_events where organization_id = $1 and lead_id = $2 and tipo_evento = 'Compra Aprovada' and created_at >= $3 limit 1`, [ex.organization_id, ex.lead_id, ex.started_at])).rows.length > 0;
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
  async function send(ex, ctx, fn) {
    const reserved = await pool.query(`select public.bulk_reserve_usage($1, 1) as ok`, [ex.organization_id]).then((r) => r.rows[0].ok !== false).catch(() => false);
    try {
      const out = await fn();
      await recordSend(ex, ctx, { ok: true, msgId: out.id });
      return { exit: 'sent', detail: out.id };
    } catch (e) {
      const err = String(e.message || e).slice(0, 200);
      if (reserved) await pool.query(`select public.scheduled_step_release_usage($1, 1)`, [ex.organization_id]).catch(() => {});
      if (retryable(e.status, e.code)) return { retry: err };
      await recordSend(ex, ctx, { ok: false, err });
      return { exit: 'failed', detail: err };
    }
  }
  async function sendTemplate(ex, ctx, templateId, varsList) {
    const tpl = (await pool.query(`select id, components from public.whatsapp_templates where id::text = $1 and organization_id = $2`, [String(templateId), ex.organization_id])).rows[0];
    if (!tpl) return { exit: 'failed', detail: 'modelo do WhatsApp não encontrado' };
    return send(ex, ctx, () => whatsapp.sendTemplateTo(ex.organization_id, { to: ctx.lead.telefone, template_id: tpl.id, variables: templateValues(varsList, ctx), button_suffix: buttonSuffix(tpl.components, ctx.ctaLink) }));
  }

  // ---- Um bloco ---------------------------------------------------------------
  async function runNode(ex, node, ctx) {
    const d = node.data || {};
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
        if (!ctx.lead.telefone) return { exit: 'failed', detail: 'lead sem telefone' };
        if (!isWindowOpen(ctx.lead.whatsapp_last_inbound_at, ctx.agora)) {
          const fechada = node.type === 'send_media' && nextOf(node, 'window_closed') ? 'window_closed' : 'failed';
          return { exit: fechada, detail: 'janela de 24 h fechada (mídia e botões só com conversa aberta; use um modelo antes)' };
        }
        if (node.type === 'send_media') {
          return send(ex, ctx, () => whatsapp.sendMediaTo(ex.organization_id, { to: ctx.lead.telefone, kind: d.kind, url: render(d.url, ctx), caption: d.caption ? render(d.caption, ctx) : undefined, filename: d.filename ? render(d.filename, ctx) : undefined }));
        }
        const r = await send(ex, ctx, () => whatsapp.sendInteractiveTo(ex.organization_id, { to: ctx.lead.telefone, interactive: buildInteractive(d, render(d.text, ctx)) }));
        if (r.exit !== 'sent') return r;
        ctx.vars._wait_var = d.save_as || 'resposta';
        ctx.vars._wait_options = (d.options || []).map((o) => ({ id: o.id, title: o.title }));
        return { wait: { kind: 'reply', seconds: (d.timeout_minutes || MAX_WAIT_MINUTES) * 60 }, detail: r.detail };
      }
      case 'ai_classify':
      case 'ai_extract': {
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
      case 'send_template':
      case 'send_text': {
        if (ctx.lead.whatsapp_opt_out) return { stop: 'cancelled', detail: 'lead pediu para não receber WhatsApp' };
        if (!ctx.lead.telefone) return { exit: 'failed', detail: 'lead sem telefone' };
        if (node.type === 'send_template') return sendTemplate(ex, ctx, d.template_id, d.vars);
        const aberta = isWindowOpen(ctx.lead.whatsapp_last_inbound_at, ctx.agora);
        if (aberta) return send(ex, ctx, () => whatsapp.sendTextTo(ex.organization_id, { to: ctx.lead.telefone, text: render(d.text, ctx) }));
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
      const exit = ex.resume_exit || (ex.wait_kind === 'reply' ? 'timeout' : 'default');
      delete ctx.vars._wait_var; delete ctx.vars._wait_options;
      await logEvent(ex, node, exit);
      ref = nextOf(node, exit);
      if (!ref) return finish(ex, ctx, 'completed', null, ex.current_ref);
    }

    for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
      const node = nodeOf(graph, ref);
      if (!node) return finish(ex, ctx, 'failed', `bloco "${ref}" não existe nesta versão`, ref);
      steps++;
      let r;
      try { r = await runNode(ex, node, ctx); } catch (e) { r = { retry: String(e.message || e).slice(0, 200) }; }

      if (r.retry) {
        const attempts = ex.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) r = { exit: node.type.startsWith('ai_') ? 'error' : 'failed', detail: `desistiu após ${attempts} tentativas: ${r.retry}` };
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
    } finally { running = false; }
    return stats;
  }
  // Retomada rápida (resposta do lead / evento novo) sem esperar o próximo ciclo.
  function kick() { if (autoKick) setImmediate(() => { tick().catch((e) => console.error('[flows] tick:', e.message)); }); }

  return { startForEvent, onInbound, tick, kick, process, runNode, loadGraph };
}
