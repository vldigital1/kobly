// Programa de afiliados da Kobly. Quem indica pelo link (app.koblay.io/?ref=CODIGO) ganha comissão recorrente sobre
// cada pagamento de plano das contas indicadas (o banco gera a comissão a cada transação paga — 0094).
// A comissão fica "pendente" por alguns dias (reembolso) e depois "disponível" para saque por Pix.
//   rota affiliates (usuário logado): me | join | update | dashboard | referrals | commissions | payouts | request_payout
//   rota affiliates-admin (Administrador): overview | settings | save_settings | orgs | campaigns | list | update | create
//                                          | payouts | mark_paid | refuse | commissions
//   público: click (POST /affiliates/click) e onSignup (cadastro pelo link → fluxo de boas-vindas)
import { createHmac } from 'node:crypto';
import { AuthError } from '../auth.js';

const UUID = /^[0-9a-f-]{36}$/i;
const CODE = /^[a-z0-9-]{3,30}$/;
const PIX = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'];
export const slugCode = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const digits = (v) => String(v || '').replace(/\D/g, '');
const num = (v) => Math.round(Number(v || 0) * 100) / 100;
// e-mail de quem foi indicado aparece pela metade para o afiliado (dado da pessoa, não dele)
export const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); if (!d) return ''; return `${u.slice(0, 2)}${'•'.repeat(Math.max(2, Math.min(6, u.length - 2)))}@${d}`; };

