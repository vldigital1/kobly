// Planos e cobrança da Kobly. Dois jeitos de pagar:
//   - Pix pelo Asaas, com Pix Automático: o primeiro QR Code paga o 1º ciclo e autoriza o débito no banco; depois a
//     Kobly cria cada cobrança uns dias antes do vencimento e o banco debita sozinho (provider 'pix_auto').
//   - Cartão pela Stripe: assinatura da Stripe; o cartão é digitado no formulário da Stripe dentro da Kobly
//     (provider 'stripe').
// Sem Pix Automático liberado (ASAAS_PIX_AUTOMATICO) ou sem chave da Stripe, cai no jeito antigo: assinatura do
// Asaas com Pix comum ou cartão (provider 'asaas'). Upgrade paga só a diferença dos dias que faltam; redução vale
// na próxima renovação. Cada pagamento confirmado grava em transactions (histórico e comissão dos afiliados).
//   rota billing (dono da conta): catalog | status | quote | subscribe | invoice | upgrade | downgrade | cancel_downgrade
//                                 | change_card | card_setup | card_saved | use_pix
//   rota billing-admin (Administrador): overview | list | orgs | set_cortesia | cancel
//   POST /webhooks/asaas (cabeçalho asaas-access-token) · POST /webhooks/stripe (cabeçalho stripe-signature)
// O cartão nunca passa pela Kobly: vai direto ao Asaas ou à Stripe.
import { timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';
import { PLANS, CYCLES, catalog, priceOf, monthly, proration, isAgency, connectionsOf } from './pricing.js';
import { createStripe, verifyStripeSignature } from './stripe.js';

const UUID = /^[0-9a-f-]{36}$/i;
const GRACE_DAYS = 5; // dias de tolerância depois do vencimento antes de travar
const PIX_AHEAD_DAYS = 8; // Pix Automático: a cobrança é criada uns dias antes (o Asaas pede de 2 a 10 dias úteis)
const FEATURE_LABEL = { canais: 'WhatsApp API oficial, Instagram e Messenger', ia: 'Agente de IA e voz', anuncios: 'Gestor de anúncios', disparo: 'Disparo em massa', cobranca: 'Cobrança no fluxo' };
const PIX_FREQ = { mensal: 'MONTHLY', trimestral: 'QUARTERLY', anual: 'ANNUALLY' };
const STRIPE_INTERVAL = { mensal: { interval: 'month', interval_count: 1 }, trimestral: { interval: 'month', interval_count: 3 }, anual: { interval: 'year', interval_count: 1 } };
const digits = (v) => String(v || '').replace(/\D/g, '');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);
const today = (now) => new Date(now).toISOString().slice(0, 10);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);
function addCycle(from, cycle) { const d = new Date(from); d.setMonth(d.getMonth() + CYCLES[cycle].meses); return d; }
const planDesc = (plan, connections, cycle) => `Kobly ${PLANS[plan].nome}${isAgency(plan) ? '' : ` · ${connections} conexão(ões)`}${cycle ? ` · ${CYCLES[cycle].nome}` : ''}`;
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

