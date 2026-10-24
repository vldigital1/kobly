// Adaptador XPag (https://xpag.global/docs): cobrança (POST /cashin), consulta (GET /consult-transaction)
// e leitura do aviso (webhook). Sem dependências; fetch injetável. Credenciais por requisição
// (X-Client-Id / X-Client-Secret) — cada empresa usa a PRÓPRIA conta XPag.
//
// A XPag não documenta assinatura nos avisos: o serviço NUNCA confia no corpo do aviso; ele usa o
// aviso só como gatilho e confirma o status consultando a transação na API com a credencial da empresa.
export class PaymentError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Moedas e métodos que o bloco de pagamento oferece (o resto da XPag fica para depois).
export const XPAG_METHODS = {
  BRL: ['PIX'],
  MXN: ['SPEI', 'OXXO'],
  COP: ['NEQUI', 'BREB'],
  ARS: ['BANK_TRANSFER'],
  CLP: ['BANK_TRANSFER', 'CARD', 'WALLET'],
};
export const OPEN_AMOUNT_OK = (currency, method) => currency === 'BRL' || (currency === 'MXN' && method === 'SPEI');
const RETRY_CODES = new Set(['provider_unavailable', 'rate_limited', 'maintenance']);

// Corpo do POST /cashin conforme moeda/método.
export function buildCashin({ currency, method, amount, openAmount, name, document, email, phone, description, externalId, webhookUrl }) {
  const b = { currency, external_id: externalId, webhook_url: webhookUrl };
  if (!openAmount) b.amount = Number(amount);
  if (description) b.description = String(description).slice(0, 140);
  switch (currency) {
    case 'BRL': if (name) b.name = name; if (document) b.document = String(document).replace(/\D/g, ''); break;
    case 'MXN':
      if (method === 'OXXO') { b.method = 'OXXO'; b.payerData = { name: name || 'Cliente', ...(email ? { email } : {}) }; b.generateCheckout = false; }
      else { if (name) b.name = name; if (document) b.document = document; }
      break;
    case 'COP': b.method = method === 'BREB' ? 'BREB' : 'NEQUI_QR'; if (phone) b.phone = String(phone).replace(/\D/g, '').slice(-10); break;
    case 'ARS': b.method = 'BANK_TRANSFER'; b.name = name; if (document) { b.document = String(document).replace(/\D/g, ''); b.document_type = 'CUIT'; } break;
    case 'CLP': b.method = method || 'BANK_TRANSFER'; b.name = name; b.email = email; b.document = document; b.document_type = 'RUT'; b.amount = Math.round(Number(amount)); break;
    default: break;
  }
  return b;
}

const qrFrom = (code) => (code ? `https://quickchart.io/qr?size=480&text=${encodeURIComponent(code)}` : null);

// Resposta do /cashin → formato único usado pelo fluxo.
export function normalizeCharge(currency, method, r) {
  const pd = r.payee_data || {};
  let code = null, qr = null, link = r.checkout_url || null, extra = {};
  switch (currency) {
    case 'BRL': code = r.copyPaste || r.copy_paste || r.code || null; qr = r.qr_url || qrFrom(code); break;
    case 'MXN':
      // produção: payee_data.reference (+ imagem do código de barras); o sandbox devolve a referência em code/copy_paste
      if (method === 'OXXO') { code = pd.reference || r.reference || r.code || r.copy_paste || null; qr = /^https:\/\//.test(pd.barcode || '') ? pd.barcode : null; }
      else { code = r.clabe || null; extra = { referencia: r.reference || '', banco: r.bank_name || '', beneficiario: r.beneficiary || '' }; }
      break;
    case 'COP': code = r.copy_paste || r.code || r.breb_key || null; qr = r.qr_url || qrFrom(code); break;
    case 'ARS': code = pd.accountNumber || null; extra = { banco: pd.bankName || '', beneficiario: pd.name || '' }; break;
    case 'CLP': code = r.checkout_url || r.code || null; link = r.checkout_url || r.code || null; break;
    default: code = r.copy_paste || r.code || null;
  }
  return {
    transactionId: r.transaction_id || r.request_number || null, requestNumber: r.request_number || null,
    status: r.status || 'pending', amount: r.amount ?? null, code, qr, link, extra,
    awaitingInstruction: !!r.awaiting_instruction, expiresMinutes: r.expire_minutes ?? null, sandbox: !!r.sandbox,
  };
}

// Aviso → { transactionId, externalId, status, dedupeKey } (só como gatilho; o status vem da consulta).
export function parseWebhook(body) {
  if (!body || typeof body !== 'object' || body.type !== 'cashin') return null;
  const tx = body.transaction_id || body.request_number || null;
  if (!tx && !body.external_id) return null;
  return { transactionId: tx, externalId: body.external_id || null, status: body.status || null,
    dedupeKey: `${body.e2e || tx || body.external_id}:${body.status || ''}` };
}

export function createXpag({ base = 'https://api.xpag.global', fetchImpl = globalThis.fetch, timeoutMs = 20000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  async function call(cred, method, path, { body, query } = {}) {
    const url = new URL(base.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetchImpl(url, {
        method, headers: { 'X-Client-Id': cred.clientId, 'X-Client-Secret': cred.clientSecret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new PaymentError(503, 'provider_unreachable', 'O gateway de pagamento não respondeu.'); }
    let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
    if (!res.ok || (j && j.ok === false)) {
      const code = (j && j.error_code) || res.headers.get?.('x-app-error-code') || `http_${res.status}`;
      const status = res.ok ? 422 : res.status;
      throw new PaymentError(RETRY_CODES.has(code) ? 503 : status, code, (j && j.error) || `Gateway respondeu ${res.status}`);
    }
    return j || {};
  }

  async function createCharge(cred, input) {
    const r = await call(cred, 'POST', '/cashin', { body: buildCashin(input) });
    let n = normalizeCharge(input.currency, input.method, r);
    // ARS: o CVU chega alguns segundos depois; consulta rápida antes de seguir
    for (let i = 0; i < 3 && n.awaitingInstruction && !n.code && n.transactionId; i++) {
      await sleep(1500);
      const c = await call(cred, 'GET', '/consult-transaction', { query: { transaction_id: n.transactionId } }).catch(() => null);
      if (c && c.payee_data) n = { ...n, ...normalizeCharge(input.currency, input.method, { ...r, ...c }), awaitingInstruction: !!c.awaiting_instruction };
    }
    return { ...n, raw: r };
  }

  // Status real da transação (pending | confirmed | expired) — fonte da verdade para liberar o fluxo.
  async function consult(cred, { transactionId, externalId }) {
    const q = transactionId ? { transaction_id: transactionId } : { external_id: externalId };
    const r = await call(cred, 'GET', '/consult-transaction', { query: q });
    if (Array.isArray(r.payments)) { // chave estática (valor aberto): lista de pagamentos
      const paid = r.payments.find((p) => p.status === 'confirmed');
      return { status: paid ? 'confirmed' : (r.payments[0] && r.payments[0].status) || 'pending', amount: paid ? paid.amount : null };
    }
    return { status: r.status || 'pending', amount: r.amount ?? null };
  }

  // Valida a credencial (usada ao conectar): a consulta de saldo funciona de qualquer origem.
  const checkCredentials = (cred) => call(cred, 'GET', '/balance');

  return { createCharge, consult, checkCredentials };
}
