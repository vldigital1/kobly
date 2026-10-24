// Assinatura do postback no formato que o servidor confere (migração 0073):
//   X-Kobly-Signature: t=<unix>,v1=<hex HMAC-SHA256(signing_secret, "<t>.<corpo>")>
// Usada pelo "Disparar evento de teste" e documentada para quem integra outras plataformas.
export async function signPostback(secret, t, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signedPostbackHeaders(token, secret, rawBody, nowS = Math.floor(Date.now() / 1000)) {
  return { 'X-Kobly-Token': token, 'X-Kobly-Signature': `t=${nowS},v1=${await signPostback(secret, nowS, rawBody)}` };
}

// Uso recente só pela URL (sem assinatura nem hottok) — a tela avisa nos últimos 7 dias.
export const usedUnsignedRecently = (t, now = Date.now()) => !!t.last_unsigned_at && now - new Date(t.last_unsigned_at).getTime() < 7 * 86400e3;
