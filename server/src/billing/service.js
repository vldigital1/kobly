// Planos e cobrança da Kobly pelo Asaas: assinatura automática por Pix ou cartão, upgrade pagando só a diferença,
// redução na próxima renovação, faturas e o aviso de pagamento (webhook). Cada pagamento confirmado grava em
// transactions (histórico e comissão dos afiliados). Também diz o que cada conta pode usar (conexões e recursos).
//   rota billing (dono da conta): catalog | status | quote | subscribe | invoice | upgrade | downgrade | cancel_downgrade | change_card | use_pix
//   rota billing-admin (Administrador): overview | list | orgs | set_cortesia | cancel
//   POST /webhooks/asaas (cabeçalho asaas-access-token)
// O cartão nunca é guardado: vai direto ao Asaas, que devolve um token (cifrado aqui) para as próximas cobranças.
import { timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';
import { PLANS, CYCLES, catalog, priceOf, monthly, proration, isAgency, connectionsOf } from './pricing.js';

const UUID = /^[0-9a-f-]{36}$/i;
const GRACE_DAYS = 5; // dias de tolerância depois do vencimento antes de travar
const FEATURE_LABEL = { canais: 'WhatsApp API oficial, Instagram e Messenger', ia: 'Agente de IA e voz', anuncios: 'Gestor de anúncios', disparo: 'Disparo em massa', cobranca: 'Cobrança no fluxo' };
const digits = (v) => String(v || '').replace(/\D/g, '');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const today = (now) => new Date(now).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);
function addCycle(from, cycle) { const d = new Date(from); d.setMonth(d.getMonth() + CYCLES[cycle].meses); return d; }
// CPF ou CNPJ (também o CNPJ com letras de 2026); mesmo cálculo de src/lib/documento.js e do banco
export const normDoc = (v) => String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
export function validDocument(v) {
  const c = normDoc(v);
  if (c.length === 11) {
    if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
    const dv = (base) => { let s = 0; for (let i = 0; i < base.length; i++) s += Number(base[i]) * (base.length + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    const d1 = dv(c.slice(0, 9)); return c.slice(9) === `${d1}${dv(c.slice(0, 9) + d1)}`;
  }
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const dv = (base) => { let s = 0, w = 2; for (let i = base.length - 1; i >= 0; i--) { s += (base.charCodeAt(i) - 48) * w; w = w === 9 ? 2 : w + 1; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(c.slice(0, 12)); return c.slice(12) === `${d1}${dv(c.slice(0, 12) + d1)}`;
}

export function createBilling({ pool, secretKey, fetchImpl = globalThis.fetch, apiKey = '', env = 'sandbox', webhookToken = '', now = () => new Date() }) {
  const base = env === 'production' ? 'https://api.asaas.com/v3' : 'https://sandbox.asaas.com/api/v3';
  const configured = () => !!apiKey;
  const fail = (m, code = 'validation_failed') => { throw new AuthError(422, code, m); };

  async function asaas(path, method = 'GET', body) {
    if (!apiKey) throw new AuthError(503, 'billing_off', 'A cobrança ainda não foi ativada no servidor da Kobly.');
    let res;
    try { res = await fetchImpl(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', access_token: apiKey, 'User-Agent': 'Kobly' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) }); }
    catch { throw new AuthError(502, 'asaas_unreachable', 'O sistema de pagamento não respondeu. Tente de novo em instantes.'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (j.errors && j.errors[0] && j.errors[0].description) || `Erro ${res.status} no pagamento`;
      throw new AuthError(res.status === 400 ? 422 : 502, 'asaas_error', msg);
    }
    return j;
  }

  // ---- o que a conta pode usar ----------------------------------------------------------------
  const subOf = async (orgId) => (await pool.query(`select * from public.subscriptions where organization_id = $1`, [orgId])).rows[0] || null;
  const live = (s) => s && (s.status === 'cortesia' ? (!s.current_period_end || new Date(s.current_period_end) > now())
    : ['ativa', 'inadimplente'].includes(s.status) && s.current_period_end && addDays(s.current_period_end, GRACE_DAYS) > now());
  async function entitlement(orgId) {
    const s = await subOf(orgId);
    if (live(s) && !isAgency(s.plan_code)) {
      return { plan: s.plan_code, nome: PLANS[s.plan_code].nome, connections: s.connections, features: PLANS[s.plan_code].features, source: s.status === 'cortesia' ? 'cortesia' : 'assinatura' };
    }
    // conta de cliente de uma agência: PRO com 1 conexão, dentro do limite do pacote
    const ag = (await pool.query(`select s.*, m.organization_id as cliente,
        (select count(*) from public.organization_memberships m2 join public.profiles p2 on p2.id = m2.profile_id
          where p2.organization_id = s.organization_id and m2.organization_id <> s.organization_id and m2.created_at <= m.created_at)::int as posicao
      from public.organization_memberships m join public.profiles p on p.id = m.profile_id join public.subscriptions s on s.organization_id = p.organization_id
      where m.organization_id = $1 and s.organization_id <> $1 and s.plan_code like 'agencia%' order by m.created_at limit 1`, [orgId])).rows[0];
    if (ag && live(ag) && ag.posicao <= PLANS[ag.plan_code].accounts) return { plan: 'pro', nome: `PRO (via ${PLANS[ag.plan_code].nome})`, connections: 1, features: PLANS.pro.features, source: 'agencia' };
    if (live(s) && isAgency(s.plan_code)) return { plan: s.plan_code, nome: PLANS[s.plan_code].nome, connections: 0, features: PLANS[s.plan_code].features, source: 'assinatura', accounts: PLANS[s.plan_code].accounts };
    return { plan: null, nome: 'Sem plano', connections: 0, features: [], source: null };
  }
  async function usage(orgId) {
    const r = (await pool.query(`select (select count(*) from public.whatsapp_uazapi_instances where organization_id = $1)::int as qr,
        (select count(*) from public.whatsapp_accounts where organization_id = $1 and status = 'connected')::int as oficial,
        (select count(*) from public.meta_channels where organization_id = $1)::int as meta`, [orgId])).rows[0];
    return { ...r, total: r.qr + r.oficial + r.meta };
  }
  // trava: recurso do plano e vaga de conexão (o Administrador da Kobly não é travado)
  async function requireFeature(orgId, feature, role) {
    if (role === 'Administrador') return;
    const e = await entitlement(orgId);
    if (!e.plan) throw new AuthError(402, 'no_plan', 'Assine um plano em Planos & cobrança para usar a Kobly.');
    if (!e.features.includes(feature)) throw new AuthError(402, 'plan_feature', `${FEATURE_LABEL[feature] || 'Esse recurso'} faz parte do plano PRO. Faça o upgrade em Planos & cobrança.`);
  }
  async function requireSlots(orgId, n = 1, role) {
    if (role === 'Administrador') return;
    const e = await entitlement(orgId);
    if (!e.plan) throw new AuthError(402, 'no_plan', 'Assine um plano em Planos & cobrança para conectar.');
    const u = await usage(orgId);
    if (u.total + n > e.connections) throw new AuthError(402, 'plan_connections', `Seu plano tem ${e.connections} conexão(ões) e você já usa ${u.total}. Contrate mais conexões em Planos & cobrança.`);
  }

  // ---- Asaas: cliente, assinatura, faturas ------------------------------------------------------
  async function customerFor(orgId, user) {
    const o = (await pool.query(`select id, nome, documento, asaas_customer_id from public.organizations where id = $1`, [orgId])).rows[0];
    if (!o) throw new AuthError(404, 'not_found', 'Conta não encontrada.');
    if (!validDocument(o.documento)) fail('Informe um CPF ou CNPJ válido para a nota da cobrança.', 'documento_ausente');
    if (o.asaas_customer_id) return o;
    const email = (user && user.email) || (await pool.query(`select email from public.profiles where organization_id = $1 order by created_at limit 1`, [orgId])).rows[0]?.email;
    const c = await asaas('/customers', 'POST', { name: o.nome, cpfCnpj: normDoc(o.documento), email: email || undefined, externalReference: orgId, notificationDisabled: false });
    await pool.query(`update public.organizations set asaas_customer_id = $2 where id = $1`, [orgId, c.id]);
    return { ...o, asaas_customer_id: c.id };
  }
  function cardPayload(body, user) {
    const c = body.card || {}, h = body.holder || {};
    const [mm, yy] = String(c.expiry || '').split('/').map((x) => x.trim());
    if (!c.holder || digits(c.number).length < 13 || !mm || !yy || digits(c.ccv).length < 3) fail('Confira os dados do cartão.');
    if (!validDocument(h.cpfCnpj) || digits(h.postalCode).length !== 8 || !h.addressNumber || digits(h.phone).length < 10) fail('Confira CPF/CNPJ, CEP, número e telefone do titular do cartão.');
    return {
      creditCard: { holderName: String(c.holder).slice(0, 100), number: digits(c.number), expiryMonth: mm.padStart(2, '0'), expiryYear: yy.length === 2 ? `20${yy}` : yy, ccv: digits(c.ccv) },
      creditCardHolderInfo: { name: String(c.holder).slice(0, 100), email: h.email || (user && user.email) || undefined, cpfCnpj: normDoc(h.cpfCnpj), postalCode: digits(h.postalCode), addressNumber: String(h.addressNumber).slice(0, 20), phone: digits(h.phone), mobilePhone: digits(h.phone) },
    };
  }
  async function pixOf(paymentId) {
    try { const q = await asaas(`/payments/${paymentId}/pixQrCode`); return { pix_payload: q.payload || null, pix_image: q.encodedImage || null }; } catch { return { pix_payload: null, pix_image: null }; }
  }
  const invView = (i) => i && ({ id: i.id, kind: i.kind, description: i.description, value: Number(i.value), status: i.status, billing_type: i.billing_type, due_date: i.due_date, paid_at: i.paid_at, invoice_url: i.invoice_url, pix_payload: i.pix_payload, pix_image: i.pix_image, change: i.change, created_at: i.created_at });
  const subView = (s) => s && ({ id: s.id, plan: s.plan_code, nome: PLANS[s.plan_code].nome, connections: s.connections, cycle: s.cycle, ciclo: CYCLES[s.cycle].nome, price: Number(s.price), status: s.status, billing_type: s.billing_type,
    card: s.card_last4 ? { last4: s.card_last4, brand: s.card_brand } : null, renova_em: s.current_period_end, pending_change: s.pending_change, started_at: s.started_at });

  // pagamento confirmado (webhook ou consulta): fatura paga, plano ativo, transação (comissão)
  async function confirmPayment(p) {
    const inv = (await pool.query(`select * from public.invoices where asaas_payment_id = $1`, [p.id])).rows[0];
    let invoice = inv;
    let sub = null;
    if (!invoice) { // renovação automática: o Asaas criou a cobrança do novo ciclo
      sub = (await pool.query(`select * from public.subscriptions where asaas_subscription_id = $1`, [p.subscription || '-'])).rows[0];
      if (!sub) return { ok: false, reason: 'cobrança desconhecida' };
      invoice = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, status, billing_type, asaas_payment_id, due_date, invoice_url)
        values ($1,$2,'assinatura',$3,$4,'pendente',$5,$6,$7,$8) on conflict (asaas_payment_id) do update set value = excluded.value returning *`,
        [sub.organization_id, sub.id, `Kobly ${PLANS[sub.plan_code].nome} · ${CYCLES[sub.cycle].nome}`, p.value, p.billingType, p.id, p.dueDate || null, p.invoiceUrl || null])).rows[0];
    }
    if (invoice.status === 'paga') return { ok: true, already: true };
    const upd = await pool.query(`update public.invoices set status = 'paga', paid_at = now() where id = $1 and status <> 'paga' returning *`, [invoice.id]);
    if (!upd.rowCount) return { ok: true, already: true };
    sub = sub || (await pool.query(`select * from public.subscriptions where id = $1`, [invoice.subscription_id])).rows[0];
    if (sub) {
      if (invoice.kind === 'upgrade' && invoice.change) {
        const c = invoice.change;
        await pool.query(`update public.subscriptions set plan_code = $2, connections = $3, price = $4, pending_change = null, updated_at = now() where id = $1`, [sub.id, c.plan, c.connections, c.price]);
        if (sub.asaas_subscription_id) await asaas(`/subscriptions/${sub.asaas_subscription_id}`, 'POST', { value: c.price, description: `Kobly ${PLANS[c.plan].nome} · ${c.connections} conexão(ões)`, updatePendingPayments: true }).catch(() => {});
      } else {
        // assinatura (primeira ou renovação): avança o ciclo e aplica a redução marcada
        const start = sub.current_period_end && new Date(sub.current_period_end) > now() ? sub.current_period_end : now();
        const pc = sub.pending_change;
        const first = sub.status === 'pendente';
        await pool.query(`update public.subscriptions set status = 'ativa', current_period_end = $2, started_at = coalesce(started_at, now()),
            plan_code = coalesce($3, plan_code), connections = coalesce($4, connections), price = coalesce($5, price), cycle = coalesce($6, cycle), pending_change = case when $3::text is null then pending_change else null end, updated_at = now() where id = $1`,
          [sub.id, first ? addCycle(now(), sub.cycle) : addCycle(start, (pc && pc.cycle) || sub.cycle), first ? null : pc ? pc.plan : null, first ? null : pc ? pc.connections : null, first ? null : pc ? pc.price : null, first ? null : pc ? pc.cycle : null]);
      }
      const s2 = (await pool.query(`select plan_code from public.subscriptions where id = $1`, [sub.id])).rows[0];
      const planId = (await pool.query(`select id from public.plans where code = $1`, [s2.plan_code])).rows[0]?.id || null;
      await pool.query(`update public.organizations set plano_id = coalesce($2, plano_id), plano_status = 'ativo', plano_ativado_em = coalesce(plano_ativado_em, now()) where id = $1`, [sub.organization_id, planId]);
      await pool.query(`insert into public.transactions (organization_id, plano_id, valor_pago, forma_pagamento, status_pagamento, id_transacao, data)
        select $1,$2,$3,$4,'Pago',$5, current_date where not exists (select 1 from public.transactions where id_transacao = $5)`,
        [sub.organization_id, planId, invoice.value, invoice.billing_type === 'CREDIT_CARD' ? 'Cartão' : 'Pix', p.id]);
    }
    return { ok: true };
  }
  async function refundPayment(p) {
    await pool.query(`update public.invoices set status = 'estornada' where asaas_payment_id = $1`, [p.id]);
    await pool.query(`update public.transactions set status_pagamento = 'Pagamento recusado' where id_transacao = $1`, [p.id]);
  }

  async function receiveWebhook(raw, token) {
    const got = String(token || '');
    if (!webhookToken || got.length !== webhookToken.length || !timingSafeEqual(Buffer.from(got), Buffer.from(webhookToken))) return { status: 401 };
    let b; try { b = JSON.parse(String(raw)); } catch { return { status: 400 }; }
    const p = b.payment || {};
    if (!p.id) return { status: 200 };
    if (b.event === 'PAYMENT_CONFIRMED' || b.event === 'PAYMENT_RECEIVED') await confirmPayment(p);
    else if (b.event === 'PAYMENT_OVERDUE') {
      await pool.query(`update public.invoices set status = 'vencida' where asaas_payment_id = $1 and status = 'pendente'`, [p.id]);
      await pool.query(`update public.subscriptions set status = 'inadimplente', updated_at = now() where asaas_subscription_id = $1 and status = 'ativa'`, [p.subscription || '-']);
      await pool.query(`update public.organizations o set plano_status = 'inadimplente' from public.subscriptions s where s.organization_id = o.id and s.asaas_subscription_id = $1`, [p.subscription || '-']);
    } else if (['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE'].includes(b.event)) await refundPayment(p);
    else if (b.event === 'PAYMENT_DELETED') await pool.query(`update public.invoices set status = 'cancelada' where asaas_payment_id = $1 and status = 'pendente'`, [p.id]);
    else if (b.event === 'PAYMENT_CREATED' && p.subscription) { // próxima cobrança da assinatura: guarda o Pix para mostrar na tela
      const sub = (await pool.query(`select * from public.subscriptions where asaas_subscription_id = $1`, [p.subscription])).rows[0];
      if (sub) {
        const pix = p.billingType === 'PIX' ? await pixOf(p.id) : {};
        await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, asaas_payment_id, due_date, invoice_url, pix_payload, pix_image)
          values ($1,$2,'assinatura',$3,$4,$5,$6,$7,$8,$9,$10) on conflict (asaas_payment_id) do nothing`,
          [sub.organization_id, sub.id, `Kobly ${PLANS[sub.plan_code].nome} · ${CYCLES[sub.cycle].nome}`, p.value, p.billingType, p.id, p.dueDate || null, p.invoiceUrl || null, pix.pix_payload || null, pix.pix_image || null]);
      }
    }
    return { status: 200 };
  }

  // consulta o Asaas na hora (a tela pergunta enquanto espera o Pix; não depende só do webhook)
  async function refreshInvoice(inv) {
    if (!inv || inv.status !== 'pendente' || !inv.asaas_payment_id || !configured()) return inv;
    const p = await asaas(`/payments/${inv.asaas_payment_id}`).catch(() => null);
    if (p && ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(p.status)) await confirmPayment(p);
    return (await pool.query(`select * from public.invoices where id = $1`, [inv.id])).rows[0];
  }

  function parsePlan(body) {
    const plan = String(body.plan || '');
    if (!PLANS[plan]) fail('Escolha um plano.');
    const cycle = CYCLES[body.cycle] ? body.cycle : 'mensal';
    const connections = isAgency(plan) ? 1 : Number(body.connections || PLANS[plan].min);
    let price;
    try { price = priceOf(plan, connections, cycle); } catch (e) { fail(e.message); }
    return { plan, cycle, connections, price };
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const owner = () => { if (ctx.role === 'Suporte' || ctx.teamRole === 'atendente') throw new AuthError(403, 'forbidden', 'Só o dono da conta mexe no plano.'); };
    switch (body.action) {
      case 'catalog': return { ...catalog(), enabled: configured() };
      case 'status': {
        let s = await subOf(orgId);
        const pend = (await pool.query(`select * from public.invoices where organization_id = $1 and status = 'pendente' order by created_at desc limit 1`, [orgId])).rows[0];
        if (pend) await refreshInvoice(pend);
        s = await subOf(orgId);
        const invoices = (await pool.query(`select * from public.invoices where organization_id = $1 order by created_at desc limit 50`, [orgId])).rows.map(invView);
        const o = (await pool.query(`select documento from public.organizations where id = $1`, [orgId])).rows[0] || {};
        return { enabled: configured(), subscription: subView(s), entitlement: await entitlement(orgId), usage: await usage(orgId), invoices, pending: invoices.find((i) => i.status === 'pendente' || i.status === 'vencida') || null,
          documento: o.documento ? `${normDoc(o.documento).slice(0, 3)}•••${normDoc(o.documento).slice(-2)}` : null };
      }
      case 'quote': { // preço do plano escolhido e, se já assina, quanto paga agora
        const q = parsePlan(body);
        const s = await subOf(orgId);
        const res = { ...q, mensal: monthly(q.plan, q.connections) };
        if (s && s.status === 'ativa' && s.current_period_end) {
          const newPrice = priceOf(q.plan, q.connections, s.cycle);
          res.upgrade = { ...proration({ oldPrice: Number(s.price), newPrice, cycle: s.cycle, periodEnd: s.current_period_end, now: now() }), price: newPrice, renova_em: s.current_period_end, direcao: newPrice > Number(s.price) ? 'upgrade' : newPrice < Number(s.price) ? 'reducao' : 'igual' };
        }
        return res;
      }
      case 'subscribe': {
        owner();
        const q = parsePlan(body);
        const method = body.method === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'PIX';
        let s = await subOf(orgId);
        if (s && live(s) && s.status !== 'cortesia') fail('Você já tem um plano ativo. Use "Fazer upgrade" ou "Reduzir plano".');
        if (body.documento) { if (!validDocument(body.documento)) fail('CPF ou CNPJ inválido.'); await pool.query(`update public.organizations set documento = $2 where id = $1`, [orgId, normDoc(body.documento)]); }
        const card = method === 'CREDIT_CARD' ? cardPayload(body, user) : null;
        const cust = await customerFor(orgId, user);
        // assinatura pendente antiga (Pix não pago): cancela no Asaas antes de criar outra
        if (s && s.asaas_subscription_id && s.status === 'pendente') await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'DELETE').catch(() => {});
        s = (await pool.query(`insert into public.subscriptions (organization_id, plan_code, connections, cycle, price, status, billing_type, asaas_customer_id)
            values ($1,$2,$3,$4,$5,'pendente',$6,$7)
            on conflict (organization_id) do update set plan_code = excluded.plan_code, connections = excluded.connections, cycle = excluded.cycle, price = excluded.price, status = 'pendente',
              billing_type = excluded.billing_type, asaas_customer_id = excluded.asaas_customer_id, asaas_subscription_id = null, pending_change = null, current_period_end = null, updated_at = now() returning *`,
          [orgId, q.plan, q.connections, q.cycle, q.price, method, cust.asaas_customer_id])).rows[0];
        const desc = `Kobly ${PLANS[q.plan].nome}${isAgency(q.plan) ? '' : ` · ${q.connections} conexão(ões)`} · ${CYCLES[q.cycle].nome}`;
        const sub = await asaas('/subscriptions', 'POST', { customer: cust.asaas_customer_id, billingType: method, value: q.price, nextDueDate: today(now()), cycle: CYCLES[q.cycle].asaas, description: desc, externalReference: `sub:${s.id}`, ...(card || {}), ...(card ? { remoteIp: body.remote_ip || undefined } : {}) });
        await pool.query(`update public.subscriptions set asaas_subscription_id = $2, card_token_enc = $3, card_last4 = $4, card_brand = $5 where id = $1`,
          [s.id, sub.id, sub.creditCard && sub.creditCard.creditCardToken && secretKey ? encrypt(sub.creditCard.creditCardToken, secretKey) : null, sub.creditCard ? String(sub.creditCard.creditCardNumber || '').slice(-4) || null : null, sub.creditCard ? sub.creditCard.creditCardBrand || null : null]);
        const first = ((await asaas(`/subscriptions/${sub.id}/payments`).catch(() => ({ data: [] }))).data || [])[0];
        if (!first) return { subscription: subView(await subOf(orgId)), invoice: null };
        const pix = method === 'PIX' ? await pixOf(first.id) : {};
        const inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, asaas_payment_id, due_date, invoice_url, pix_payload, pix_image)
          values ($1,$2,'assinatura',$3,$4,$5,$6,$7,$8,$9,$10) on conflict (asaas_payment_id) do update set pix_payload = excluded.pix_payload returning *`,
          [orgId, s.id, desc, first.value, method, first.id, first.dueDate || null, first.invoiceUrl || null, pix.pix_payload || null, pix.pix_image || null])).rows[0];
        if (['CONFIRMED', 'RECEIVED'].includes(first.status)) await confirmPayment(first);
        else if (method === 'CREDIT_CARD') await refreshInvoice(inv);
        const fresh = (await pool.query(`select * from public.invoices where id = $1`, [inv.id])).rows[0];
        return { subscription: subView(await subOf(orgId)), invoice: invView(fresh) };
      }
      case 'invoice': { // a tela pergunta enquanto espera o pagamento
        if (!UUID.test(String(body.id || ''))) fail('Fatura inválida.');
        const inv = (await pool.query(`select * from public.invoices where id = $1 and organization_id = $2`, [body.id, orgId])).rows[0];
        if (!inv) throw new AuthError(404, 'not_found', 'Fatura não encontrada.');
        return { invoice: invView(await refreshInvoice(inv)), subscription: subView(await subOf(orgId)) };
      }
      case 'upgrade': {
        owner();
        const s = await subOf(orgId);
        if (!s || s.status !== 'ativa') fail('Assine um plano primeiro.');
        const q = parsePlan({ ...body, cycle: s.cycle });
        if (q.price <= Number(s.price)) fail('Esse plano custa menos que o atual. Use "Reduzir plano".');
        const uso = await usage(orgId);
        if (!isAgency(q.plan) && uso.total > q.connections) fail(`Você usa ${uso.total} conexão(ões). Escolha pelo menos ${uso.total} ou desconecte antes.`);
        const pr = proration({ oldPrice: Number(s.price), newPrice: q.price, cycle: s.cycle, periodEnd: s.current_period_end, now: now() });
        const change = { plan: q.plan, connections: q.connections, price: q.price };
        const desc = `Upgrade para ${PLANS[q.plan].nome}${isAgency(q.plan) ? '' : ` · ${q.connections} conexão(ões)`} (${pr.dias_restantes} dias)`;
        if (pr.pagar < 5) { // diferença pequena demais para cobrar: aplica sem cobrar
          const inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, status, change, paid_at) values ($1,$2,'upgrade',$3,0,'paga',$4::jsonb, now()) returning *`, [orgId, s.id, desc, JSON.stringify(change)])).rows[0];
          await pool.query(`update public.subscriptions set plan_code = $2, connections = $3, price = $4, pending_change = null, updated_at = now() where id = $1`, [s.id, q.plan, q.connections, q.price]);
          if (s.asaas_subscription_id) await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'POST', { value: q.price, description: desc, updatePendingPayments: true }).catch(() => {});
          return { invoice: invView(inv), subscription: subView(await subOf(orgId)), proration: pr };
        }
        const method = body.method === 'PIX' ? 'PIX' : 'CREDIT_CARD';
        const pay = { customer: s.asaas_customer_id, billingType: method, value: pr.pagar, dueDate: today(now()), description: desc };
        if (method === 'CREDIT_CARD') {
          if (body.card) Object.assign(pay, cardPayload(body, user));
          else if (s.card_token_enc && secretKey) pay.creditCardToken = decrypt(s.card_token_enc, secretKey);
          else fail('Informe os dados do cartão.');
        }
        let inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, change) values ($1,$2,'upgrade',$3,$4,$5,$6::jsonb) returning *`,
          [orgId, s.id, desc, pr.pagar, method, JSON.stringify(change)])).rows[0];
        let p;
        try { p = await asaas('/payments', 'POST', { ...pay, externalReference: `upg:${inv.id}` }); }
        catch (e) { await pool.query(`update public.invoices set status = 'falhou' where id = $1`, [inv.id]); throw e; }
        const pix = method === 'PIX' ? await pixOf(p.id) : {};
        inv = (await pool.query(`update public.invoices set asaas_payment_id = $2, due_date = $3, invoice_url = $4, pix_payload = $5, pix_image = $6 where id = $1 returning *`,
          [inv.id, p.id, p.dueDate || null, p.invoiceUrl || null, pix.pix_payload || null, pix.pix_image || null])).rows[0];
        if (['CONFIRMED', 'RECEIVED'].includes(p.status)) await confirmPayment(p);
        inv = (await pool.query(`select * from public.invoices where id = $1`, [inv.id])).rows[0];
        return { invoice: invView(inv), subscription: subView(await subOf(orgId)), proration: pr };
      }
      case 'downgrade': { // vale na próxima renovação; até lá continua o plano atual
        owner();
        const s = await subOf(orgId);
        if (!s || s.status !== 'ativa') fail('Assine um plano primeiro.');
        const q = parsePlan({ ...body, cycle: body.cycle || s.cycle });
        if (q.price >= Number(s.price) && q.cycle === s.cycle) fail('Esse plano não custa menos. Use "Fazer upgrade".');
        const u = await usage(orgId);
        const novas = connectionsOf(q.plan, q.connections);
        if (!isAgency(q.plan) && u.total > novas) fail(`Você usa ${u.total} conexão(ões). Desconecte até ficar com ${novas} antes de reduzir.`);
        const pc = { plan: q.plan, connections: q.connections, price: q.price, cycle: q.cycle };
        await pool.query(`update public.subscriptions set pending_change = $2::jsonb, updated_at = now() where id = $1`, [s.id, JSON.stringify(pc)]);
        if (s.asaas_subscription_id) await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'POST', { value: q.price, cycle: CYCLES[q.cycle].asaas, description: `Kobly ${PLANS[q.plan].nome} · ${CYCLES[q.cycle].nome}`, updatePendingPayments: true });
        return { subscription: subView(await subOf(orgId)) };
      }
      case 'cancel_downgrade': {
        owner();
        const s = await subOf(orgId);
        if (!s || !s.pending_change) fail('Não há redução marcada.');
        await pool.query(`update public.subscriptions set pending_change = null, updated_at = now() where id = $1`, [s.id]);
        if (s.asaas_subscription_id) await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'POST', { value: Number(s.price), cycle: CYCLES[s.cycle].asaas, updatePendingPayments: true });
        return { subscription: subView(await subOf(orgId)) };
      }
      case 'change_card': { // próximas cobranças no cartão novo
        owner();
        const s = await subOf(orgId);
        if (!s || !s.asaas_subscription_id) fail('Assine um plano primeiro.');
        const card = cardPayload(body, user);
        const t = await asaas('/creditCard/tokenizeCreditCard', 'POST', { customer: s.asaas_customer_id, ...card, remoteIp: body.remote_ip || undefined });
        await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'POST', { billingType: 'CREDIT_CARD', creditCardToken: t.creditCardToken, updatePendingPayments: true });
        await pool.query(`update public.subscriptions set billing_type = 'CREDIT_CARD', card_token_enc = $2, card_last4 = $3, card_brand = $4, updated_at = now() where id = $1`,
          [s.id, secretKey ? encrypt(t.creditCardToken, secretKey) : null, t.creditCardNumber ? String(t.creditCardNumber).slice(-4) : digits(body.card.number).slice(-4), t.creditCardBrand || null]);
        return { subscription: subView(await subOf(orgId)) };
      }
      case 'use_pix': { // próximas cobranças por Pix
        owner();
        const s = await subOf(orgId);
        if (!s || !s.asaas_subscription_id) fail('Assine um plano primeiro.');
        await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'POST', { billingType: 'PIX', updatePendingPayments: true });
        await pool.query(`update public.subscriptions set billing_type = 'PIX', updated_at = now() where id = $1`, [s.id]);
        return { subscription: subView(await subOf(orgId)) };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  // ---- administrador -----------------------------------------------------------------------------
  async function admin(body) {
    switch (body.action) {
      case 'overview': {
        const r = (await pool.query(`select count(*) filter (where status = 'ativa')::int as ativas, count(*) filter (where status = 'inadimplente')::int as inadimplentes,
            count(*) filter (where status = 'cortesia')::int as cortesias, count(*) filter (where status = 'pendente')::int as pendentes,
            coalesce(sum(case cycle when 'mensal' then price when 'trimestral' then price / 3 else price / 12 end) filter (where status in ('ativa','inadimplente')), 0)::float as mrr
          from public.subscriptions`)).rows[0];
        const mes = (await pool.query(`select coalesce(sum(value), 0)::float as v from public.invoices where status = 'paga' and paid_at >= date_trunc('month', now())`)).rows[0].v;
        const planos = (await pool.query(`select plan_code, count(*)::int as n from public.subscriptions where status in ('ativa','inadimplente','cortesia') group by 1`)).rows;
        return { ...r, mrr: r2(r.mrr), recebido_mes: r2(mes), planos, enabled: configured() };
      }
      case 'list': {
        const q = String(body.q || '').trim().slice(0, 60);
        const { rows } = await pool.query(`select s.*, o.nome as conta,
            (select count(*) from public.whatsapp_uazapi_instances i where i.organization_id = s.organization_id)::int + (select count(*) from public.meta_channels m where m.organization_id = s.organization_id)::int as em_uso
          from public.subscriptions s join public.organizations o on o.id = s.organization_id
          where ($1 = '' or o.nome ilike '%' || $1 || '%') order by s.updated_at desc limit 300`, [q]);
        return { subscriptions: rows.map((s) => ({ ...subView(s), organization_id: s.organization_id, conta: s.conta, em_uso: s.em_uso, note: s.note })) };
      }
      case 'orgs': {
        const q = String(body.q || '').trim().slice(0, 60);
        return { orgs: (await pool.query(`select o.id, o.nome, s.plan_code, s.status from public.organizations o left join public.subscriptions s on s.organization_id = o.id
          where ($1 = '' or o.nome ilike '%' || $1 || '%') order by o.nome limit 30`, [q])).rows };
      }
      case 'set_cortesia': { // conta liberada pela Kobly sem cobrar (amigos, parceiros, a sua própria)
        if (!UUID.test(String(body.org_id || ''))) fail('Escolha a conta.');
        const q = parsePlan(body);
        const until = body.until ? new Date(body.until) : null;
        if (until && Number.isNaN(until.getTime())) fail('Data inválida.');
        const s = await subOf(body.org_id);
        if (s && s.asaas_subscription_id && ['ativa', 'inadimplente', 'pendente'].includes(s.status)) await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'DELETE').catch(() => {});
        await pool.query(`insert into public.subscriptions (organization_id, plan_code, connections, cycle, price, status, current_period_end, note, started_at)
            values ($1,$2,$3,'mensal',0,'cortesia',$4,$5, now())
          on conflict (organization_id) do update set plan_code = excluded.plan_code, connections = excluded.connections, price = 0, status = 'cortesia', current_period_end = excluded.current_period_end,
            note = excluded.note, asaas_subscription_id = null, pending_change = null, updated_at = now()`,
          [body.org_id, q.plan, q.connections, until, String(body.note || '').slice(0, 300) || null]);
        return { ok: true };
      }
      case 'cancel': {
        if (!UUID.test(String(body.org_id || ''))) fail('Escolha a conta.');
        const s = await subOf(body.org_id);
        if (!s) fail('Essa conta não tem assinatura.');
        if (s.asaas_subscription_id) await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'DELETE').catch(() => {});
        await pool.query(`update public.subscriptions set status = 'cancelada', canceled_at = now(), asaas_subscription_id = null, updated_at = now() where id = $1`, [s.id]);
        await pool.query(`update public.organizations set plano_status = null where id = $1`, [body.org_id]);
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  return { handle, admin, receiveWebhook, entitlement, usage, requireFeature, requireSlots, confirmPayment, configured };
}
