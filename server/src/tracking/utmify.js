// UTMify: cada cobrança gerada pelo fluxo (XPag) vira um pedido na UTMify — "aguardando pagamento" ao
// gerar e "pago" ao confirmar —, com os UTMs do lead. Assim a venda recuperada pelo WhatsApp aparece no
// painel de tráfego com a origem certa. Vendas que nascem no checkout (Hotmart, Kiwify…) NÃO são enviadas:
// a própria plataforma já manda, e mandar de novo duplicaria.
// API: POST https://api.utmify.com.br/api-credentials/orders, cabeçalho x-api-token (docs.utmify.com.br/send-orders).
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';
import { UTM_KEYS } from '../ingest/utm.js';

export const UTMIFY_URL = 'https://api.utmify.com.br/api-credentials/orders';
const CURRENCIES = new Set(['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'CAD', 'COP', 'MXN', 'PYG', 'CLP', 'PEN', 'PLN']);
const COUNTRY = { BRL: 'BR', MXN: 'MX', COP: 'CO', ARS: 'AR', CLP: 'CL', PEN: 'PE', PYG: 'PY', USD: 'US', CAD: 'CA', GBP: 'GB', PLN: 'PL' };
// a UTMify só aceita credit_card | boleto | pix | paypal | free_price: transferências instantâneas
// (SPEI, Nequi, Bre-B, transferência) entram como pix; OXXO (voucher pago em loja) como boleto.
const METHOD = { PIX: 'pix', SPEI: 'pix', NEQUI: 'pix', BREB: 'pix', BANK_TRANSFER: 'pix', WALLET: 'pix', OXXO: 'boleto', CARD: 'credit_card' };
const utcStamp = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const cents = (v) => Math.round(Number(v || 0) * 100);

// Pedido no formato da UTMify. status: 'waiting_payment' | 'paid'. Devolve null se a moeda não é aceita.
export function buildUtmifyOrder({ charge, lead, product, status, test = false }) {
  if (!CURRENCIES.has(charge.currency)) return null;
  const total = cents(status === 'paid' ? (charge.paid_amount ?? charge.amount) : charge.amount);
  const utm = (lead && lead.utm) || {};
  const nome = [lead && lead.nome, lead && lead.sobrenome].filter(Boolean).join(' ').trim();
  const prodName = (product && product.nome) || (lead && lead.produto) || 'Pedido recuperado';
  return {
    orderId: `kobly-${charge.id}`,
    platform: 'Kobly',
    paymentMethod: METHOD[String(charge.method || '').toUpperCase()] || 'pix',
    status,
    createdAt: utcStamp(charge.created_at),
    approvedDate: status === 'paid' ? utcStamp(charge.confirmed_at || new Date()) : null,
    refundedAt: null,
    customer: { name: nome || (lead && lead.email) || 'Cliente', email: (lead && lead.email) || '', phone: (lead && lead.telefone) || null, document: null, country: COUNTRY[charge.currency] },
    products: [{ id: product ? product.id : `kobly-${String(prodName).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, name: prodName, planId: null, planName: null, quantity: 1, priceInCents: total }],
    trackingParameters: Object.fromEntries(UTM_KEYS.map((k) => [k, utm[k] || null])),
    // a XPag não informa a taxa na cobrança: comissão = total (a própria UTMify aceita quando a plataforma não sabe)
    commission: { totalPriceInCents: total, gatewayFeeInCents: 0, userCommissionInCents: total, ...(charge.currency === 'BRL' ? {} : { currency: charge.currency }) },
    ...(test ? { isTest: true } : {}),
  };
}

export function createUtmify({ pool, secretKey, fetchImpl = globalThis.fetch }) {
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'tracking_unconfigured', 'Integrações não configuradas neste ambiente (chave de segurança ausente).'); };
  async function post(token, order) {
    const r = await fetchImpl(UTMIFY_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-token': token }, body: JSON.stringify(order) });
    if (r.ok) return { ok: true };
    let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
    const msg = (j && (j.message || j.error)) || `HTTP ${r.status}`;
    return { ok: false, error: String(msg).slice(0, 200), status: r.status };
  }
  // pedido de teste (isTest: a UTMify valida tudo mas não grava) — confere a credencial ao conectar
  const testOrder = () => buildUtmifyOrder({
    charge: { id: 'teste', currency: 'BRL', method: 'PIX', amount: 1, created_at: new Date() },
    lead: { nome: 'Teste Kobly', email: 'teste@kobly.io', utm: { utm_source: 'kobly' } }, status: 'waiting_payment', test: true,
  });

  async function connect(orgId, token) {
    needKey();
    const t = String(token || '').trim();
    if (t.length < 16) throw new AuthError(422, 'validation_failed', 'Cole a credencial de API da UTMify (Integrações → Webhooks → Credenciais de API).');
    const r = await post(t, testOrder());
    if (!r.ok) throw new AuthError(400, 'utmify_rejected', `A UTMify recusou a credencial: ${r.error}`);
    await pool.query(`insert into public.tracking_integrations (organization_id, provider, token_enc, token_hint, status, last_error)
      values ($1,'utmify',$2,$3,'connected',null)
      on conflict (organization_id, provider) do update set token_enc = excluded.token_enc, token_hint = excluded.token_hint, status = 'connected', last_error = null`,
      [orgId, encrypt(t, secretKey), `…${t.slice(-4)}`]);
    return { ok: true };
  }

  // Chamado pelo fluxo; nunca derruba o fluxo. Sem UTMify conectada, não faz nada.
  async function onCharge(charge, status) {
    if (!secretKey || !charge) return { skipped: 'sem chave' };
    const integ = (await pool.query(`select id, token_enc from public.tracking_integrations where organization_id = $1 and provider = 'utmify'`, [charge.organization_id])).rows[0];
    if (!integ) return { skipped: 'sem UTMify' };
    const lead = charge.lead_id ? (await pool.query(`select nome, sobrenome, email, telefone, produto, utm from public.leads where id = $1`, [charge.lead_id])).rows[0] : null;
    const product = lead && lead.produto ? (await pool.query(`select id, nome from public.products where organization_id = $1 and (lower(nome) = lower($2) or $2 = any(aliases)) limit 1`, [charge.organization_id, lead.produto])).rows[0] : null;
    const order = buildUtmifyOrder({ charge, lead, product, status });
    const mark = (st, err) => pool.query(`update public.payment_charges set tracking_status = $2, tracking_error = $3 where id = $1`, [charge.id, st, err]).catch(() => {});
    if (!order) { await mark('ignorado', `moeda ${charge.currency} não aceita pela UTMify`); return { skipped: 'moeda' }; }
    let r;
    try { r = await post(decrypt(integ.token_enc, secretKey), order); } catch (e) { r = { ok: false, error: String(e.message || e).slice(0, 200) }; }
    await mark(r.ok ? status : 'erro', r.ok ? null : r.error);
    await pool.query(`update public.tracking_integrations set status = $2, last_error = $3, last_sent_at = case when $2 = 'connected' then now() else last_sent_at end where id = $1`,
      [integ.id, r.ok ? 'connected' : 'error', r.ok ? null : r.error]).catch(() => {});
    return r;
  }
  return { connect, onCharge };
}
