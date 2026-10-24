// Gateways de Pix (BRL) no mesmo contrato da XPag: createCharge / consult / checkCredentials / parseWebhook.
// Mercado Pago: POST https://api.mercadopago.com/v1/payments (Bearer + X-Idempotency-Key), GET /v1/payments/{id}.
// Woovi (OpenPix): POST https://api.openpix.com.br/api/v1/charge (Authorization: AppID), GET /api/v1/charge/{id}.
// Como na XPag, o aviso do gateway só dispara a checagem: quem confirma é a consulta na API com a credencial.
import { PaymentError } from './xpag.js';

const qrFrom = (code) => (code ? `https://quickchart.io/qr?size=480&text=${encodeURIComponent(code)}` : null);
const PIX_ONLY = { BRL: ['PIX'] };

async function http(fetchImpl, url, init, timeoutMs, label) {
  let res;
  try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new PaymentError(503, 'provider_unreachable', `${label} não respondeu.`); }
  let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401 || res.status === 403) throw new PaymentError(400, 'invalid_credentials', `${label}: credencial recusada.`);
  if (res.status === 429) throw new PaymentError(503, 'rate_limited', `${label}: limite de requisições.`);
  if (!res.ok) throw new PaymentError(res.status >= 500 ? 503 : 400, `http_${res.status}`, (j && (j.message || j.error)) || `${label} respondeu ${res.status}`);
  return j || {};
}

// ---- Mercado Pago ---------------------------------------------------------------------------
const MP_STATUS = { approved: 'confirmed', authorized: 'pending', pending: 'pending', in_process: 'pending', in_mediation: 'pending', cancelled: 'expired', expired: 'expired', rejected: 'failed', refunded: 'failed', charged_back: 'failed' };

export function mpChargeBody({ amount, name, email, description, externalId, webhookUrl }) {
  const [first, ...rest] = String(name || '').trim().split(/\s+/);
  return {
    transaction_amount: Math.round(Number(amount) * 100) / 100, payment_method_id: 'pix',
    description: String(description || 'Pedido').slice(0, 140), external_reference: externalId,
    ...(webhookUrl ? { notification_url: webhookUrl } : {}),
    payer: { email: email || 'cliente@kobly.io', ...(first ? { first_name: first } : {}), ...(rest.length ? { last_name: rest.join(' ') } : {}) },
  };
}
export function mpNormalize(r) {
  const td = (r.point_of_interaction && r.point_of_interaction.transaction_data) || {};
  return { transactionId: r.id != null ? String(r.id) : null, requestNumber: null, status: MP_STATUS[r.status] || 'pending', amount: r.transaction_amount ?? null,
    code: td.qr_code || null, qr: qrFrom(td.qr_code), link: td.ticket_url || null, extra: {} };
}

export function createMercadoPago({ base = 'https://api.mercadopago.com', fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const auth = (cred) => ({ Authorization: `Bearer ${cred.clientSecret}` });
  return {
    label: 'Mercado Pago', methods: PIX_ONLY, openAmountOk: () => false, needsClientId: false,
    checkCredentials: (cred) => http(fetchImpl, `${base}/users/me`, { headers: auth(cred) }, timeoutMs, 'Mercado Pago'),
    async createCharge(cred, input) {
      if (input.openAmount) throw new PaymentError(400, 'open_amount_not_supported', 'Mercado Pago não aceita Pix de valor livre.');
      const r = await http(fetchImpl, `${base}/v1/payments`, { method: 'POST', headers: { ...auth(cred), 'Content-Type': 'application/json', 'X-Idempotency-Key': input.externalId }, body: JSON.stringify(mpChargeBody(input)) }, timeoutMs, 'Mercado Pago');
      return { ...mpNormalize(r), raw: { id: r.id, status: r.status } };
    },
    async consult(cred, { transactionId }) {
      const r = await http(fetchImpl, `${base}/v1/payments/${encodeURIComponent(transactionId)}`, { headers: auth(cred) }, timeoutMs, 'Mercado Pago');
      return { status: MP_STATUS[r.status] || 'pending', amount: r.transaction_amount ?? null };
    },
    // aviso: { type: "payment", action: "payment.updated", data: { id } } (sem status: a consulta decide)
    parseWebhook(body) {
      const id = body && body.data && body.data.id;
      if (!id || (body.type && body.type !== 'payment')) return null;
      return { transactionId: String(id), externalId: null, status: body.action || null, dedupeKey: `${body.id || id}:${body.action || ''}:${body.date_created || ''}` };
    },
  };
}

// ---- Woovi (OpenPix) ------------------------------------------------------------------------
const WOOVI_STATUS = { ACTIVE: 'pending', COMPLETED: 'confirmed', EXPIRED: 'expired' };

export function wooviNormalize(r) {
  const c = r.charge || r;
  return { transactionId: c.correlationID || null, requestNumber: c.globalID || null, status: WOOVI_STATUS[c.status] || 'pending',
    amount: c.value != null ? c.value / 100 : null, code: c.brCode || null, qr: c.qrCodeImage || qrFrom(c.brCode), link: c.paymentLinkUrl || null, extra: {} };
}

export function createWoovi({ base = 'https://api.openpix.com.br', fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const auth = (cred) => ({ Authorization: cred.clientSecret });
  return {
    label: 'Woovi', methods: PIX_ONLY, openAmountOk: () => false, needsClientId: false,
    checkCredentials: (cred) => http(fetchImpl, `${base}/api/v1/charge?limit=1`, { headers: auth(cred) }, timeoutMs, 'Woovi'),
    async createCharge(cred, input) {
      if (input.openAmount) throw new PaymentError(400, 'open_amount_not_supported', 'Use um valor fixo na Woovi.');
      const body = { correlationID: input.externalId, value: Math.round(Number(input.amount) * 100), comment: String(input.description || '').slice(0, 140) };
      // return_existing: repetir com o mesmo correlationID devolve a mesma cobrança (idempotente)
      const r = await http(fetchImpl, `${base}/api/v1/charge?return_existing=true`, { method: 'POST', headers: { ...auth(cred), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs, 'Woovi');
      return { ...wooviNormalize(r), raw: { correlationID: (r.charge || r).correlationID, status: (r.charge || r).status } };
    },
    async consult(cred, { transactionId, externalId }) {
      const r = await http(fetchImpl, `${base}/api/v1/charge/${encodeURIComponent(transactionId || externalId)}`, { headers: auth(cred) }, timeoutMs, 'Woovi');
      const n = wooviNormalize(r);
      return { status: n.status, amount: n.amount };
    },
    // aviso: { event: "OPENPIX:CHARGE_COMPLETED", charge: { correlationID, … } }
    parseWebhook(body) {
      const c = body && body.charge;
      if (!c || !c.correlationID) return null;
      return { transactionId: c.correlationID, externalId: c.correlationID, status: body.event || null, dedupeKey: `${c.correlationID}:${body.event || ''}` };
    },
  };
}
