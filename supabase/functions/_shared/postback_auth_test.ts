// supabase/functions/_shared/postback_auth_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSignature, signPostback, verifyPostbackAuth, tokenFrom } from "./postback_auth.ts";

const tok = { signing_secret: "s".repeat(64), hottok: null, require_signature: false };
const body = '{"event":"pix_generated","email":"a@x.test"}';
const NOW = 1_800_000_000;
const h = (o: Record<string, string>) => new Headers(o);

Deno.test("assinatura válida passa; corpo alterado, segredo errado e horário vencido não", async () => {
  const sig = await signPostback(tok.signing_secret, NOW, body);
  assertEquals(await verifyPostbackAuth(tok, h({ "x-kobly-signature": `t=${NOW},v1=${sig}` }), body, NOW), { ok: true, mode: "assinado" });
  assertEquals((await verifyPostbackAuth(tok, h({ "x-kobly-signature": `t=${NOW},v1=${sig}` }), body + " ", NOW)).ok, false);
  const outra = await signPostback("x".repeat(64), NOW, body);
  assertEquals(await verifyPostbackAuth(tok, h({ "x-kobly-signature": `t=${NOW},v1=${outra}` }), body, NOW), { ok: false, reason: "assinatura_invalida" });
  assertEquals(await verifyPostbackAuth(tok, h({ "x-kobly-signature": `t=${NOW - 301},v1=${await signPostback(tok.signing_secret, NOW - 301, body)}` }), body, NOW), { ok: false, reason: "assinatura_expirada" });
  assertEquals(await verifyPostbackAuth(tok, h({ "x-kobly-signature": "lixo" }), body, NOW), { ok: false, reason: "assinatura_malformada" });
});

Deno.test("hottok da Hotmart, modo estrito e modo legado", async () => {
  const hot = { ...tok, hottok: "hottok-da-conta-123" };
  assertEquals(await verifyPostbackAuth(hot, h({ "x-hotmart-hottok": "hottok-da-conta-123" }), body, NOW), { ok: true, mode: "hottok" });
  assertEquals(await verifyPostbackAuth(hot, h({ "x-hotmart-hottok": "errado-errado-1" }), body, NOW), { ok: false, reason: "hottok_invalido" });
  assertEquals(await verifyPostbackAuth(tok, h({}), body, NOW), { ok: true, mode: "legado_url" });
  assertEquals(await verifyPostbackAuth({ ...tok, require_signature: true }, h({}), body, NOW), { ok: false, reason: "assinatura_obrigatoria" });
  assertEquals(await verifyPostbackAuth({ ...hot, require_signature: true }, h({}), body, NOW), { ok: false, reason: "hottok_obrigatorio" });
});

Deno.test("token pelo cabeçalho tem prioridade sobre a URL; parse da assinatura", () => {
  assertEquals(tokenFrom(h({ "x-kobly-token": "pbk_cab" }), new URL("https://x.test/?token=pbk_url")), "pbk_cab");
  assertEquals(tokenFrom(h({ authorization: "Bearer pbk_bearer" }), new URL("https://x.test/")), "pbk_bearer");
  assertEquals(tokenFrom(h({}), new URL("https://x.test/?token=pbk_url")), "pbk_url");
  assertEquals(parseSignature(`t=${NOW}, v1=${"a".repeat(64)}, v1=${"B".repeat(64)}`), { t: NOW, v1: ["a".repeat(64), "b".repeat(64)] });
});
