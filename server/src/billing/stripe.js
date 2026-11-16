// Stripe (cartão): chamadas à API REST e conferência da assinatura dos avisos (webhooks).
// Sem SDK: o corpo vai como formulário (a[b][0]=x), igual à documentação da Stripe. A versão da API fica fixa
// para as respostas não mudarem de formato sem aviso.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';

export const STRIPE_VERSION = '2024-06-20';

// { a: { b: [1, 2] } } -> a[b][0]=1&a[b][1]=2
export function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object' ? formEncode(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

export function createStripe({ secretKey = '', fetchImpl = globalThis.fetch }) {
  const on = () => !!secretKey;
  async function call(path, method = 'GET', body, idem) {
    if (!secretKey) throw new AuthError(503, 'stripe_off', 'O pagamento com cartão ainda não foi ativado no servidor da Kobly.');
    const headers = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_VERSION, 'Content-Type': 'application/x-www-form-urlencoded' };
    if (idem) headers['Idempotency-Key'] = idem;
    let res;
    const qs = method === 'GET' && body ? `?${formEncode(body)}` : '';
    try { res = await fetchImpl(`https://api.stripe.com/v1${path}${qs}`, { method, headers, body: method !== 'GET' && body ? formEncode(body) : undefined, signal: AbortSignal.timeout(25000) }); }
    catch { throw new AuthError(502, 'stripe_unreachable', 'O sistema do cartão não respondeu. Tente de novo em instantes.'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = j.error || {};
      const msg = e.code === 'card_declined' || e.decline_code ? 'O cartão foi recusado. Confira os dados ou use outro cartão.' : e.message || `Erro ${res.status} no cartão`;
      const err = new AuthError(res.status === 402 || res.status === 400 ? 422 : 502, 'stripe_error', msg);
      err.stripe = e; err.status = res.status;
      throw err;
    }
    return j;
  }
  // produto fixo por plano (id previsível): cria na primeira vez
  async function product(code, nome) {
    const id = `kobly_${code}`;
    try { return await call(`/products/${id}`); }
    catch (e) { if (e.status !== 404) throw e; return call('/products', 'POST', { id, name: `Kobly ${nome}` }); }
  }
  return { on, call, product };
}

// "t=123,v1=abc,v1=def" assinado com o segredo do webhook; aceita até 5 minutos de diferença
export function verifyStripeSignature(raw, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = (parts.find(([k]) => k === 't') || [])[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - Number(t)) > 300) return false;
  const want = createHmac('sha256', secret).update(`${t}.${String(raw)}`).digest('hex');
  return sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}