export function createAffiliates({ pool, secretKey = null, flows = null, siteUrl = '', now = () => new Date() }) {
  const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };
  const settings = async () => (await pool.query(`select * from public.affiliate_settings where id`)).rows[0];
  const linkOf = (code) => `${String(siteUrl || 'https://app.koblay.io').replace(/\/$/, '')}/?ref=${code}`;
  // comissão pendente cujo prazo passou vira disponível
  const settle = (affId) => pool.query(`update public.affiliate_commissions set status = 'disponivel' where status = 'pendente' and available_at <= now()${affId ? ' and affiliate_id = $1' : ''}`, affId ? [affId] : []);

  // coloca a pessoa num fluxo da conta da Kobly (lead novo ou o mesmo pelo e-mail)
  async function startWelcome(campaignField, { email, nome, whatsapp, source, code }) {
    const s = await settings();
    if (!flows || !s.platform_org_id || !s[campaignField]) return { started: false };
    const org = s.platform_org_id;
    const tel = digits(whatsapp);
    let lead = email ? (await pool.query(`select id from public.leads where organization_id = $1 and lower(email::text) = lower($2) limit 1`, [org, email])).rows[0] : null;
    if (!lead) lead = (await pool.query(`insert into public.leads (organization_id, nome, email, telefone, utm) values ($1,$2,$3,nullif($4,''),$5::jsonb) returning id`,
      [org, nome || null, email || null, tel.length >= 10 ? (tel.length <= 11 ? `55${tel}` : tel) : '', JSON.stringify({ utm_source: source, utm_campaign: code || null })])).rows[0];
    return flows.startForLead({ orgId: org, campaignId: s[campaignField], leadId: lead.id, tipo: source === 'afiliado' ? 'Cadastro pelo link de afiliado' : 'Novo afiliado' }).catch((e) => ({ started: false, reason: e.message }));
  }

  // ---- público --------------------------------------------------------------------------
  async function click({ code, ip, landing }) {
    const c = String(code || '').toLowerCase();
    if (!CODE.test(c)) return { ok: false };
    const a = (await pool.query(`select id, nome from public.affiliates where code = $1 and status = 'ativo'`, [c])).rows[0];
    if (!a) return { ok: false };
    const ipHash = ip ? createHmac('sha256', secretKey || 'kobly').update(String(ip)).digest('base64url').slice(0, 22) : null;
    const dup = ipHash ? (await pool.query(`select 1 from public.affiliate_clicks where affiliate_id = $1 and ip_hash = $2 and created_at > now() - interval '1 hour'`, [a.id, ipHash])).rowCount : 0;
    if (!dup) await pool.query(`insert into public.affiliate_clicks (affiliate_id, ip_hash, landing) values ($1,$2,$3)`, [a.id, ipHash, String(landing || '').slice(0, 300) || null]);
    return { ok: true, nome: a.nome ? String(a.nome).split(' ')[0] : null, cookie_days: (await settings()).cookie_days };
  }
  async function onSignup({ userId, email, nome, whatsapp, ref }) {
    const c = String(ref || '').toLowerCase();
    if (!userId || !CODE.test(c)) return { ok: false };
    const a = (await pool.query(`select id, auth_user_id from public.affiliates where code = $1 and status = 'ativo'`, [c])).rows[0];
    if (!a || a.auth_user_id === userId) return { ok: false }; // não indica a si mesmo
    const r = await pool.query(`insert into public.affiliate_referrals (affiliate_id, auth_user_id, email, nome, whatsapp) values ($1,$2,$3,$4,$5) on conflict (auth_user_id) do nothing returning id`,
      [a.id, userId, email || null, nome || null, digits(whatsapp) || null]);
    if (!r.rowCount) return { ok: false };
    if (digits(whatsapp)) await pool.query(`update public.profiles set celular = $2 where auth_id = $1 and celular is null`, [userId, digits(whatsapp)]).catch(() => {});
    await startWelcome('referral_campaign_id', { email, nome, whatsapp, source: 'afiliado', code: c }).catch(() => {});
    return { ok: true };
  }

  // ---- afiliado ---------------------------------------------------------------------------
  async function mine(userId) { return (await pool.query(`select * from public.affiliates where auth_user_id = $1`, [userId])).rows[0] || null; }
  const view = (a, s) => a && ({ id: a.id, code: a.code, link: linkOf(a.code), nome: a.nome, email: a.email, whatsapp: a.whatsapp, status: a.status, pct: Number(a.commission_pct ?? s.default_pct),
    pix_tipo: a.pix_tipo, pix_chave: a.pix_chave, created_at: a.created_at });
  async function balances(affId) {
    await settle(affId);
    const b = (await pool.query(`select coalesce(sum(amount) filter (where status = 'pendente'), 0)::float as pendente,
        coalesce(sum(amount) filter (where status = 'disponivel' and payout_id is null), 0)::float as disponivel,
        coalesce(sum(amount) filter (where status = 'disponivel' and payout_id is not null), 0)::float as em_saque,
        coalesce(sum(amount) filter (where status = 'paga'), 0)::float as paga,
        coalesce(sum(amount) filter (where status <> 'cancelada'), 0)::float as total
      from public.affiliate_commissions where affiliate_id = $1`, [affId])).rows[0];
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, num(v)]));
  }
  async function stats(affId) {
    const r = (await pool.query(`select
        (select count(*) from public.affiliate_clicks where affiliate_id = $1)::int as cliques,
        (select count(*) from public.affiliate_clicks where affiliate_id = $1 and created_at > now() - interval '30 days')::int as cliques_30,
        (select count(*) from public.affiliate_referrals where affiliate_id = $1)::int as cadastros,
        (select count(*) from public.affiliate_referrals where affiliate_id = $1 and created_at > now() - interval '30 days')::int as cadastros_30,
        (select count(distinct organization_id) from public.affiliate_commissions where affiliate_id = $1 and status <> 'cancelada')::int as pagantes,
        (select count(*) from public.organizations where referred_by_affiliate_id = $1 and plano_status = 'ativo')::int as ativos,
        (select coalesce(sum(amount), 0) from public.affiliate_commissions where affiliate_id = $1 and status <> 'cancelada' and created_at > now() - interval '30 days')::float as ultimos_30`, [affId])).rows[0];
    return { ...r, ultimos_30: num(r.ultimos_30) };
  }
  async function series(affId) {
    const { rows } = await pool.query(`with m as (select generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') as mes)
      select to_char(m.mes, 'YYYY-MM') as mes,
        coalesce((select sum(amount) from public.affiliate_commissions c where c.affiliate_id = $1 and c.status <> 'cancelada' and date_trunc('month', c.created_at) = m.mes), 0)::float as comissao,
        (select count(*) from public.affiliate_referrals r where r.affiliate_id = $1 and date_trunc('month', r.created_at) = m.mes)::int as cadastros,
        (select count(*) from public.affiliate_clicks k where k.affiliate_id = $1 and date_trunc('month', k.created_at) = m.mes)::int as cliques
      from m order by m.mes`, [affId]);
    return rows.map((r) => ({ ...r, comissao: num(r.comissao) }));
  }
  const commissionsOf = async (affId, limit = 50, offset = 0) => (await pool.query(`select c.id, c.base_value::float, c.pct::float, c.amount::float, c.status, c.available_at, c.created_at, c.payout_id,
      o.nome as conta, p.nome as plano
    from public.affiliate_commissions c left join public.organizations o on o.id = c.organization_id
    left join public.transactions t on t.id = c.transaction_id left join public.plans p on p.id = t.plano_id
    where c.affiliate_id = $1 order by c.created_at desc limit ${limit} offset ${offset}`, [affId])).rows;
  const payoutsOf = async (affId) => (await pool.query(`select id, amount::float, status, pix_tipo, pix_chave, note, requested_at, paid_at from public.affiliate_payouts where affiliate_id = $1 order by requested_at desc limit 100`, [affId])).rows;

  async function handle(user, body) {
    const userId = user && user.id;
    if (!userId) throw new AuthError(401, 'unauthorized', 'Entre na sua conta.');
    const s = await settings();
    const regras = { default_pct: Number(s.default_pct), min_payout: num(s.min_payout), hold_days: s.hold_days, cookie_days: s.cookie_days, terms: s.terms || null };
    const a = await mine(userId);
    const need = () => { if (!a) throw new AuthError(404, 'not_affiliate', 'Você ainda não é afiliado.'); if (a.status === 'bloqueado') throw new AuthError(403, 'blocked', 'Seu acesso de afiliado está bloqueado. Fale com o suporte.'); };
    switch (body.action) {
      case 'me': return { affiliate: view(a, s), regras, sugestao: a ? null : slugCode((user.user_metadata && user.user_metadata.nome) || String(user.email || '').split('@')[0]) || null };
      case 'join': {
        if (a) return { affiliate: view(a, s) };
        const code = slugCode(body.code);
        if (!CODE.test(code)) fail('Escolha um código de 3 a 30 letras, números ou traço (ex.: maria-silva).');
        const prof = (await pool.query(`select id, nome, email, celular from public.profiles where auth_id = $1`, [userId])).rows[0] || {};
        const whatsapp = digits(body.whatsapp) || prof.celular || null;
        let row;
        try {
          row = (await pool.query(`insert into public.affiliates (auth_user_id, profile_id, code, nome, email, whatsapp) values ($1,$2,$3,$4,$5,$6) returning *`,
            [userId, prof.id || null, code, prof.nome || (user.user_metadata && user.user_metadata.nome) || null, prof.email || user.email || null, whatsapp])).rows[0];
        } catch (e) { if (e.code === '23505') fail('Esse código já está em uso. Escolha outro.'); throw e; }
        await startWelcome('affiliate_campaign_id', { email: row.email, nome: row.nome, whatsapp: row.whatsapp, source: 'programa-afiliados', code }).catch(() => {});
        return { affiliate: view(row, s) };
      }
      case 'update': {
        need();
        const sets = [], vals = [a.id];
        const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
        if (body.pix_tipo !== undefined) { if (!PIX.includes(body.pix_tipo)) fail('Escolha o tipo da chave Pix.'); put('pix_tipo', body.pix_tipo); }
        if (body.pix_chave !== undefined) { const k = String(body.pix_chave || '').trim().slice(0, 120); if (k.length < 5) fail('Informe a chave Pix.'); put('pix_chave', k); }
        if (body.whatsapp !== undefined) put('whatsapp', digits(body.whatsapp) || null);
        if (body.code !== undefined && slugCode(body.code) !== a.code) {
          const code = slugCode(body.code);
          if (!CODE.test(code)) fail('Código inválido.');
          const used = (await pool.query(`select count(*)::int as n from public.affiliate_referrals where affiliate_id = $1`, [a.id])).rows[0].n;
          if (used) fail('Depois do primeiro cadastro o código não muda (os links já divulgados parariam de funcionar).');
          put('code', code);
        }
        if (!sets.length) fail('Nada para alterar.');
        try { const r = (await pool.query(`update public.affiliates set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, vals)).rows[0]; return { affiliate: view(r, s) }; }
        catch (e) { if (e.code === '23505') fail('Esse código já está em uso.'); throw e; }
      }
      case 'dashboard': {
        need();
        const [saldo, st, serie] = [await balances(a.id), await stats(a.id), await series(a.id)];
        return { affiliate: view(a, s), regras, saldo, stats: st, serie, recentes: await commissionsOf(a.id, 6) };
      }
      case 'referrals': {
        need();
        const { rows } = await pool.query(`select r.id, r.nome, r.email, r.created_at, o.nome as conta, o.plano_status, p.nome as plano,
            coalesce((select sum(amount) from public.affiliate_commissions c where c.affiliate_id = r.affiliate_id and c.organization_id = r.organization_id and c.status <> 'cancelada'), 0)::float as comissao,
            (select max(created_at) from public.affiliate_commissions c where c.affiliate_id = r.affiliate_id and c.organization_id = r.organization_id) as ultimo_pagamento
          from public.affiliate_referrals r left join public.organizations o on o.id = coalesce(r.organization_id, (select pr.organization_id from public.profiles pr where pr.auth_id = r.auth_user_id))
          left join public.plans p on p.id = o.plano_id
          where r.affiliate_id = $1 order by r.created_at desc limit 500`, [a.id]);
        return { referrals: rows.map((r) => ({ ...r, email: maskEmail(r.email), comissao: num(r.comissao), situacao: r.plano_status === 'ativo' ? 'cliente' : r.ultimo_pagamento ? 'cancelou' : r.conta ? 'teste' : 'cadastrado' })) };
      }
      case 'commissions': { need(); await settle(a.id); return { commissions: await commissionsOf(a.id, Math.min(200, Number(body.limit) || 100), Math.max(0, Number(body.offset) || 0)) }; }
      case 'payouts': { need(); return { payouts: await payoutsOf(a.id), saldo: await balances(a.id) }; }
      case 'request_payout': {
        need();
        if (a.status !== 'ativo') fail('Seu acesso de afiliado está pausado.');
        if (!a.pix_tipo || !a.pix_chave) fail('Cadastre sua chave Pix antes de pedir o saque.');
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [a.id]);
          await client.query(`update public.affiliate_commissions set status = 'disponivel' where affiliate_id = $1 and status = 'pendente' and available_at <= now()`, [a.id]);
          const v = num((await client.query(`select coalesce(sum(amount), 0)::float as v from public.affiliate_commissions where affiliate_id = $1 and status = 'disponivel' and payout_id is null`, [a.id])).rows[0].v);
          if (v < Number(s.min_payout)) fail(`O saque mínimo é de R$ ${Number(s.min_payout).toFixed(2).replace('.', ',')}. Você tem R$ ${v.toFixed(2).replace('.', ',')} disponível.`);
          const p = (await client.query(`insert into public.affiliate_payouts (affiliate_id, amount, pix_tipo, pix_chave) values ($1,$2,$3,$4) returning id, amount::float, status, requested_at`, [a.id, v, a.pix_tipo, a.pix_chave])).rows[0];
          await client.query(`update public.affiliate_commissions set payout_id = $2 where affiliate_id = $1 and status = 'disponivel' and payout_id is null`, [a.id, p.id]);
          await client.query('commit');
          return { payout: p };
        } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  // ---- administrador -------------------------------------------------------------------------
  async function admin(body) {
    switch (body.action) {
      case 'overview': {
        await settle(null);
        const r = (await pool.query(`select (select count(*) from public.affiliates where status = 'ativo')::int as afiliados,
            (select count(*) from public.affiliate_referrals)::int as cadastros,
            (select count(*) from public.organizations where referred_by_affiliate_id is not null and plano_status = 'ativo')::int as clientes_ativos,
            (select coalesce(sum(base_value), 0) from public.affiliate_commissions where status <> 'cancelada')::float as receita_indicada,
            (select coalesce(sum(amount), 0) from public.affiliate_commissions where status <> 'cancelada')::float as comissao_total,
            (select coalesce(sum(amount), 0) from public.affiliate_commissions where status = 'paga')::float as comissao_paga,
            (select coalesce(sum(amount), 0) from public.affiliate_payouts where status = 'solicitado')::float as saques_pendentes,
            (select count(*) from public.affiliate_payouts where status = 'solicitado')::int as saques_pendentes_n`)).rows[0];
        const serie = (await pool.query(`with m as (select generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') as mes)
          select to_char(m.mes, 'YYYY-MM') as mes,
            coalesce((select sum(base_value) from public.affiliate_commissions c where c.status <> 'cancelada' and date_trunc('month', c.created_at) = m.mes), 0)::float as receita,
            coalesce((select sum(amount) from public.affiliate_commissions c where c.status <> 'cancelada' and date_trunc('month', c.created_at) = m.mes), 0)::float as comissao
          from m order by m.mes`)).rows;
        return { ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? num(v) : v])), serie };
      }
      case 'settings': {
        const s = await settings();
        const org = s.platform_org_id ? (await pool.query(`select id, nome from public.organizations where id = $1`, [s.platform_org_id])).rows[0] : null;
        return { settings: { ...s, default_pct: Number(s.default_pct), min_payout: num(s.min_payout) }, platform_org: org || null };
      }
      case 'save_settings': {
        const sets = [], vals = [];
        const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
        if (body.default_pct !== undefined) { const v = Number(body.default_pct); if (!(v >= 0 && v <= 100)) fail('Comissão padrão de 0 a 100%.'); put('default_pct', v); }
        if (body.min_payout !== undefined) { const v = Number(body.min_payout); if (!(v >= 0 && v <= 100000)) fail('Saque mínimo inválido.'); put('min_payout', v); }
        if (body.hold_days !== undefined) { const v = Number(body.hold_days); if (!Number.isInteger(v) || v < 0 || v > 90) fail('Dias de carência de 0 a 90.'); put('hold_days', v); }
        if (body.cookie_days !== undefined) { const v = Number(body.cookie_days); if (!Number.isInteger(v) || v < 1 || v > 365) fail('Validade do link de 1 a 365 dias.'); put('cookie_days', v); }
        if (body.terms !== undefined) put('terms', String(body.terms || '').slice(0, 8000) || null);
        for (const k of ['platform_org_id', 'referral_campaign_id', 'affiliate_campaign_id']) if (body[k] !== undefined) { if (body[k] && !UUID.test(String(body[k]))) fail('Escolha inválida.'); put(k, body[k] || null); }
        if (!sets.length) fail('Nada para alterar.');
        await pool.query(`update public.affiliate_settings set ${sets.join(', ')}, updated_at = now() where id`, vals);
        return admin({ action: 'settings' });
      }
      case 'orgs': {
        const q = String(body.q || '').trim().slice(0, 60);
        return { orgs: (await pool.query(`select id, nome from public.organizations where ($1 = '' or nome ilike '%' || $1 || '%') order by nome limit 30`, [q])).rows };
      }
      case 'campaigns': {
        if (!UUID.test(String(body.org_id || ''))) return { campaigns: [] };
        return { campaigns: (await pool.query(`select c.id, c.nome, c.status_campanha as status from public.campaigns c where c.organization_id = $1
          and exists (select 1 from public.campaign_flows f join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where f.campaign_id = c.id) order by c.nome`, [body.org_id])).rows };
      }
      case 'list': {
        await settle(null);
        const q = String(body.q || '').trim().slice(0, 60);
        const s = await settings();
        const { rows } = await pool.query(`select a.*,
            (select count(*) from public.affiliate_clicks k where k.affiliate_id = a.id)::int as cliques,
            (select count(*) from public.affiliate_referrals r where r.affiliate_id = a.id)::int as cadastros,
            (select count(*) from public.organizations o where o.referred_by_affiliate_id = a.id and o.plano_status = 'ativo')::int as clientes_ativos,
            (select coalesce(sum(amount), 0) from public.affiliate_commissions c where c.affiliate_id = a.id and c.status <> 'cancelada')::float as comissao_total,
            (select coalesce(sum(amount), 0) from public.affiliate_commissions c where c.affiliate_id = a.id and c.status = 'disponivel' and c.payout_id is null)::float as disponivel,
            (select coalesce(sum(amount), 0) from public.affiliate_commissions c where c.affiliate_id = a.id and c.status = 'paga')::float as paga
          from public.affiliates a where ($1 = '' or a.nome ilike '%' || $1 || '%' or a.email ilike '%' || $1 || '%' or a.code ilike '%' || $1 || '%')
          order by comissao_total desc, a.created_at desc limit 300`, [q]);
        return { affiliates: rows.map((a) => ({ id: a.id, code: a.code, link: linkOf(a.code), nome: a.nome, email: a.email, whatsapp: a.whatsapp, status: a.status, note: a.note,
          commission_pct: a.commission_pct == null ? null : Number(a.commission_pct), pct: Number(a.commission_pct ?? s.default_pct), pix_tipo: a.pix_tipo, pix_chave: a.pix_chave, created_at: a.created_at,
          cliques: a.cliques, cadastros: a.cadastros, clientes_ativos: a.clientes_ativos, comissao_total: num(a.comissao_total), disponivel: num(a.disponivel), paga: num(a.paga) })) };
      }
      case 'update': {
        if (!UUID.test(String(body.id || ''))) fail('Afiliado inválido.');
        const sets = [], vals = [body.id];
        const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
        if (body.commission_pct !== undefined) { if (body.commission_pct === null || body.commission_pct === '') put('commission_pct', null); else { const v = Number(body.commission_pct); if (!(v >= 0 && v <= 100)) fail('Comissão de 0 a 100%.'); put('commission_pct', v); } }
        if (body.status !== undefined) { if (!['ativo', 'pausado', 'bloqueado'].includes(body.status)) fail('Situação inválida.'); put('status', body.status); }
        if (body.note !== undefined) put('note', String(body.note || '').slice(0, 1000) || null);
        if (!sets.length) fail('Nada para alterar.');
        const r = await pool.query(`update public.affiliates set ${sets.join(', ')}, updated_at = now() where id = $1 returning id`, vals);
        if (!r.rowCount) throw new AuthError(404, 'not_found', 'Afiliado não encontrado.');
        return { ok: true };
      }
      case 'create': { // o Administrador cadastra um amigo que já tem conta na Kobly
        const email = String(body.email || '').trim().toLowerCase();
        const p = (await pool.query(`select id, auth_id, nome, email, celular from public.profiles where lower(email::text) = $1`, [email])).rows[0];
        if (!p || !p.auth_id) fail('Esse e-mail ainda não tem conta na Kobly. Peça para a pessoa criar a conta primeiro.');
        const code = slugCode(body.code || p.nome || email.split('@')[0]);
        if (!CODE.test(code)) fail('Código inválido.');
        const pct = body.commission_pct === undefined || body.commission_pct === '' || body.commission_pct === null ? null : Number(body.commission_pct);
        if (pct !== null && !(pct >= 0 && pct <= 100)) fail('Comissão de 0 a 100%.');
        try {
          const r = (await pool.query(`insert into public.affiliates (auth_user_id, profile_id, code, nome, email, whatsapp, commission_pct) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
            [p.auth_id, p.id, code, p.nome, p.email, p.celular || null, pct])).rows[0];
          return { ok: true, id: r.id };
        } catch (e) { if (e.code === '23505') fail('Essa pessoa já é afiliada ou o código já está em uso.'); throw e; }
      }
      case 'payouts': {
        const st = ['solicitado', 'pago', 'recusado'].includes(body.status) ? body.status : null;
        const { rows } = await pool.query(`select p.id, p.amount::float, p.status, p.pix_tipo, p.pix_chave, p.note, p.requested_at, p.paid_at, a.nome, a.email, a.code, a.whatsapp
          from public.affiliate_payouts p join public.affiliates a on a.id = p.affiliate_id where ($1::text is null or p.status = $1) order by p.requested_at desc limit 300`, [st]);
        return { payouts: rows };
      }
      case 'mark_paid':
      case 'refuse': {
        if (!UUID.test(String(body.id || ''))) fail('Saque inválido.');
        const paid = body.action === 'mark_paid';
        const r = await pool.query(`update public.affiliate_payouts set status = $2, paid_at = case when $2 = 'pago' then now() end, note = coalesce($3, note) where id = $1 and status = 'solicitado' returning id`,
          [body.id, paid ? 'pago' : 'recusado', body.note ? String(body.note).slice(0, 500) : null]);
        if (!r.rowCount) fail('Esse saque já foi resolvido.');
        if (paid) await pool.query(`update public.affiliate_commissions set status = 'paga' where payout_id = $1`, [body.id]);
        else await pool.query(`update public.affiliate_commissions set payout_id = null where payout_id = $1`, [body.id]);
        return { ok: true };
      }
      case 'commissions': {
        const aff = UUID.test(String(body.affiliate_id || '')) ? body.affiliate_id : null;
        const { rows } = await pool.query(`select c.id, c.amount::float, c.base_value::float, c.pct::float, c.status, c.created_at, c.available_at, a.nome as afiliado, a.code, o.nome as conta
          from public.affiliate_commissions c join public.affiliates a on a.id = c.affiliate_id left join public.organizations o on o.id = c.organization_id
          where ($1::uuid is null or c.affiliate_id = $1) order by c.created_at desc limit 300`, [aff]);
        return { commissions: rows };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  return { handle, admin, click, onSignup };
}
