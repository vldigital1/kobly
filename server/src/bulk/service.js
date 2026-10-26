// Disparo em massa (rota bulk-send): para cada lead do público, inicia um FLUXO publicado, envia um E-MAIL
// ou uma MENSAGEM de WhatsApp. Público: filtro (todos, etiquetas, evento do checkout) ou lista colada à mão.
// Cada destinatário vira uma linha com horário próprio (ritmo por minuto) e o tick() envia os vencidos.
//   estimate | create | status | list | cancel
import { AuthError } from '../auth.js';
import { render, renderHtml } from '../flows/vars.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODOS = new Set(['fluxo', 'email', 'whatsapp']);
const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };
const digits = (v) => String(v || '').replace(/\D/g, '');
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// Lista colada: uma pessoa por linha, separada por vírgula, ponto e vírgula ou tab, em qualquer ordem.
// Reconhece o e-mail (tem @), o telefone (8+ dígitos; sem DDI e com 10–11 dígitos vira +55) e o resto é o nome.
export function parseManualList(text) {
  const out = [], seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const parts = raw.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    let nome = '', telefone = '', email = '';
    for (const p of parts) {
      if (!email && EMAIL.test(p)) email = p.toLowerCase();
      else if (!telefone && digits(p).length >= 8 && /^[+\d\s().-]+$/.test(p)) { const d = digits(p); telefone = d.length === 10 || d.length === 11 ? `55${d}` : d; }
      else if (!nome) nome = p.slice(0, 120);
    }
    if (!telefone && !email) continue;
    const key = telefone || email;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ nome, telefone, email });
    if (out.length >= 5000) break;
  }
  return out;
}

