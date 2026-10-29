// Disparo em massa (rota bulk-send): para cada lead do público, inicia um FLUXO publicado, envia um E-MAIL
// ou uma MENSAGEM de WhatsApp. Público: filtro (todos, etiquetas, evento do checkout) ou lista colada à mão.
// Cada destinatário vira uma linha com horário próprio (ritmo por minuto) e o tick() envia os vencidos.
// Agenda: agora, uma vez (dia e hora) ou todo dia num período (no horário escolhido, só para os leads que
// entraram no público desde o último envio). Horários no fuso de São Paulo.
//   estimate | create | update | status | list | cancel | pause | resume
import { AuthError } from '../auth.js';
import { render, renderHtml } from '../flows/vars.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODOS = new Set(['fluxo', 'email', 'whatsapp']);
const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };
const digits = (v) => String(v || '').replace(/\D/g, '');
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const TZ = 'America/Sao_Paulo';
const AGENDAS = new Set(['agora', 'uma_vez', 'diario']);
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/, LOCAL = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

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

  // agenda pedida na tela → colunas do disparo (valida datas no fuso de São Paulo)
  async function parseAgenda(body, origem) {
    const agenda = AGENDAS.has(body.agenda) ? body.agenda : 'agora';
    if (agenda === 'agora') return { agenda, start_at: null, end_date: null, send_time: null, next_run_at: null };
    if (agenda === 'uma_vez') {
      if (!LOCAL.test(String(body.start_at || ''))) fail('Escolha o dia e a hora do disparo.');
      const r = (await pool.query(`select ($1::timestamp at time zone '${TZ}') as t, ($1::timestamp at time zone '${TZ}') > now() as futuro,
          ($1::timestamp at time zone '${TZ}') < now() + interval '366 days' as perto`, [body.start_at])).rows[0];
      if (!r.futuro) fail('Esse horário já passou. Escolha um horário no futuro.');
      if (!r.perto) fail('Agende para no máximo 1 ano à frente.');
      return { agenda, start_at: r.t, end_date: null, send_time: null, next_run_at: r.t };
    }
    if (origem === 'manual') fail('A repetição diária funciona com público por filtro (etiquetas ou evento). Para lista colada, use "Uma vez".');
    if (!DATE.test(String(body.start_date || '')) || !DATE.test(String(body.end_date || ''))) fail('Escolha o primeiro e o último dia.');
    if (!TIME.test(String(body.send_time || ''))) fail('Escolha o horário do disparo.');
    if (body.end_date < body.start_date) fail('O último dia precisa ser depois do primeiro.');
    const r = (await pool.query(`select ($1::date - $2::date) as dias, ($2::date + $3::time) at time zone '${TZ}' as inicio`, [body.end_date, body.start_date, body.send_time])).rows[0];
    if (r.dias > 366) fail('O período pode ter no máximo 1 ano.');
    const next = await nextDaily(body.start_date, body.end_date, body.send_time);
    if (!next) fail('Todos os horários desse período já passaram.');
    return { agenda, start_at: r.inicio, end_date: body.end_date, send_time: body.send_time, next_run_at: next };
  }
  // próximo horário do diário que ainda não passou e ainda não saiu (dia N+1 depois de N envios; null = acabou o período)
  async function nextDaily(startDate, endDate, time, runs = 0) {
    const r = (await pool.query(`select (d::date + $3::time) at time zone '${TZ}' as t
      from generate_series(greatest($1::date + $4::int, (now() at time zone '${TZ}')::date - 1), $2::date, interval '1 day') d
      where (d::date + $3::time) at time zone '${TZ}' > now() order by 1 limit 1`, [startDate, endDate, time, runs])).rows[0];
    return r ? r.t : null;
  }
  const localDate = async (ts) => (ts ? (await pool.query(`select to_char($1::timestamptz at time zone '${TZ}', 'YYYY-MM-DD') as d`, [ts])).rows[0].d : null);

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
            b.agenda, b.start_at, b.end_date::text as end_date, to_char(b.send_time, 'HH24:MI') as send_time, b.next_run_at, b.last_run_at, b.runs,
            to_char(b.start_at at time zone '${TZ}', 'YYYY-MM-DD') as start_date, to_char(b.start_at at time zone '${TZ}', 'YYYY-MM-DD"T"HH24:MI') as start_local,
            b.campaign_id, b.email_id, b.texto, b.filtro,
            c.nome as fluxo_nome, e.titulo as email_titulo
          from public.bulk_sends b left join public.campaigns c on c.id = b.campaign_id left join public.emails e on e.id = b.email_id
          where b.organization_id = $1 order by (b.status in ('agendado','pausado','enviando')) desc, coalesce(b.next_run_at, b.created_at) desc limit 100`, [orgId]);
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
        const b = (await pool.query(`select id, status, total, enviados, falhados, pulados, finished_at, agenda, next_run_at, runs from public.bulk_sends where id = $1 and organization_id = $2`, [body.id, orgId])).rows[0];
        if (!b) throw new AuthError(404, 'not_found', 'Disparo não encontrado.');
        return b;
      }
      case 'cancel': {
        editor(ctx);
        if (!UUID.test(String(body.id || ''))) fail('Disparo inválido.');
        const r = await pool.query(`update public.bulk_sends set status = 'cancelado', finished_at = now(), next_run_at = null where id = $1 and organization_id = $2 and status in ('enviando','enfileirando','agendado','pausado') returning id`, [body.id, orgId]);
        if (r.rowCount) {
          const p = await pool.query(`update public.bulk_send_recipients set status = 'pulado', last_error = 'disparo cancelado' where bulk_send_id = $1 and status = 'pendente'`, [body.id]);
          await pool.query(`update public.bulk_sends set pulados = pulados + $2 where id = $1`, [body.id, p.rowCount]);
        }
        return { ok: true };
      }
      case 'pause': {
        editor(ctx);
        if (!UUID.test(String(body.id || ''))) fail('Disparo inválido.');
        const r = await pool.query(`update public.bulk_sends set status = 'pausado' where id = $1 and organization_id = $2 and status in ('agendado','enviando') returning id`, [body.id, orgId]);
        if (!r.rowCount) fail('Esse disparo não pode ser pausado agora.');
        return { ok: true };
      }
      case 'resume': {
        editor(ctx);
        if (!UUID.test(String(body.id || ''))) fail('Disparo inválido.');
        const b = (await pool.query(`select * from public.bulk_sends where id = $1 and organization_id = $2 and status = 'pausado'`, [body.id, orgId])).rows[0];
        if (!b) fail('Esse disparo não está pausado.');
        const pend = (await pool.query(`select count(*)::int as n from public.bulk_send_recipients where bulk_send_id = $1 and status = 'pendente'`, [b.id])).rows[0].n;
        if (b.agenda !== 'agora' && b.runs === 0) { // ainda não saiu: volta a esperar o horário (ou sai já, se o horário passou)
          const next = b.agenda === 'diario' ? await nextDaily(await localDate(b.start_at), b.end_date, b.send_time) : b.next_run_at;
          if (b.agenda === 'diario' && !next) { await pool.query(`update public.bulk_sends set status = 'concluido', next_run_at = null, finished_at = now() where id = $1`, [b.id]); return { ok: true, status: 'concluido' }; }
          await pool.query(`update public.bulk_sends set status = 'agendado', next_run_at = greatest($2::timestamptz, now()) where id = $1`, [b.id, next]);
          if (pend) await respace(b.id, b.rate_por_min, 'greatest($3::timestamptz, now())', [next]);
          return { ok: true, status: 'agendado' };
        }
        if (pend) { // continua de onde parou, no mesmo ritmo
          await respace(b.id, b.rate_por_min, 'now()');
          await pool.query(`update public.bulk_sends set status = 'enviando' where id = $1`, [b.id]);
          return { ok: true, status: 'enviando' };
        }
        const next = b.agenda === 'diario' ? await nextDaily(await localDate(b.start_at), b.end_date, b.send_time, b.runs) : null;
        await pool.query(`update public.bulk_sends set status = $2, next_run_at = $3, finished_at = case when $2 = 'concluido' then now() else finished_at end where id = $1`, [b.id, next ? 'agendado' : 'concluido', next]);
        return { ok: true, status: next ? 'agendado' : 'concluido' };
      }
      case 'update': { // editar um disparo que ainda vai sair (agendado ou pausado)
        editor(ctx);
        if (!UUID.test(String(body.id || ''))) fail('Disparo inválido.');
        const b = (await pool.query(`select * from public.bulk_sends where id = $1 and organization_id = $2`, [body.id, orgId])).rows[0];
        if (!b) throw new AuthError(404, 'not_found', 'Disparo não encontrado.');
        if (!['agendado', 'pausado'].includes(b.status)) fail('Só dá para editar disparos agendados ou pausados.');
        if (b.agenda === 'agora') fail('Esse disparo já saiu.');
        await checkContent(orgId, body, b.modo);
        const ag = await parseAgenda({ ...body, agenda: body.agenda || b.agenda }, b.origem);
        if (ag.agenda === 'agora') fail('Escolha uma data para o disparo.');
        const rate = Math.min(600, Math.max(1, Math.round(Number(body.rate_por_min) || b.rate_por_min)));
        const nome = String(body.nome || '').trim().slice(0, 120) || b.nome;
        await pool.query(`update public.bulk_sends set nome = $2, campaign_id = $3, email_id = $4, texto = $5, filtro = $6::jsonb, rate_por_min = $7,
            agenda = $8, start_at = $9, end_date = $10, send_time = $11, next_run_at = $12, status = case when status = 'pausado' then 'pausado' else 'agendado' end where id = $1`,
          [b.id, nome, b.modo === 'fluxo' ? body.campaign_id : null, b.modo === 'email' ? body.email_id : null, b.modo === 'whatsapp' ? String(body.texto).trim() : null,
            JSON.stringify(b.origem === 'manual' ? {} : (body.filtro || b.filtro || {})), rate, ag.agenda, ag.start_at, ag.end_date, ag.send_time, ag.next_run_at]);
        if (b.origem === 'manual' && b.runs === 0) await respace(b.id, rate, '$3::timestamptz', [ag.next_run_at]);
        return { ok: true };
      }
      case 'create': {
        editor(ctx);
        const modo = MODOS.has(body.modo) ? body.modo : fail('Escolha o que vai ser disparado.');
        await checkContent(orgId, body, modo);
        const rate = Math.min(600, Math.max(1, Math.round(Number(body.rate_por_min) || 30)));
        const ag = await parseAgenda(body, body.origem === 'manual' ? 'manual' : 'filtro');
        if (ag.agenda !== 'agora' && body.origem !== 'manual') { // o público é montado na hora de sair (pega quem chegar até lá)
          const nome = String(body.nome || '').trim().slice(0, 120) || 'Disparo agendado';
          const b = (await pool.query(`insert into public.bulk_sends (organization_id, canal, modo, origem, nome, campaign_id, email_id, texto, filtro, status, total, rate_por_min, created_by,
              agenda, start_at, end_date, send_time, next_run_at)
            values ($1, $2, $3, 'filtro', $4, $5, $6, $7, $8::jsonb, 'agendado', 0, $9, (select id from public.profiles where auth_id = $10 limit 1), $11, $12, $13, $14, $15) returning id`,
            [orgId, modo === 'email' ? 'email' : 'Whatsapp', modo, nome, modo === 'fluxo' ? body.campaign_id : null, modo === 'email' ? body.email_id : null,
              modo === 'whatsapp' ? String(body.texto).trim() : null, JSON.stringify(body.filtro || {}), rate, user && user.id, ag.agenda, ag.start_at, ag.end_date, ag.send_time, ag.next_run_at])).rows[0];
          return { ok: true, id: b.id, total: 0, agendado: true, next_run_at: ag.next_run_at };
        }
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
        const agendado = ag.agenda === 'uma_vez'; // lista colada agendada: a fila já fica pronta para o horário
        const b = (await pool.query(`insert into public.bulk_sends (organization_id, canal, modo, origem, nome, campaign_id, email_id, texto, filtro, status, total, rate_por_min, created_by,
            agenda, start_at, next_run_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $13, $10, $11, (select id from public.profiles where auth_id = $12 limit 1), $14, $15, $15) returning id`,
          [orgId, modo === 'email' ? 'email' : 'Whatsapp', modo, body.origem === 'manual' ? 'manual' : 'filtro', nome,
            modo === 'fluxo' ? body.campaign_id : null, modo === 'email' ? body.email_id : null, modo === 'whatsapp' ? String(body.texto).trim() : null,
            JSON.stringify(body.origem === 'manual' ? {} : (body.filtro || {})), leadIds.length, rate, user && user.id, agendado ? 'agendado' : 'enviando', ag.agenda, ag.start_at])).rows[0];
        // um destinatário a cada 60/ritmo segundos
        await pool.query(`insert into public.bulk_send_recipients (bulk_send_id, organization_id, lead_id, run_at)
          select $1, $2, x.id, coalesce($5::timestamptz, now()) + make_interval(secs => (x.n - 1) * 60.0 / $4)
            from unnest($3::uuid[]) with ordinality as x(id, n) on conflict do nothing`, [b.id, orgId, leadIds, rate, agendado ? ag.start_at : null]);
        return { ok: true, id: b.id, total: leadIds.length, agendado, next_run_at: ag.next_run_at };
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

  // fila pendente de novo no ritmo, a partir de um horário (pausa/edição)
  async function respace(id, rate, fromSql, extra = []) {
    await pool.query(`update public.bulk_send_recipients r set run_at = ${fromSql} + make_interval(secs => (x.n - 1) * 60.0 / $2)
      from (select id, row_number() over (order by run_at, id) as n from public.bulk_send_recipients where bulk_send_id = $1 and status = 'pendente') x
      where r.id = x.id`, [id, rate, ...extra]);
  }

  // disparos agendados que chegaram na hora: monta a fila com o público de agora (no diário, só quem ainda não recebeu)
  async function schedule(limit = 5) {
    const { rows } = await pool.query(`update public.bulk_sends b set status = 'enviando', last_run_at = now(), runs = runs + 1
      where b.id in (select id from public.bulk_sends where status = 'agendado' and next_run_at <= now() order by next_run_at limit $1 for update skip locked)
      returning b.*`, [limit]);
    for (const b of rows) {
      let added = 0;
      if (b.origem === 'filtro') {
        const a = audienceSql(b.modo, b.filtro || {});
        const n = a.params.length + 2;
        const ids = (await pool.query(`select l.id ${a.sql} and not exists (select 1 from public.bulk_send_recipients r where r.bulk_send_id = $${n} and r.lead_id = l.id) order by l.created_at limit 50000`,
          [b.organization_id, ...a.params, b.id])).rows.map((r) => r.id);
        if (ids.length) {
          added = (await pool.query(`insert into public.bulk_send_recipients (bulk_send_id, organization_id, lead_id, run_at)
            select $1, $2, x.id, now() + make_interval(secs => (x.n - 1) * 60.0 / $4) from unnest($3::uuid[]) with ordinality as x(id, n) on conflict do nothing`,
          [b.id, b.organization_id, ids, b.rate_por_min])).rowCount;
        }
      }
      const next = b.agenda === 'diario' ? await nextDaily(await localDate(b.start_at), b.end_date, b.send_time, b.runs) : null;
      await pool.query(`update public.bulk_sends set total = total + $2, next_run_at = $3 where id = $1`, [b.id, added, next]);
      // ninguém novo hoje: já volta a esperar o próximo dia (ou termina)
      await pool.query(`update public.bulk_sends b set status = case when next_run_at is not null then 'agendado' else 'concluido' end,
          finished_at = case when next_run_at is null then now() else finished_at end
        where id = $1 and status = 'enviando' and not exists (select 1 from public.bulk_send_recipients r where r.bulk_send_id = b.id and r.status in ('pendente','processando'))`, [b.id]);
    }
    return rows.length;
  }

  // envia os destinatários vencidos (chamado a cada poucos segundos)
  async function tick(limit = 25) {
    await schedule();
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
      await pool.query(`update public.bulk_sends b set status = case when next_run_at is not null then 'agendado' else 'concluido' end,
          finished_at = case when next_run_at is null then now() else finished_at end where id = $1 and status = 'enviando'
        and not exists (select 1 from public.bulk_send_recipients r where r.bulk_send_id = b.id and r.status in ('pendente','processando'))`, [id]);
    }
    return { sent: rows.length };
  }

  return { handle, tick, schedule };
}
