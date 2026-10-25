// Zenith (docs.zenithworld.com.br): pagamentos locais. Mesmo contrato dos outros gateways.
// POST /integrations/checkouts (X-API-Key + X-API-Secret, Idempotency-Key) com valor na menor unidade da moeda;
// a resposta traz nextAction (bank_transfer → CLABE do SPEI, qr_code, voucher, redirect).
// GET /integrations/checkouts/:id → pending | authorized | succeeded | failed | canceled | refunded.
// Ao conectar, a Kobly registra o webhook dela em POST /integrations/webhooks/endpoints; a confirmação
// continua sendo a consulta na API (o aviso só dispara a checagem).
import { randomBytes } from 'node:crypto';
import { PaymentError } from './xpag.js';

const STATUS = { pending: 'pending', authorized: 'pending', succeeded: 'confirmed', failed: 'failed', canceled: 'expired', refunded: 'failed' };
const COUNTRY = { MXN: 'MX' };
const qrFrom = (code) => (code ? `https://quickchart.io/qr?size=480&text=${encodeURIComponent(code)}` : null);

export function zenithNormalize(r) {
  const ck = r.checkout || r;
  const na = r.nextAction || {};
  let code = null, qr = null, link = null, extra = {};
  if (na.type === 'bank_transfer' && na.details) { code = na.details.clabe || null; extra = { beneficiario: na.details.beneficiary || '', banco: na.details.bank || na.details.bankName || '' }; }
  else if (na.type === 'qr_code') { code = na.code || null; qr = qrFrom(code); }
  else if (na.type === 'voucher') code = na.code || null;
  else if (na.type === 'redirect') link = na.url || null;
  const st = (r.payment && r.payment.status) || ck.status;
  return { transactionId: ck.id || null, requestNumber: ck.referenceId || null, status: STATUS[st] || 'pending', amount: ck.amount != null ? ck.amount / 100 : null, code, qr, link: link || (na.url || null), extra };
}

export function createZenith({ base = 'https://api.zenithworld.com.br', fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const headers = (cred, extra = {}) => ({ 'X-API-Key': cred.clientId, 'X-API-Secret': cred.clientSecret, 'Content-Type': 'application/json', ...extra });
  const env = (cred) => (cred.sandbox ? 'sandbox' : 'production');
  async function call(url, init) {
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new PaymentError(503, 'provider_unreachable', 'Zenith não respondeu.'); }
    let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
    if (res.status === 401 || res.status === 403) throw new PaymentError(400, 'invalid_credentials', 'Zenith: credencial recusada.');
    if (!res.ok) throw new PaymentError(res.status >= 500 ? 503 : 400, `http_${res.status}`, `Zenith: ${(j && (j.message || j.error)) || `HTTP ${res.status}`}`);
    return j || {};
  }
  return {
    label: 'Zenith', methods: { MXN: ['SPEI'] }, openAmountOk: () => false, needsClientId: true,
    checkCredentials: (cred) => call(`${base}/integrations/payment-methods?country=MX&currency=MXN&environment=${env(cred)}`, { headers: headers(cred) }),
    async registerWebhook(cred, { url }) {
      await call(`${base}/integrations/webhooks/endpoints`, { method: 'POST', headers: headers(cred),
        body: JSON.stringify({ name: 'Kobly', url, secret: randomBytes(24).toString('hex'), events: ['checkout.succeeded', 'payment.captured', 'payment.failed', 'payment.refunded', 'checkout.canceled'] }) });
    },
    async createCharge(cred, input) {
      if (input.openAmount) throw new PaymentError(400, 'open_amount_not_supported', 'Zenith não aceita valor livre.');
      if (!input.email) throw new PaymentError(400, 'missing_email', 'Zenith exige o e-mail real do cliente.');
      const origin = (() => { try { return new URL(input.webhookUrl).origin + '/'; } catch { return 'https://koblay.io/'; } })();
      const body = { amount: Math.round(Number(input.amount) * 100), currency: input.currency, country: COUNTRY[input.currency] || 'MX', environment: env(cred),
        paymentMethod: String(input.method || 'SPEI').toLowerCase(), referenceId: String(input.externalId).slice(0, 120),
        customerName: String(input.name || 'Cliente').slice(0, 140), customerEmail: input.email, returnUrl: origin, cancelUrl: origin };
      const r = await call(`${base}/integrations/checkouts`, { method: 'POST', headers: headers(cred, { 'Idempotency-Key': String(input.externalId).padEnd(8, '0').slice(0, 120) }), body: JSON.stringify(body) });
      return { ...zenithNormalize(r), raw: { id: (r.checkout || r).id, status: (r.checkout || r).status } };
    },
    async consult(cred, { transactionId }) {
      const n = zenithNormalize(await call(`${base}/integrations/checkouts/${encodeURIComponent(transactionId)}`, { headers: headers(cred) }));
      return { status: n.status, amount: n.amount };
    },
    // aviso: { id, type, createdAt, data: { paymentId, checkoutId, referenceId, amount, currency, status } }
    parseWebhook(body) {
      const d = body && body.data;
      if (!d || !d.checkoutId) return null;
      return { transactionId: String(d.checkoutId), externalId: d.referenceId || null, status: d.status || body.type || null, dedupeKey: String(body.id || `${d.checkoutId}:${body.type}`) };
    },
  };
}
