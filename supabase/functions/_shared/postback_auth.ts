// Autenticação do postback além do token na URL (migração 0073). Espelho de server/src/ingest/auth.js.
// Ordem: assinatura Kobly (HMAC no cabeçalho) → hottok da Hotmart → modo legado (só URL, se permitido).
// Prova presente porém inválida é SEMPRE recusada; sem prova, só passa se o token não exigir assinatura.
// ATENÇÃO: o deploy das functions não importa _shared — este código está INLINADO em postback-receiver/index.ts.

export const SIGNATURE_TOLERANCE_S = 300;

export type PostbackToken = { signing_secret: string; hottok: string | null; require_signature: boolean };
export type AuthResult = { ok: true; mode: "assinado" | "hottok" | "legado_url" } | { ok: false; reason: string };

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function parseSignature(header: string | null): { t: number | null; v1: string[] } {
  const out = { t: null as number | null, v1: [] as string[] };
  for (const part of String(header || "").split(",")) {
    const [k, v] = part.split("=").map((s) => (s || "").trim());
    if (k === "t" && /^\d{9,11}$/.test(v)) out.t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) out.v1.push(v.toLowerCase());
  }
  return out;
}

export async function signPostback(secret: string, t: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyPostbackAuth(
  token: PostbackToken, headers: Headers, rawBody: string, nowS = Math.floor(Date.now() / 1000),
): Promise<AuthResult> {
  const sigHeader = headers.get("x-kobly-signature");
  if (sigHeader) {
    const sig = parseSignature(sigHeader);
    if (!sig.t || !sig.v1.length) return { ok: false, reason: "assinatura_malformada" };
    if (Math.abs(nowS - sig.t) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: "assinatura_expirada" };
    const expected = await signPostback(token.signing_secret, sig.t, rawBody);
    return sig.v1.some((v) => timingEqual(v, expected)) ? { ok: true, mode: "assinado" } : { ok: false, reason: "assinatura_invalida" };
  }
  const hot = headers.get("x-hotmart-hottok");
  if (token.hottok && hot) return timingEqual(hot, token.hottok) ? { ok: true, mode: "hottok" } : { ok: false, reason: "hottok_invalido" };
  if (token.require_signature) return { ok: false, reason: token.hottok ? "hottok_obrigatorio" : "assinatura_obrigatoria" };
  return { ok: true, mode: "legado_url" };
}

// Token no cabeçalho (não vaza em log de URL) ou, por compatibilidade, na query.
export function tokenFrom(headers: Headers, url: URL): string | null {
  const auth = /^Bearer (pbk_[A-Za-z0-9]+)$/.exec(headers.get("authorization") || "");
  return headers.get("x-kobly-token") || (auth ? auth[1] : null) || url.searchParams.get("token");
}