export function createBulk({ pool, whatsapp, email, flows }) {
  const editor = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode disparar mensagens.'); };

  // público por filtro: leads da empresa que têm o canal do disparo
  function audienceSql(modo, filtro) {
    const where = ['l.organization_id = $1'], params = [];
    const p = (v) => { params.push(v); return `$${params.length + 1}`; };
    if (modo === 'email') where.push(`l.email is not null and l.email::text <> ''`);
    else where.push(`coalesce(l.telefone, '') <> ''`, 'not coalesce(l.whatsapp_opt_out, false)');
    const tags = (filtro.tag_ids || []).filter((t) => UUID.test(String(t)));
    if (tags.length) where.push(`exists (select 1 from public.lead_tags lt where lt.lead_id = l.id and lt.tag_id = any(${p(tags)}::uuid[]))`);
    if (filtro.evento) where.push(`exists (select 1 from public.webhook_events w where w.lead_id = l.id and w.tipo_evento = ${p(String(filtro.evento))})`);
    return { sql: `from public.leads l where ${where.join(' and ')}`, params };
  }

  // lista colada: acha o lead pelo telefone ou e-mail; se não existir, cria
  async function upsertManual(orgId, people) {
    const ids = [];
    for (const x of people) {
      let row = null;
      if (x.telefone) row = (await pool.query(`select id from public.leads where organization_id = $1 and regexp_replace(coalesce(telefone,''), '\\D', '', 'g') = $2 limit 1`, [orgId, x.telefone])).rows[0];
      if (!row && x.email) row = (await pool.query(`select id from public.leads where organization_id = $1 and lower(email::text) = $2 limit 1`, [orgId, x.email])).rows[0];
      if (!row) row = (await pool.query(`insert into public.leads (organization_id, nome, telefone, email) values ($1, $2, nullif($3,''), nullif($4,'')) returning id`, [orgId, x.nome || null, x.telefone, x.email])).rows[0];
      ids.push(row.id);
    }
    return ids;
  }

  async function checkContent(orgId, body, modo) {
    if (modo === 'fluxo') {
      if (!UUID.test(String(body.campaign_id || ''))) fail('Escolha o fluxo que vai ser disparado.');
      const ok = (await pool.query(`select 1 from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
        join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where c.id = $1 and c.organization_id = $2`, [body.campaign_id, orgId])).rowCount;
      if (!ok) fail('Esse fluxo ainda não foi publicado. Publique no editor antes de disparar.');
    } else if (modo === 'email') {
      if (!UUID.test(String(body.email_id || ''))) fail('Escolha o e-mail que vai ser enviado.');
      if (!(await pool.query(`select 1 from public.emails where id = $1 and organization_id = $2`, [body.email_id, orgId])).rowCount) fail('E-mail não encontrado.');
    } else {
      const t = String(body.texto || '').trim();
      if (!t) fail('Escreva a mensagem.');
      if (t.length > 4096) fail('A mensagem passa de 4096 caracteres.');
    }
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'list': {
        const { rows } = await pool.query(`select b.id, b.nome, b.modo, b.origem, b.status, b.total, b.enviados, b.falhados, b.pulados, b.rate_por_min, b.created_at, b.finished_at,
            c.nome as fluxo_nome, e.titulo as email_titulo
          from public.bulk_sends b left join public.campaigns c on c.id = b.campaign_id left join public.emails e on e.id = b.email_id
          where b.organization_id = $1 order by b.created_at desc limit 30`, [orgId]);
        return { sends: rows };
      }
      case 'estimate': {
        const modo = MODOS.has(body.modo) ? body.modo : 'whatsapp';
        if (body.origem === 'manual') {
          const people = parseManualList(body.lista);
          return { total: people.filter((x) => (modo === 'email' ? x.email : x.telefone)).length, lidos: people.length };
        }
        const a = audienceSql(modo, body.filtro || {});
        return { total: (await pool.query(`select count(*)::int as n ${a.sql}`, [orgId, ...a.params])).rows[0].n };
      }
      case 'status': {
        if (!UUID.test(String(body.id || ''))) fail('Disparo inválido.');
        const b = (await pool.query(`select id, status, total, enviados, falhados, pulados, finished_at from public.bulk_sends where id = $1 and organization_id = $2`, [body.id, orgId])).rows[0];
        if (!b) throw new AuthError(404, 'not_found', 'Disparo não encontrado.');
        return b;
      }
      case 'cancel': {
        editor(ctx);
        if (!UUID.test(String(body.id || ''))) fail('Disparo inválido.');
        const r = await pool.query(`update public.bulk_sends set status = 'cancelado', finished_at = now() where id = $1 and organization_id = $2 and status in ('enviando','enfileirando') returning id`, [body.id, orgId]);
        if (r.rowCount) {
          const p = await pool.query(`update public.bulk_send_recipients set status = 'pulado', last_error = 'disparo cancelado' where bulk_send_id = $1 and status = 'pendente'`, [body.id]);
          await pool.query(`update public.bulk_sends set pulados = pulados + $2 where id = $1`, [body.id, p.rowCount]);
        }
        return { ok: true };
      }
      case 'create': {
        editor(ctx);
        const modo = MODOS.has(body.modo) ? body.modo : fail('Escolha o que vai ser disparado.');
        await checkContent(orgId, body, modo);
        const rate = Math.min(600, Math.max(1, Math.round(Number(body.rate_por_min) || 30)));
        let leadIds;
        if (body.origem === 'manual') {
          const people = parseManualList(body.lista).filter((x) => (modo === 'email' ? x.email : x.telefone));
          if (!people.length) fail(modo === 'email' ? 'A lista não tem nenhum e-mail válido.' : 'A lista não tem nenhum telefone válido.');
          leadIds = await upsertManual(orgId, people);
        } else {
          const a = audienceSql(modo, body.filtro || {});
          leadIds = (await pool.query(`select l.id ${a.sql} limit 50000`, [orgId, ...a.params])).rows.map((r) => r.id);
        }
        if (!leadIds.length) fail('Nenhum lead nesse público.');
        const nome = String(body.nome || '').trim().slice(0, 120) || `Disparo de ${new Date().toLocaleDateString('pt-BR')}`;
        const b = (await pool.query(`insert into public.bulk_sends (organization_id, canal, modo, origem, nome, campaign_id, email_id, texto, filtro, status, total, rate_por_min, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'enviando', $10, $11, (select id from public.profiles where auth_id = $12 limit 1)) returning id`,
          [orgId, modo === 'email' ? 'email' : 'Whatsapp', modo, body.origem === 'manual' ? 'manual' : 'filtro', nome,
            modo === 'fluxo' ? body.campaign_id : null, modo === 'email' ? body.email_id : null, modo === 'whatsapp' ? String(body.texto).trim() : null,
            JSON.stringify(body.origem === 'manual' ? {} : (body.filtro || {})), leadIds.length, rate, user && user.id])).rows[0];
        // um destinatário a cada 60/ritmo segundos
        await pool.query(`insert into public.bulk_send_recipients (bulk_send_id, organization_id, lead_id, run_at)
          select $1, $2, x.id, now() + make_interval(secs => (x.n - 1) * 60.0 / $4)
            from unnest($3::uuid[]) with ordinality as x(id, n) on conflict do nothing`, [b.id, orgId, leadIds, rate]);
        return { ok: true, id: b.id, total: leadIds.length };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  async function sendOne(job, lead) {
    if (job.modo === 'fluxo') {
      const r = await flows.startForLead({ orgId: job.organization_id, campaignId: job.campaign_id, leadId: lead.id, tipo: 'Disparo em massa' });
      return r.started ? { ok: true } : { skip: r.reason || 'já está no fluxo' };
    }
    const ctx = { lead, vars: {}, agora: new Date(), evento: {} };
    if (job.modo === 'whatsapp') {
      if (lead.whatsapp_opt_out) return { skip: 'pediu para não receber WhatsApp' };
      const out = await whatsapp.sendTextTo(job.organization_id, { to: lead.telefone, text: render(job.texto, ctx) });
      return { ok: true, id: out && out.id };
    }
    const em = (await pool.query(`select assunto, corpo_html, remetente from public.emails where id = $1`, [job.email_id])).rows[0];
    if (!em) return { fail: 'e-mail apagado' };
    const out = await email.send(job.organization_id, { to: lead.email, subject: render(em.assunto || '', ctx), html: renderHtml(em.corpo_html || '', { ...ctx, ctaLink: lead.link_recuperacao || '#' }), fromName: em.remetente });
    return out.skipped ? { skip: out.skipped } : { ok: true, id: out.id };
  }

  // envia os destinatários vencidos (chamado a cada poucos segundos)
  async function tick(limit = 25) {
    const { rows } = await pool.query(`update public.bulk_send_recipients r set status = 'processando', attempts = attempts + 1
      where r.id in (select r2.id from public.bulk_send_recipients r2 join public.bulk_sends b on b.id = r2.bulk_send_id
        where r2.status = 'pendente' and r2.run_at <= now() and b.status = 'enviando' order by r2.run_at limit $1 for update of r2 skip locked)
      returning r.*`, [limit]);
    const touched = new Set();
    for (const r of rows) {
      touched.add(r.bulk_send_id);
      const job = (await pool.query(`select * from public.bulk_sends where id = $1`, [r.bulk_send_id])).rows[0];
      const lead = (await pool.query(`select * from public.leads where id = $1`, [r.lead_id])).rows[0];
      let res;
      try { res = lead ? await sendOne(job, lead) : { skip: 'lead apagado' }; }
      catch (e) { res = { fail: String(e.message || e).slice(0, 200), retry: !e.fatal && r.attempts < 3 && (e.status === undefined || e.status >= 500 || e.status === 429) }; }
      if (res.retry) { await pool.query(`update public.bulk_send_recipients set status = 'pendente', run_at = now() + interval '2 minutes', last_error = $2 where id = $1`, [r.id, res.fail]); continue; }
      const st = res.ok ? 'enviado' : res.skip ? 'pulado' : 'falhou';
      await pool.query(`update public.bulk_send_recipients set status = $2, last_error = $3, sg_message_id = $4, sent_at = case when $2 = 'enviado' then now() else sent_at end where id = $1`,
        [r.id, st, res.skip || res.fail || null, res.id || null]);
      const col = st === 'enviado' ? 'enviados' : st === 'pulado' ? 'pulados' : 'falhados';
      await pool.query(`update public.bulk_sends set ${col} = ${col} + 1 where id = $1`, [r.bulk_send_id]);
    }
    for (const id of touched) {
      await pool.query(`update public.bulk_sends b set status = 'concluido', finished_at = now() where id = $1 and status = 'enviando'
        and not exists (select 1 from public.bulk_send_recipients r where r.bulk_send_id = b.id and r.status in ('pendente','processando'))`, [id]);
    }
    return { sent: rows.length };
  }

  return { handle, tick };
}
