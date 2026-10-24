// Autenticação do postback além do token na URL (ver migração 0073).
// Ordem: assinatura Kobly (HMAC no cabeçalho) → hottok da Hotmart → modo legado (só URL, se permitido).
// Prova presente porém inválida é SEMPRE recusada; sem prova, só passa se o token não exigir assinatura.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_S = 300;
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// "t=1700000000,v1=abcd..." → { t, v1: [..] }
export function parseSignature(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || '').split(',')) {
    const [k, v] = part.split('=').map((s) => (s || '').trim());
    if (k === 't' && /^\d{9,11}$/.test(v)) out.t = Number(v);
    if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) out.v1.push(v.toLowerCase());
  }
  return out;
}
export const signPostback = (secret, t, rawBody) => createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');

// headers: objeto com nomes em minúsculas. Devolve { ok, mode, reason }.
export function verifyPostbackAuth({ token, headers = {}, rawBody = '', nowS = Math.floor(Date.now() / 1000) }) {
  const sigHeader = headers['x-kobly-signature'];
  if (sigHeader) {
    const sig = parseSignature(sigHeader);
    if (!sig.t || !sig.v1.length) return { ok: false, reason: 'assinatura_malformada' };
    if (Math.abs(nowS - sig.t) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: 'assinatura_expirada' };
    const expected = signPostback(token.signing_secret, sig.t, rawBody);
    return sig.v1.some((v) => eq(v, expected)) ? { ok: true, mode: 'assinado' } : { ok: false, reason: 'assinatura_invalida' };
  }
  const hot = headers['x-hotmart-hottok'];
  if (token.hottok && hot) return eq(hot, token.hottok) ? { ok: true, mode: 'hottok' } : { ok: false, reason: 'hottok_invalido' };
  if (token.require_signature) return { ok: false, reason: token.hottok ? 'hottok_obrigatorio' : 'assinatura_obrigatoria' };
  return { ok: true, mode: 'legado_url' };
}

// Token pode vir no cabeçalho (não vaza em log de URL) ou, por compatibilidade, na query.
export function tokenFrom(headers = {}, query = null) {
  const h = headers['x-kobly-token'] || (/^Bearer (pbk_[A-Za-z0-9]+)$/.exec(headers.authorization || '') || [])[1];
  return h || (query && query.get('token')) || null;
}