export function createBilling({ pool, secretKey, fetchImpl = globalThis.fetch, apiKey = '', env = 'sandbox', webhookToken = '', now = () => new Date(),
  pixAuto = false, stripeKey = '', stripePk = '', stripeWebhookSecret = '' }) {
  const base = env === 'production' ? 'https://api.asaas.com/v3' : 'https://sandbox.asaas.com/api/v3';
  const stripe = createStripe({ secretKey: stripeKey, fetchImpl });
  const configured = () => !!apiKey || stripe.on();
  const pixAutoOn = () => !!apiKey && !!pixAuto; // conta do Asaas liberada para o Pix Automático
  const cardStripe = () => stripe.on();
  const pixOn = () => !!apiKey;
  const fail = (m, code = 'validation_failed') => { throw new AuthError(422, code, m); };

  async function asaas(path, method = 'GET', body) {
    if (!apiKey) throw new AuthError(503, 'billing_off', 'O Pix ainda não foi ativado no servidor da Kobly.');
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

  // ---- clientes ---------------------------------------------------------------------------------
  const ownerEmail = async (orgId, user) => (user && user.email) || (await pool.query(`select email from public.profiles where organization_id = $1 order by created_at limit 1`, [orgId])).rows[0]?.email;
  async function customerFor(orgId, user) { // cliente no Asaas
    const o = (await pool.query(`select id, nome, documento, asaas_customer_id from public.organizations where id = $1`, [orgId])).rows[0];
    if (!o) throw new AuthError(404, 'not_found', 'Conta não encontrada.');
    if (!validDocument(o.documento)) fail('Informe um CPF ou CNPJ válido para a nota da cobrança.', 'documento_ausente');
    if (o.asaas_customer_id) return o;
    const email = await ownerEmail(orgId, user);
    const c = await asaas('/customers', 'POST', { name: o.nome, cpfCnpj: normDoc(o.documento), email: email || undefined, externalReference: orgId, notificationDisabled: false });
    await pool.query(`update public.organizations set asaas_customer_id = $2 where id = $1`, [orgId, c.id]);
    return { ...o, asaas_customer_id: c.id };
  }
  async function stripeCustomerFor(orgId, user, s) { // cliente na Stripe
    if (s && s.stripe_customer_id) return s.stripe_customer_id;
    const o = (await pool.query(`select id, nome, documento from public.organizations where id = $1`, [orgId])).rows[0];
    if (!o) throw new AuthError(404, 'not_found', 'Conta não encontrada.');
    const c = await stripe.call('/customers', 'POST', { name: o.nome, email: (await ownerEmail(orgId, user)) || undefined, metadata: { org: orgId, documento: o.documento ? normDoc(o.documento) : undefined } }, `cus-${orgId}`);
    if (s) await pool.query(`update public.subscriptions set stripe_customer_id = $2 where id = $1`, [s.id, c.id]);
    return c.id;
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
  const invView = (i) => i && ({ id: i.id, kind: i.kind, description: i.description, value: Number(i.value), status: i.status, billing_type: i.billing_type, due_date: i.due_date, paid_at: i.paid_at, invoice_url: i.invoice_url,
    pix_payload: i.pix_payload, pix_image: i.pix_image, change: i.change, created_at: i.created_at, autoriza: !!i.pix_auth_id });
  const subView = (s) => s && ({ id: s.id, plan: s.plan_code, nome: PLANS[s.plan_code].nome, connections: s.connections, cycle: s.cycle, ciclo: CYCLES[s.cycle].nome, price: Number(s.price), status: s.status, billing_type: s.billing_type,
    card: s.card_last4 ? { last4: s.card_last4, brand: s.card_brand } : null, renova_em: s.current_period_end, pending_change: s.pending_change, started_at: s.started_at,
    provider: s.provider || (s.asaas_subscription_id ? 'asaas' : null), pix_auto: s.provider === 'pix_auto' ? { status: s.pix_auth_status || null, valor: s.pix_auth_value != null ? Number(s.pix_auth_value) : null } : null });

  // ---- pagamento confirmado: fatura paga, plano ativo, transação (comissão) ----------------------
  async function settle(invoice, paymentRef) {
    const upd = await pool.query(`update public.invoices set status = 'paga', paid_at = now() where id = $1 and status <> 'paga' returning *`, [invoice.id]);
    if (!upd.rowCount) return { ok: true, already: true };
    invoice = upd.rows[0];
    const sub = (await pool.query(`select * from public.subscriptions where id = $1`, [invoice.subscription_id])).rows[0];
    if (!sub) return { ok: true };
    if (invoice.kind === 'upgrade' && invoice.change) {
      const c = invoice.change;
      await pool.query(`update public.subscriptions set plan_code = $2, connections = $3, price = $4, pending_change = null, updated_at = now() where id = $1`, [sub.id, c.plan, c.connections, c.price]);
      if (invoice.pix_auth_id && invoice.pix_auth_id !== sub.pix_auth_id) await switchPixAuth(sub, invoice.pix_auth_id, c.price);
      else await pushPrice(sub, c.price, c.plan, c.connections).catch((e) => console.error('[cobrança] valor novo no provedor', e.message));
    } else {
      // assinatura (primeira ou renovação): avança o ciclo e aplica a redução marcada
      const start = sub.current_period_end && new Date(sub.current_period_end) > now() ? sub.current_period_end : now();
      const pc = sub.pending_change;
      const first = sub.status === 'pendente';
      await pool.query(`update public.subscriptions set status = 'ativa', current_period_end = $2, started_at = coalesce(started_at, now()),
          plan_code = coalesce($3, plan_code), connections = coalesce($4, connections), price = coalesce($5, price), cycle = coalesce($6, cycle), pending_change = case when $3::text is null then pending_change else null end, updated_at = now() where id = $1`,
        [sub.id, first ? addCycle(now(), sub.cycle) : addCycle(start, (pc && pc.cycle) || sub.cycle), first ? null : pc ? pc.plan : null, first ? null : pc ? pc.connections : null, first ? null : pc ? pc.price : null, first ? null : pc ? pc.cycle : null]);
      if (invoice.pix_auth_id && invoice.pix_auth_id !== sub.pix_auth_id) await switchPixAuth(sub, invoice.pix_auth_id, Number(invoice.value));
    }
    const s2 = (await pool.query(`select plan_code from public.subscriptions where id = $1`, [sub.id])).rows[0];
    const planId = (await pool.query(`select id from public.plans where code = $1`, [s2.plan_code])).rows[0]?.id || null;
    await pool.query(`update public.organizations set plano_id = coalesce($2, plano_id), plano_status = 'ativo', plano_ativado_em = coalesce(plano_ativado_em, now()) where id = $1`, [sub.organization_id, planId]);
    await pool.query(`insert into public.transactions (organization_id, plano_id, valor_pago, forma_pagamento, status_pagamento, id_transacao, data)
      select $1,$2,$3,$4,'Pago',$5, current_date where not exists (select 1 from public.transactions where id_transacao = $5)`,
      [sub.organization_id, planId, invoice.value, invoice.billing_type === 'CREDIT_CARD' ? 'Cartão' : 'Pix', paymentRef || invoice.asaas_payment_id || invoice.stripe_payment_intent_id || invoice.stripe_invoice_id || invoice.id]);
    return { ok: true };
  }
  // o plano mudou de valor: o provedor passa a cobrar o novo nas próximas renovações
  async function pushPrice(sub, price, plan = sub.plan_code, connections = sub.connections, cycle = sub.cycle) {
    if (sub.provider === 'stripe' && sub.stripe_subscription_id && sub.stripe_item_id) {
      const prod = await stripe.product(plan, PLANS[plan].nome);
      await stripe.call(`/subscriptions/${sub.stripe_subscription_id}`, 'POST', { proration_behavior: 'none', description: planDesc(plan, connections, cycle),
        items: [{ id: sub.stripe_item_id, price_data: { currency: 'brl', product: prod.id, unit_amount: cents(price), recurring: STRIPE_INTERVAL[cycle] } }] });
    } else if (sub.provider === 'pix_auto') {
      // cobrança do próximo ciclo já criada no valor antigo: troca (o débito ainda não saiu)
      await repricePixPending(sub, price);
    } else if (sub.asaas_subscription_id) {
      await asaas(`/subscriptions/${sub.asaas_subscription_id}`, 'POST', { value: price, cycle: CYCLES[cycle].asaas, description: planDesc(plan, connections, cycle), updatePendingPayments: true });
      await syncPending(sub.id);
    }
  }
  async function switchPixAuth(sub, newAuth, value) {
    const old = sub.pix_auth_id;
    await pool.query(`update public.subscriptions set pix_auth_id = $2, pix_auth_status = 'ACTIVE', pix_auth_value = $3, provider = 'pix_auto', billing_type = 'PIX', updated_at = now() where id = $1`, [sub.id, newAuth, value]);
    if (old && old !== newAuth) await asaas(`/pix/automatic/authorizations/${old}`, 'DELETE').catch(() => {});
  }
  // Asaas: pagamento de cobrança conhecida, renovação da assinatura antiga ou 1º Pix do Pix Automático
  async function confirmPayment(p) {
    let invoice = (await pool.query(`select * from public.invoices where asaas_payment_id = $1`, [p.id])).rows[0];
    if (!invoice && p.subscription) { // renovação automática da assinatura antiga do Asaas
      const sub = (await pool.query(`select * from public.subscriptions where asaas_subscription_id = $1`, [p.subscription])).rows[0];
      if (!sub) return { ok: false, reason: 'cobrança desconhecida' };
      invoice = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, status, billing_type, asaas_payment_id, due_date, invoice_url)
        values ($1,$2,'assinatura',$3,$4,'pendente',$5,$6,$7,$8) on conflict (asaas_payment_id) do update set value = excluded.value returning *`,
        [sub.organization_id, sub.id, planDesc(sub.plan_code, sub.connections, sub.cycle), p.value, p.billingType, p.id, p.dueDate || null, p.invoiceUrl || null])).rows[0];
    }
    if (!invoice && p.customer) { // QR Code do Pix Automático (paga e autoriza): o Asaas não manda o id da autorização na cobrança
      invoice = (await pool.query(`update public.invoices i set asaas_payment_id = $3 where i.id = (
          select i2.id from public.invoices i2 join public.subscriptions s on s.id = i2.subscription_id
          where s.asaas_customer_id = $1 and i2.status = 'pendente' and i2.pix_auth_id is not null and i2.asaas_payment_id is null and i2.value = $2
          order by i2.created_at desc limit 1) returning *`, [p.customer, r2(p.value), p.id])).rows[0];
    }
    if (!invoice) return { ok: false, reason: 'cobrança desconhecida' };
    if (invoice.status === 'paga') return { ok: true, already: true };
    return settle(invoice, p.id);
  }
  async function refundPayment(p) {
    await pool.query(`update public.invoices set status = 'estornada' where asaas_payment_id = $1`, [p.id]);
    await pool.query(`update public.transactions set status_pagamento = 'Pagamento recusado' where id_transacao = $1`, [p.id]);
  }
  const once = async (provider, id) => !id || (await pool.query(`insert into public.billing_events (id, provider) values ($1,$2) on conflict do nothing`, [String(id), provider])).rowCount > 0;

  // ---- Pix Automático ---------------------------------------------------------------------------
  // cria a autorização: o QR Code paga `agora` e autoriza o débito de até `valor` a cada ciclo a partir de `inicio`
  async function newPixAuth(sub, { agora, valor, inicio, desc, cycle = sub.cycle, plan = sub.plan_code }) {
    return asaas('/pix/automatic/authorizations', 'POST', {
      frequency: PIX_FREQ[cycle], contractId: `KOBLY-${String(sub.id).slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`.slice(0, 35),
      startDate: ymd(inicio), customerId: sub.asaas_customer_id, description: `Kobly ${PLANS[plan].nome}`.slice(0, 35),
      minLimitValue: r2(valor), paymentCreationMode: 'MANUAL', retryPolicy: 'ALLOW_THREE_IN_SEVEN_DAYS',
      immediateQrCode: { expirationSeconds: 3 * 86400, originalValue: r2(agora), description: String(desc).slice(0, 140) },
    });
  }
  async function repricePixPending(sub, price) {
    const { rows } = await pool.query(`select * from public.invoices where subscription_id = $1 and status = 'pendente' and kind = 'assinatura' and asaas_payment_id is not null and pix_auth_id is null`, [sub.id]);
    for (const i of rows) {
      if (Number(i.value) === r2(price)) continue;
      const p = await asaas(`/payments/${i.asaas_payment_id}`, 'POST', { value: r2(price) }).catch(() => null);
      if (p) await pool.query(`update public.invoices set value = $2 where id = $1`, [i.id, r2(price)]);
    }
  }
  // assinaturas no Pix Automático perto de renovar: cria a cobrança do próximo ciclo (o banco debita no vencimento).
  // Sem autorização ativa (recusada/cancelada) ou valor acima do autorizado: a cobrança vira um QR Code que paga e autoriza de novo.
  async function tick() {
    if (!pixAutoOn()) return { created: 0 };
    // já tem a cobrança deste vencimento (pendente, paga ou vencida): não cria de novo
    const { rows } = await pool.query(`select s.* from public.subscriptions s where s.provider = 'pix_auto' and s.status in ('ativa','inadimplente')
        and s.current_period_end is not null and s.current_period_end <= $2::timestamptz + make_interval(days => $1)
        and not exists (select 1 from public.invoices i where i.subscription_id = s.id and i.kind = 'assinatura' and i.status in ('pendente','paga','vencida')
          and i.due_date >= (s.current_period_end - interval '5 days')::date) limit 50`, [PIX_AHEAD_DAYS, now()]);
    let created = 0;
    for (const s of rows) {
      const pc = s.pending_change;
      const price = r2(pc ? pc.price : s.price);
      const desc = planDesc(pc ? pc.plan : s.plan_code, pc ? pc.connections : s.connections, (pc && pc.cycle) || s.cycle);
      const due = new Date(s.current_period_end) > now() ? s.current_period_end : now();
      try {
        const autorizado = s.pix_auth_id && s.pix_auth_status === 'ACTIVE' && (s.pix_auth_value == null || price <= Number(s.pix_auth_value));
        if (autorizado) {
          const p = await asaas('/payments', 'POST', { customer: s.asaas_customer_id, billingType: 'PIX', value: price, dueDate: ymd(due), description: desc, pixAutomaticAuthorizationId: s.pix_auth_id, externalReference: `ren:${s.id}` });
          const pix = await pixOf(p.id);
          await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, asaas_payment_id, due_date, invoice_url, pix_payload, pix_image)
            values ($1,$2,'assinatura',$3,$4,'PIX',$5,$6,$7,$8,$9) on conflict (asaas_payment_id) do nothing`, [s.organization_id, s.id, desc, price, p.id, p.dueDate || ymd(due), p.invoiceUrl || null, pix.pix_payload, pix.pix_image]);
        } else {
          const a = await newPixAuth(s, { agora: price, valor: price, inicio: addCycle(due, (pc && pc.cycle) || s.cycle), desc, plan: pc ? pc.plan : s.plan_code });
          await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, due_date, pix_auth_id, pix_payload, pix_image)
            values ($1,$2,'assinatura',$3,$4,'PIX',$5,$6,$7,$8)`, [s.organization_id, s.id, desc, price, ymd(due), a.id, a.payload || null, a.encodedImage || null]);
        }
        created++;
      } catch (e) { console.error('[cobrança] Pix Automático', s.id, e.message); }
    }
    return { created };
  }
  async function onPixAuth(a) {
    if (!a || !a.id) return;
    await pool.query(`update public.subscriptions set pix_auth_status = $2 where pix_auth_id = $1`, [a.id, a.status]);
    const inv = (await pool.query(`select * from public.invoices where pix_auth_id = $1 order by created_at desc limit 1`, [a.id])).rows[0];
    if (a.status === 'ACTIVE') {
      if (inv && inv.status === 'pendente') await settle(inv, inv.asaas_payment_id || `pixauto:${a.id}`);
      else if (inv) {
        const sub = (await pool.query(`select * from public.subscriptions where id = $1`, [inv.subscription_id])).rows[0];
        if (sub && sub.pix_auth_id !== a.id) await switchPixAuth(sub, a.id, a.minLimitValue || a.value || inv.value);
      }
    } else if (['REFUSED', 'EXPIRED', 'CANCELLED'].includes(a.status) && inv && inv.status === 'pendente' && !inv.asaas_payment_id) {
      // QR Code não pago: some da tela (o pago com autorização recusada já foi confirmado pelo PAYMENT_RECEIVED)
      await pool.query(`update public.invoices set status = 'cancelada' where id = $1`, [inv.id]);
    }
  }

  async function receiveWebhook(raw, token) {
    const got = String(token || '');
    if (!webhookToken || got.length !== webhookToken.length || !timingSafeEqual(Buffer.from(got), Buffer.from(webhookToken))) return { status: 401 };
    let b; try { b = JSON.parse(String(raw)); } catch { return { status: 400 }; }
    if (/^PIX_AUTOMATIC_RECURRING_AUTHORIZATION_/.test(b.event || '')) {
      if (!(await once('asaas', b.id))) return { status: 200 };
      const st = { ACTIVATED: 'ACTIVE', REFUSED: 'REFUSED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', CREATED: 'CREATED' }[b.event.replace('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_', '')];
      if (b.authorization && st) await onPixAuth({ ...b.authorization, status: st });
      return { status: 200 };
    }
    const p = b.payment || {};
    if (!p.id) return { status: 200 };
    if (b.event === 'PAYMENT_CONFIRMED' || b.event === 'PAYMENT_RECEIVED') await confirmPayment(p);
    else if (b.event === 'PAYMENT_OVERDUE') {
      await pool.query(`update public.invoices set status = 'vencida' where asaas_payment_id = $1 and status = 'pendente'`, [p.id]);
      const inv = (await pool.query(`select subscription_id from public.invoices where asaas_payment_id = $1`, [p.id])).rows[0];
      const sid = inv ? inv.subscription_id : null;
      await pool.query(`update public.subscriptions set status = 'inadimplente', updated_at = now() where (asaas_subscription_id = $1 or id = $2) and status = 'ativa'`, [p.subscription || '-', sid]);
      await pool.query(`update public.organizations o set plano_status = 'inadimplente' from public.subscriptions s where s.organization_id = o.id and (s.asaas_subscription_id = $1 or s.id = $2)`, [p.subscription || '-', sid]);
    } else if (['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE'].includes(b.event)) await refundPayment(p);
    else if (b.event === 'PAYMENT_DELETED') await pool.query(`update public.invoices set status = 'cancelada' where asaas_payment_id = $1 and status = 'pendente'`, [p.id]);
    else if (b.event === 'PAYMENT_CREATED' && p.subscription) { // próxima cobrança da assinatura antiga: guarda o Pix para mostrar na tela
      const sub = (await pool.query(`select * from public.subscriptions where asaas_subscription_id = $1`, [p.subscription])).rows[0];
      if (sub) {
        const pix = p.billingType === 'PIX' ? await pixOf(p.id) : {};
        await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, asaas_payment_id, due_date, invoice_url, pix_payload, pix_image)
          values ($1,$2,'assinatura',$3,$4,$5,$6,$7,$8,$9,$10) on conflict (asaas_payment_id) do nothing`,
          [sub.organization_id, sub.id, planDesc(sub.plan_code, sub.connections, sub.cycle), p.value, p.billingType, p.id, p.dueDate || null, p.invoiceUrl || null, pix.pix_payload || null, pix.pix_image || null]);
      }
    }
    return { status: 200 };
  }

  // ---- Stripe -----------------------------------------------------------------------------------
  async function receiveStripe(raw, signature) {
    if (!verifyStripeSignature(raw, signature, stripeWebhookSecret, Math.floor(now().getTime() / 1000))) return { status: 400 };
    let ev; try { ev = JSON.parse(String(raw)); } catch { return { status: 400 }; }
    if (!(await once('stripe', ev.id))) return { status: 200 };
    const o = (ev.data && ev.data.object) || {};
    // versões novas da API da Stripe: a assinatura da fatura fica em parent.subscription_details
    if (o.object === 'invoice' && !o.subscription && o.parent && o.parent.subscription_details) o.subscription = o.parent.subscription_details.subscription;
    if (o.object === 'invoice' && !o.payment_intent && o.payments && o.payments.data && o.payments.data[0]) o.payment_intent = (o.payments.data[0].payment || {}).payment_intent || null;
    if (ev.type === 'invoice.paid') await stripeInvoicePaid(o);
    else if (ev.type === 'invoice.payment_failed') {
      await pool.query(`update public.invoices set status = 'vencida' where stripe_invoice_id = $1 and status = 'pendente' and kind = 'assinatura' and $2 = 'subscription_cycle'`, [o.id, o.billing_reason || '']);
      if (o.billing_reason === 'subscription_cycle') {
        await pool.query(`update public.subscriptions set status = 'inadimplente', updated_at = now() where stripe_subscription_id = $1 and status = 'ativa'`, [o.subscription]);
        await pool.query(`update public.organizations g set plano_status = 'inadimplente' from public.subscriptions s where s.organization_id = g.id and s.stripe_subscription_id = $1`, [o.subscription]);
      }
    } else if (ev.type === 'payment_intent.succeeded' && o.metadata && o.metadata.kobly_invoice) {
      const inv = (await pool.query(`select * from public.invoices where id = $1`, [o.metadata.kobly_invoice])).rows[0];
      if (inv && inv.status === 'pendente') await settle(inv, o.id);
    } else if (ev.type === 'customer.subscription.deleted') {
      await pool.query(`update public.subscriptions set status = 'cancelada', canceled_at = now(), updated_at = now() where stripe_subscription_id = $1 and provider = 'stripe' and status <> 'cancelada'`, [o.id]);
    }
    return { status: 200 };
  }
  async function stripeInvoicePaid(o) {
    let inv = (await pool.query(`select * from public.invoices where stripe_invoice_id = $1`, [o.id])).rows[0];
    if (!inv && o.subscription && Number(o.amount_paid) > 0) { // renovação: a Stripe cobrou o próximo ciclo
      const sub = (await pool.query(`select * from public.subscriptions where stripe_subscription_id = $1`, [o.subscription])).rows[0];
      if (!sub) return;
      inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, stripe_invoice_id, stripe_payment_intent_id, invoice_url, due_date)
        values ($1,$2,'assinatura',$3,$4,'CREDIT_CARD',$5,$6,$7,current_date) on conflict do nothing returning *`,
        [sub.organization_id, sub.id, planDesc(sub.plan_code, sub.connections, sub.cycle), r2(o.amount_paid / 100), o.id, o.payment_intent || null, o.hosted_invoice_url || null])).rows[0]
        || (await pool.query(`select * from public.invoices where stripe_invoice_id = $1`, [o.id])).rows[0];
    }
    if (inv && inv.status !== 'paga') {
      if (o.hosted_invoice_url) await pool.query(`update public.invoices set invoice_url = $2 where id = $1`, [inv.id, o.hosted_invoice_url]);
      await settle(inv, o.payment_intent || o.id);
      await rememberCard(inv.subscription_id);
    }
  }
  async function cardInfo(pmId) { // últimos dígitos e bandeira para mostrar na tela
    const pm = await stripe.call(`/payment_methods/${typeof pmId === 'string' ? pmId : pmId && pmId.id}`).catch(() => null);
    return pm && pm.card ? { last4: pm.card.last4, brand: pm.card.brand ? pm.card.brand[0].toUpperCase() + pm.card.brand.slice(1) : null } : { last4: null, brand: null };
  }
  async function rememberCard(subId) {
    const s = (await pool.query(`select * from public.subscriptions where id = $1`, [subId])).rows[0];
    if (!s || s.provider !== 'stripe' || s.card_last4 || !s.stripe_subscription_id) return;
    const ss = await stripe.call(`/subscriptions/${s.stripe_subscription_id}`).catch(() => null);
    if (!ss || !ss.default_payment_method) return;
    const info = await cardInfo(ss.default_payment_method);
    await pool.query(`update public.subscriptions set card_last4 = $2, card_brand = $3 where id = $1`, [s.id, info.last4, info.brand]);
  }
  async function stripeSubscribe(orgId, user, s, q) {
    const customer = await stripeCustomerFor(orgId, user, s);
    const prod = await stripe.product(q.plan, PLANS[q.plan].nome);
    const sub = await stripe.call('/subscriptions', 'POST', {
      customer, payment_behavior: 'default_incomplete', description: planDesc(q.plan, q.connections, q.cycle),
      payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
      items: [{ price_data: { currency: 'brl', product: prod.id, unit_amount: cents(q.price), recurring: STRIPE_INTERVAL[q.cycle] } }],
      metadata: { org: orgId, kobly_sub: s.id }, expand: ['latest_invoice.payment_intent'],
    });
    const li = sub.latest_invoice || {};
    const pi = li.payment_intent || {};
    await pool.query(`update public.subscriptions set provider = 'stripe', billing_type = 'CREDIT_CARD', stripe_customer_id = $2, stripe_subscription_id = $3, stripe_item_id = $4, card_last4 = null, card_brand = null where id = $1`,
      [s.id, customer, sub.id, sub.items && sub.items.data && sub.items.data[0] ? sub.items.data[0].id : null]);
    const inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, stripe_invoice_id, stripe_payment_intent_id, due_date)
      values ($1,$2,'assinatura',$3,$4,'CREDIT_CARD',$5,$6, current_date) returning *`, [orgId, s.id, planDesc(q.plan, q.connections, q.cycle), q.price, li.id || null, pi.id || null])).rows[0];
    return { invoice: inv, client_secret: pi.client_secret || null };
  }

  // consulta o provedor na hora (a tela pergunta enquanto espera; não depende só do aviso)
  async function refreshInvoice(inv) {
    if (!inv || inv.status !== 'pendente') return inv;
    if (inv.stripe_invoice_id && cardStripe()) {
      const si = await stripe.call(`/invoices/${inv.stripe_invoice_id}`).catch(() => null);
      if (si && si.status === 'paid') await stripeInvoicePaid(si);
    } else if (inv.stripe_payment_intent_id && cardStripe()) {
      const pi = await stripe.call(`/payment_intents/${inv.stripe_payment_intent_id}`).catch(() => null);
      if (pi && pi.status === 'succeeded') await settle(inv, pi.id);
      else if (pi && pi.status === 'requires_payment_method' && pi.last_payment_error) await pool.query(`update public.invoices set status = 'falhou' where id = $1 and status = 'pendente'`, [inv.id]);
    } else if (inv.pix_auth_id && !inv.asaas_payment_id && pixOn()) {
      const a = await asaas(`/pix/automatic/authorizations/${inv.pix_auth_id}`).catch(() => null);
      if (a) await onPixAuth(a);
    } else if (inv.asaas_payment_id && pixOn()) {
      const p = await asaas(`/payments/${inv.asaas_payment_id}`).catch(() => null);
      if (p && ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(p.status)) await confirmPayment(p);
    }
    return (await pool.query(`select * from public.invoices where id = $1`, [inv.id])).rows[0];
  }
  // assinatura antiga do Asaas: depois de mudar o valor, traz o valor e o Pix novos da cobrança em aberto
  async function syncPending(subId) {
    if (!apiKey) return;
    const { rows } = await pool.query(`select id, asaas_payment_id, billing_type from public.invoices where subscription_id = $1 and status = 'pendente' and kind = 'assinatura' and asaas_payment_id is not null`, [subId]);
    for (const i of rows) {
      const p = await asaas(`/payments/${i.asaas_payment_id}`).catch(() => null);
      if (!p) continue;
      const pix = p.billingType === 'PIX' ? await pixOf(p.id) : { pix_payload: null, pix_image: null };
      await pool.query(`update public.invoices set value = $2, billing_type = $3, due_date = coalesce($4, due_date), invoice_url = coalesce($5, invoice_url), pix_payload = $6, pix_image = $7 where id = $1`,
        [i.id, p.value, p.billingType || i.billing_type, p.dueDate || null, p.invoiceUrl || null, pix.pix_payload, pix.pix_image]);
    }
  }
  // para de cobrar no provedor (cortesia, cancelamento, troca de forma de pagamento)
  async function stopRemote(s, { keepStripe = false, keepPix = false } = {}) {
    if (s.asaas_subscription_id && apiKey) await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'DELETE').catch(() => {});
    if (!keepStripe && s.stripe_subscription_id && cardStripe()) await stripe.call(`/subscriptions/${s.stripe_subscription_id}`, 'DELETE').catch(() => {});
    if (!keepPix && s.pix_auth_id && pixOn()) await asaas(`/pix/automatic/authorizations/${s.pix_auth_id}`, 'DELETE').catch(() => {});
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
  const payInfo = () => ({ pix: pixAutoOn() ? 'pix_auto' : pixOn() ? 'asaas' : null, cartao: cardStripe() ? 'stripe' : apiKey ? 'asaas' : null, stripe_pk: cardStripe() ? stripePk || null : null });
  const stripeOut = (cs) => (cs ? { stripe: { client_secret: cs, publishable_key: stripePk || null } } : {});

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const owner = () => { if (ctx.role === 'Suporte' || ctx.teamRole === 'atendente') throw new AuthError(403, 'forbidden', 'Só o dono da conta mexe no plano.'); };
    switch (body.action) {
      case 'catalog': return { ...catalog(), enabled: configured(), pagamento: payInfo() };
      case 'status': {
        let s = await subOf(orgId);
        const pend = (await pool.query(`select * from public.invoices where organization_id = $1 and status = 'pendente' order by created_at desc limit 1`, [orgId])).rows[0];
        if (pend) await refreshInvoice(pend);
        s = await subOf(orgId);
        const invoices = (await pool.query(`select * from public.invoices where organization_id = $1 order by created_at desc limit 50`, [orgId])).rows.map(invView);
        const o = (await pool.query(`select documento from public.organizations where id = $1`, [orgId])).rows[0] || {};
        return { enabled: configured(), pagamento: payInfo(), subscription: subView(s), entitlement: await entitlement(orgId), usage: await usage(orgId), invoices, pending: invoices.find((i) => i.status === 'pendente' || i.status === 'vencida') || null,
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
        const viaStripe = method === 'CREDIT_CARD' && cardStripe();
        const viaPixAuto = method === 'PIX' && pixAutoOn();
        const card = method === 'CREDIT_CARD' && !viaStripe ? cardPayload(body, user) : null;
        const cust = viaStripe ? null : await customerFor(orgId, user);
        if (s && s.status === 'pendente') await stopRemote(s);
        await pool.query(`update public.invoices set status = 'cancelada' where organization_id = $1 and status = 'pendente'`, [orgId]);
        s = (await pool.query(`insert into public.subscriptions (organization_id, plan_code, connections, cycle, price, status, billing_type, asaas_customer_id, provider)
            values ($1,$2,$3,$4,$5,'pendente',$6,$7,$8)
            on conflict (organization_id) do update set plan_code = excluded.plan_code, connections = excluded.connections, cycle = excluded.cycle, price = excluded.price, status = 'pendente',
              billing_type = excluded.billing_type, asaas_customer_id = coalesce(excluded.asaas_customer_id, public.subscriptions.asaas_customer_id), asaas_subscription_id = null, provider = excluded.provider,
              stripe_subscription_id = null, stripe_item_id = null, pix_auth_id = null, pix_auth_status = null, pending_change = null, current_period_end = null, updated_at = now() returning *`,
          [orgId, q.plan, q.connections, q.cycle, q.price, method, cust ? cust.asaas_customer_id : null, viaStripe ? 'stripe' : viaPixAuto ? 'pix_auto' : 'asaas'])).rows[0];
        const desc = planDesc(q.plan, q.connections, q.cycle);
        if (viaStripe) {
          const r = await stripeSubscribe(orgId, user, s, q);
          return { subscription: subView(await subOf(orgId)), invoice: invView(r.invoice), ...stripeOut(r.client_secret) };
        }
        if (viaPixAuto) {
          const a = await newPixAuth(s, { agora: q.price, valor: q.price, inicio: addCycle(now(), q.cycle), desc });
          await pool.query(`update public.subscriptions set pix_auth_id = $2, pix_auth_status = 'CREATED', pix_auth_value = $3 where id = $1`, [s.id, a.id, q.price]);
          const inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, due_date, pix_auth_id, pix_payload, pix_image)
            values ($1,$2,'assinatura',$3,$4,'PIX',$8,$5,$6,$7) returning *`, [orgId, s.id, desc, q.price, a.id, a.payload || null, a.encodedImage || null, today(now())])).rows[0];
          return { subscription: subView(await subOf(orgId)), invoice: invView(inv) };
        }
        // jeito antigo: assinatura do Asaas (Pix comum ou cartão do Asaas)
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
        await pool.query(`update public.invoices set status = 'cancelada' where subscription_id = $1 and kind = 'upgrade' and status = 'pendente'`, [s.id]);
        // Pix Automático: um QR Code só paga a diferença e autoriza o valor novo dos próximos ciclos
        if (s.provider === 'pix_auto') {
          const agora = r2(Math.max(0.01, pr.pagar));
          const a = await newPixAuth(s, { agora, valor: q.price, inicio: s.current_period_end, desc, plan: q.plan });
          const inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, change, pix_auth_id, pix_payload, pix_image, due_date)
            values ($1,$2,'upgrade',$3,$4,'PIX',$5::jsonb,$6,$7,$8,current_date) returning *`, [orgId, s.id, desc, agora, JSON.stringify(change), a.id, a.payload || null, a.encodedImage || null])).rows[0];
          return { invoice: invView(inv), subscription: subView(await subOf(orgId)), proration: pr };
        }
        if (pr.pagar < 5) { // diferença pequena demais para cobrar: aplica sem cobrar
          const inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, status, change, paid_at) values ($1,$2,'upgrade',$3,0,'paga',$4::jsonb, now()) returning *`, [orgId, s.id, desc, JSON.stringify(change)])).rows[0];
          await pool.query(`update public.subscriptions set plan_code = $2, connections = $3, price = $4, pending_change = null, updated_at = now() where id = $1`, [s.id, q.plan, q.connections, q.price]);
          await pushPrice(s, q.price, q.plan, q.connections).catch(() => {});
          return { invoice: invView(inv), subscription: subView(await subOf(orgId)), proration: pr };
        }
        if (s.provider === 'stripe') { // cobra a diferença no cartão salvo
          const ss = await stripe.call(`/subscriptions/${s.stripe_subscription_id}`);
          const pm = ss.default_payment_method || ((await stripe.call(`/customers/${s.stripe_customer_id}`)).invoice_settings || {}).default_payment_method;
          if (!pm) fail('Cadastre um cartão em "Trocar cartão" antes do upgrade.');
          let inv = (await pool.query(`insert into public.invoices (organization_id, subscription_id, kind, description, value, billing_type, change) values ($1,$2,'upgrade',$3,$4,'CREDIT_CARD',$5::jsonb) returning *`,
            [orgId, s.id, desc, pr.pagar, JSON.stringify(change)])).rows[0];
          let pi;
          try {
            pi = await stripe.call('/payment_intents', 'POST', { amount: cents(pr.pagar), currency: 'brl', customer: s.stripe_customer_id, payment_method: typeof pm === 'string' ? pm : pm.id, off_session: true, confirm: true, description: desc, metadata: { org: orgId, kobly_invoice: inv.id } }, `upg-${inv.id}`);
          } catch (e) {
            const epi = e.stripe && e.stripe.payment_intent;
            await pool.query(`update public.invoices set status = case when $2::text is null then 'falhou' else status end, stripe_payment_intent_id = $2 where id = $1`, [inv.id, epi ? epi.id : null]);
            if (e.stripe && e.stripe.code === 'authentication_required' && epi) return { invoice: invView((await pool.query(`select * from public.invoices where id = $1`, [inv.id])).rows[0]), proration: pr, ...stripeOut(epi.client_secret) };
            throw e;
          }
          await pool.query(`update public.invoices set stripe_payment_intent_id = $2 where id = $1`, [inv.id, pi.id]);
          if (pi.status === 'succeeded') await settle({ ...inv, stripe_payment_intent_id: pi.id }, pi.id);
          inv = (await pool.query(`select * from public.invoices where id = $1`, [inv.id])).rows[0];
          return { invoice: invView(inv), subscription: subView(await subOf(orgId)), proration: pr, ...(pi.status === 'requires_action' ? stripeOut(pi.client_secret) : {}) };
        }
        // assinatura antiga do Asaas
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
        if (!isAgency(q.plan) && u.total > novas) fail(`Você usa ${u.total} conexão(ões) e o ${PLANS[q.plan].nome} comporta ${novas}. Escolha ${u.total - novas} para apagar antes de reduzir.`, 'plan_connections');
        if (s.provider === 'pix_auto' && q.cycle !== s.cycle) fail('No Pix Automático o ciclo continua o mesmo. Para mudar o ciclo, passe a pagar com cartão.');
        const pc = { plan: q.plan, connections: q.connections, price: q.price, cycle: q.cycle };
        await pool.query(`update public.subscriptions set pending_change = $2::jsonb, updated_at = now() where id = $1`, [s.id, JSON.stringify(pc)]);
        await pushPrice(s, q.price, q.plan, q.connections, q.cycle);
        return { subscription: subView(await subOf(orgId)) };
      }
      case 'cancel_downgrade': {
        owner();
        const s = await subOf(orgId);
        if (!s || !s.pending_change) fail('Não há redução marcada.');
        await pool.query(`update public.subscriptions set pending_change = null, updated_at = now() where id = $1`, [s.id]);
        await pushPrice(s, Number(s.price));
        return { subscription: subView(await subOf(orgId)) };
      }
      case 'card_setup': { // Stripe: abre o formulário do cartão (trocar o cartão ou sair do Pix)
        owner();
        if (!cardStripe()) fail('O cartão pela Stripe ainda não foi ativado.');
        const s = await subOf(orgId);
        if (!s || !['ativa', 'inadimplente'].includes(s.status)) fail('Assine um plano primeiro.');
        const customer = await stripeCustomerFor(orgId, user, s);
        const si = await stripe.call('/setup_intents', 'POST', { customer, usage: 'off_session', payment_method_types: ['card'], metadata: { org: orgId } });
        return { stripe: { client_secret: si.client_secret, publishable_key: stripePk || null } };
      }
      case 'card_saved': { // Stripe: cartão confirmado no formulário; vira a forma de pagamento das próximas cobranças
        owner();
        const s = await subOf(orgId);
        if (!s || !/^seti_/.test(String(body.setup_intent || ''))) fail('Cartão não encontrado.');
        const si = await stripe.call(`/setup_intents/${body.setup_intent}`);
        if (si.status !== 'succeeded' || si.customer !== s.stripe_customer_id) fail('O cartão não foi confirmado. Tente de novo.');
        const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method.id;
        await stripe.call(`/customers/${s.stripe_customer_id}`, 'POST', { invoice_settings: { default_payment_method: pm } });
        const info = await cardInfo(pm);
        if (s.provider === 'stripe' && s.stripe_subscription_id) {
          await stripe.call(`/subscriptions/${s.stripe_subscription_id}`, 'POST', { default_payment_method: pm });
        } else { // sai do Pix (ou do Asaas): assinatura nova na Stripe que só cobra na renovação
          const pc = s.pending_change;
          const plan = pc ? pc.plan : s.plan_code, conns = pc ? pc.connections : s.connections, cyc = (pc && pc.cycle) || s.cycle, price = pc ? pc.price : Number(s.price);
          const prod = await stripe.product(plan, PLANS[plan].nome);
          const trialEnd = Math.max(Math.floor(new Date(s.current_period_end).getTime() / 1000), Math.floor(now().getTime() / 1000) + 3600);
          const ss = await stripe.call('/subscriptions', 'POST', { customer: s.stripe_customer_id, default_payment_method: pm, trial_end: trialEnd, description: planDesc(plan, conns, cyc),
            items: [{ price_data: { currency: 'brl', product: prod.id, unit_amount: cents(price), recurring: STRIPE_INTERVAL[cyc] } }], metadata: { org: orgId, kobly_sub: s.id } }, `move-${s.id}-${body.setup_intent}`);
          await stopRemote(s, { keepStripe: true });
          await pool.query(`update public.invoices set status = 'cancelada' where subscription_id = $1 and status = 'pendente'`, [s.id]);
          await pool.query(`update public.subscriptions set provider = 'stripe', stripe_subscription_id = $2, stripe_item_id = $3, asaas_subscription_id = null, pix_auth_id = null, pix_auth_status = null where id = $1`,
            [s.id, ss.id, ss.items && ss.items.data && ss.items.data[0] ? ss.items.data[0].id : null]);
        }
        await pool.query(`update public.subscriptions set billing_type = 'CREDIT_CARD', card_last4 = $2, card_brand = $3, updated_at = now() where id = $1`, [s.id, info.last4, info.brand]);
        return { subscription: subView(await subOf(orgId)) };
      }
      case 'change_card': { // assinatura antiga do Asaas: próximas cobranças no cartão novo
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
        if (!s || !['ativa', 'inadimplente'].includes(s.status)) fail('Assine um plano primeiro.');
        if (pixAutoOn() && s.provider !== 'pix_auto') {
          // na renovação chega um QR Code que paga e autoriza o Pix Automático; até lá nada é cobrado
          const c = await customerFor(orgId, user);
          await stopRemote(s, { keepPix: true });
          await pool.query(`update public.invoices set status = 'cancelada' where subscription_id = $1 and status = 'pendente'`, [s.id]);
          await pool.query(`update public.subscriptions set provider = 'pix_auto', billing_type = 'PIX', asaas_customer_id = $2, stripe_subscription_id = null, stripe_item_id = null, asaas_subscription_id = null,
              pix_auth_id = null, pix_auth_status = null, card_last4 = null, card_brand = null, updated_at = now() where id = $1`, [s.id, c.asaas_customer_id]);
          return { subscription: subView(await subOf(orgId)) };
        }
        if (!s.asaas_subscription_id) fail('O Pix ainda não está disponível para a sua assinatura. Fale com o suporte.');
        await asaas(`/subscriptions/${s.asaas_subscription_id}`, 'POST', { billingType: 'PIX', updatePendingPayments: true });
        await pool.query(`update public.subscriptions set billing_type = 'PIX', updated_at = now() where id = $1`, [s.id]);
        await syncPending(s.id);
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
        return { ...r, mrr: r2(r.mrr), recebido_mes: r2(mes), planos, enabled: configured(), pagamento: payInfo() };
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
        if (s && ['ativa', 'inadimplente', 'pendente'].includes(s.status)) await stopRemote(s);
        await pool.query(`insert into public.subscriptions (organization_id, plan_code, connections, cycle, price, status, current_period_end, note, started_at)
            values ($1,$2,$3,'mensal',0,'cortesia',$4,$5, now())
          on conflict (organization_id) do update set plan_code = excluded.plan_code, connections = excluded.connections, price = 0, status = 'cortesia', current_period_end = excluded.current_period_end,
            note = excluded.note, asaas_subscription_id = null, stripe_subscription_id = null, pix_auth_id = null, pix_auth_status = null, provider = null, pending_change = null, updated_at = now()`,
          [body.org_id, q.plan, q.connections, until, String(body.note || '').slice(0, 300) || null]);
        return { ok: true };
      }
      case 'cancel': {
        if (!UUID.test(String(body.org_id || ''))) fail('Escolha a conta.');
        const s = await subOf(body.org_id);
        if (!s) fail('Essa conta não tem assinatura.');
        await stopRemote(s);
        await pool.query(`update public.subscriptions set status = 'cancelada', canceled_at = now(), asaas_subscription_id = null, stripe_subscription_id = null, pix_auth_id = null, pix_auth_status = null, updated_at = now() where id = $1`, [s.id]);
        await pool.query(`update public.organizations set plano_status = null where id = $1`, [body.org_id]);
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  return { handle, admin, receiveWebhook, receiveStripe, tick, entitlement, usage, requireFeature, requireSlots, confirmPayment, configured };
}
