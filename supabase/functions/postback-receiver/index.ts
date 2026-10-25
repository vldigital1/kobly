// Kobly — Edge Function `postback-receiver` (PÚBLICA, verify_jwt=false).
// URL universal de postback: qualquer plataforma pode chamar com JSON padronizado.
// Autenticação: token na query string (?token=pbk_xxx) → valida via RPC validate_postback_token.
// Payload esperado (contrato genérico Kobly):
//   { event, email, name, product, value, payment_method, external_id, metadata }
// Também aceita nativamente o payload de Webhook da Hotmart (v2), sem tradução manual
// pelo cliente: { event: "PURCHASE_APPROVED", data: { buyer: {...}, purchase: {...} } },
// e o postback nativo da NexoPayt/NexusPayt (família Payt), detectado pelo shape
// { transaction: {...}, customer: {...}, integration_key } — sem campo `event` no raiz.
// Também aceita o envelope ENTITY (provedor de checkout tipo CloudEvents), detectado por
// { kind: "ENTITY", event: "entity.transaction.created"|"entity.transaction.paid"|...,
// data: { customer, items, amount (CENTAVOS), status: {value}, method: {value,label} } } —
// reaproveita a MESMA regra de negócio do adapter NexoPayt (resolveNexopaytTipoEvento).
// Mapeamento event/status → tipo_evento é feito internamente (EVENT_MAP / HOTMART_EVENT_MAP /
// NEXOPAYT_PAYMENT_STATUS_MAP + NEXOPAYT_ORDER_STATUS_MAP).
// Link de recuperação: extractRecoveryLink varre o payload por um link de checkout/carrinho
// (checkout_url, billet_url, link em metadata…) e grava em leads.link_recuperacao → o botão
// do e-mail ({{cta_link}}) é apontado pra lá no envio.
// Fluxo core: webhook_events (idempotente) → upsert lead → enfileira steps.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-kobly-token, x-kobly-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const RATE_LIMIT_PER_MIN = 120;
// Achados dos revisores (Tarefa 3d): sem limite no que é gravado por evento no
// dead-letter — trunca o payload cru quando passa de ~16 KB, guardando só o
// início (~8 KB) em vez do corpo inteiro.
const DEAD_LETTER_MAX_BYTES = 16 * 1024;
const DEAD_LETTER_HEAD_BYTES = 8 * 1024;

// ── Mapeamento event → tipo_evento (enum do banco) — contrato genérico Kobly ──
const EVENT_MAP: Record<string, string> = {
  cart_abandoned: "Abandono de carrinho",
  payment_approved: "Compra Aprovada",
  payment_refused: "Compra Recusada",
  payment_refunded: "Compra Reembolsada",
  payment_chargeback: "Chargeback",
  payment_canceled: "Compra cancelada",
  subscription_canceled: "Cancelamento de Assinatura",
  pix_generated: "Pix Gerado",
  boleto_generated: "Boleto Gerado",
  deposit_requested: "Depósito Solicitado",
};

// ── Mapeamento nativo Hotmart (Webhook v2) → tipo_evento ──
// Confirmado na doc oficial: PURCHASE_APPROVED/COMPLETE/CANCELED/EXPIRED/REFUNDED/
// CHARGEBACK/BILLET_PRINTED, SUBSCRIPTION_CANCELLATION. PURCHASE_OUT_OF_SHOPPING_CART
// (abandono de carrinho) e eventos de PROTEST/DELAYED não têm 1:1 confirmado — ficam
// de fora do mapa (evento cai em "ignored", não quebra o webhook). A Hotmart não expõe
// um evento dedicado de "Pix gerado" (só o status final da compra), então esse gatilho
// não tem equivalente nativo — ajustar aqui assim que o 1º payload real confirmar nomes.
const HOTMART_EVENT_MAP: Record<string, string> = {
  PURCHASE_APPROVED: "Compra Aprovada",
  PURCHASE_COMPLETE: "Compra Aprovada",
  PURCHASE_CANCELED: "Compra cancelada",
  PURCHASE_EXPIRED: "Compra cancelada",
  PURCHASE_REFUNDED: "Compra Reembolsada",
  PURCHASE_CHARGEBACK: "Chargeback",
  PURCHASE_BILLET_PRINTED: "Boleto Gerado",
  PURCHASE_OUT_OF_SHOPPING_CART: "Abandono de carrinho",
  SUBSCRIPTION_CANCELLATION: "Cancelamento de Assinatura",
};

// Payload é "formato Hotmart" quando vem aninhado em `data.{buyer,purchase,subscriber}`
// em vez do contrato plano da Kobly (email/name/product no nível raiz).
function isHotmartShaped(body: any): boolean {
  return !!(body && body.data && (body.data.buyer || body.data.purchase || body.data.subscriber));
}

// ── Mapeamento nativo NexoPayt/NexusPayt (família Payt) → tipo_evento ──
// Formato do postback baseado na família Payt/NexoPayt (ref. pública: ventuinha/payt-postback).
// Campos: integration_key, transaction_id, status (pedido), customer{name,email,phone,doc},
//   transaction{payment_method, payment_status, total_price}, product{name,price}, payment_method.
// ⚠️ A CONFIRMAR com 1 postback REAL da conta NexoPayt:
//   (a) unidade de total_price (heurística: string decimal => reais; inteiro => centavos);
//   (b) nomes exatos dos campos/status (se a NexoPayt divergir da família Payt).
// Auth: o token pbk_ da URL já autentica a org — integration_key NÃO é validada aqui.
// transaction.payment_status (lifecycle de pagamento) → tipo_evento (enum Kobly).
const NEXOPAYT_PAYMENT_STATUS_MAP: Record<string, string> = {
  paid: "Compra Aprovada",
  refused: "Compra Recusada",
  one_click_buy_refused: "Compra Recusada",
  refunded: "Compra Reembolsada",
  refunded_partial: "Compra Reembolsada",
  one_click_buy_refunded: "Compra Reembolsada",
  one_click_buy_refunded_partial: "Compra Reembolsada",
  pending_refund: "Compra Reembolsada",
  chargeback: "Chargeback",
  chargeback_presented: "Chargeback",
  canceled: "Compra cancelada",
  expired: "Compra cancelada",
  peding_refund: "Compra Reembolsada",
};
// status (pedido) → tipo_evento, para casos não cobertos pelo payment_status.
const NEXOPAYT_ORDER_STATUS_MAP: Record<string, string> = {
  paid: "Compra Aprovada",
  canceled: "Compra cancelada",
  lost_cart: "Abandono de carrinho",
  subscription_canceled: "Cancelamento de Assinatura",
};
const NEXOPAYT_PAYMENT_LABEL: Record<string, string> = { pix: "Pix", credit_card: "Cartão", boleto: "Boleto" };

// ── Mapeamento nativo ENTITY: sufixo de body.event ("entity.transaction.<x>") → tipo_evento ──
// Achados dos revisores: antes o tipo_evento saía SÓ de data.status.value, ignorando
// body.event. Provedores costumam mandar entity.transaction.refunded/.chargeback/.canceled
// mantendo status.value="paid" (o status "congela" no último valor conhecido do pagamento
// em si) — sem cruzar com o event, isso mapearia como "Compra Aprovada" (erro silencioso).
// Sufixos com mapeamento próprio CONFIRMADO aqui PREVALECEM sobre o status (ver uso abaixo).
// "created" fica de fora de propósito: não tem tipo_evento fixo (depende do método via
// status.value=waiting_payment → Pix Gerado/Boleto Gerado), então cai no fallback por status.
const ENTITY_EVENT_SUFFIX_MAP: Record<string, string> = {
  paid: "Compra Aprovada",
  refused: "Compra Recusada",
  refunded: "Compra Reembolsada",
  chargeback: "Chargeback",
  canceled: "Compra cancelada",
  cancelled: "Compra cancelada",
};

function resolveNexopaytTipoEvento(root: Record<string, any>, tx: Record<string, any>, pm: string): string | null {
  const payStatus = String(tx.payment_status ?? root.payment_status ?? "").toLowerCase();
  const orderStatus = String(root.status ?? "").toLowerCase();
  // waiting_payment → depende do método: pix → Pix Gerado, boleto → Boleto Gerado
  if (payStatus === "waiting_payment" || orderStatus === "waiting_payment") {
    if (pm === "boleto") return "Boleto Gerado";
    if (pm === "pix") return "Pix Gerado";
    return null;
  }
  return NEXOPAYT_PAYMENT_STATUS_MAP[payStatus] || NEXOPAYT_ORDER_STATUS_MAP[orderStatus] || null;
}

// Payload é "formato NexoPayt/NexusPayt" quando traz os objetos `transaction`/`customer`
// e/ou a `integration_key` no raiz. Não colide com o Hotmart (aninhado em `data.*`) nem
// com o contrato genérico Kobly (event+email planos, sem esses campos) — mesmo assim o
// chamador checa Hotmart ANTES e o contrato genérico DEPOIS deste shape.
function isNexopaytShaped(body: any): boolean {
  if (!body || typeof body !== "object" || isHotmartShaped(body)) return false;
  // NexoPayt NÃO manda `event` no raiz; o contrato genérico Kobly SEMPRE manda.
  // Sem este guard, um payload genérico que também trouxesse `customer`/`transaction`
  // seria "roubado" pelo branch nexopayt e mal interpretado.
  if (typeof body.event === "string") return false;
  const hasTx = !!body.transaction && typeof body.transaction === "object";
  const hasCustomer = !!body.customer && typeof body.customer === "object";
  return hasTx || hasCustomer || typeof body.integration_key === "string";
}

// Payload é "formato ENTITY" (envelope tipo CloudEvents de um provedor de checkout)
// quando kind === "ENTITY" e event começa com "entity.transaction.". Confirmado por
// payload REAL capturado em produção (webhook_dead_letter, reason=unknown_event_or_missing_email,
// 20/07/2026): 16x entity.transaction.created (status.value=waiting_payment, method.value=pix)
// e 10x entity.transaction.paid (status.value=paid, method.value=pix).
function isEntityShaped(body: any): boolean {
  return !!(body && body.kind === "ENTITY" && typeof body.event === "string" && body.event.startsWith("entity.transaction."));
}

// Normaliza os quatro formatos aceitos (genérico Kobly, nativo Hotmart, nativo
// NexoPayt/NexusPayt e envelope ENTITY) para um único shape interno. Retorna null quando o evento não é
// reconhecido/mapeável (nesse caso o chamador deve responder 200 "ignored", nunca 4xx —
// a Hotmart desativa automaticamente um Webhook que fica respondendo erro).
// `isPix` é opcional: só o branch nexopayt o preenche; nos demais o chamador deriva
// do sourceEvent (compat com o comportamento anterior).
// Cakto (docs.cakto.com.br): { secret, event, data: { id, status, amount, paymentMethod, checkoutUrl, customer, product, pix } }.
const CAKTO_EVENT_MAP: Record<string, string> = {
  purchase_approved: "Compra Aprovada",
  purchase_refused: "Compra Recusada",
  pix_gerado: "Pix Gerado",
  boleto_gerado: "Boleto Gerado",
  refund: "Compra Reembolsada",
  chargeback: "Chargeback",
  checkout_abandonment: "Abandono de carrinho",
  subscription_canceled: "Cancelamento de Assinatura"
};
function isCaktoShaped(body: any): boolean {
  return !!(body && typeof body.event === "string" && CAKTO_EVENT_MAP[body.event] && body.data && typeof body.data === "object" && body.data.customer && "secret" in body);
}
// PerfectPay (help.perfectpay.com.br): { token, code, sale_amount, sale_status_enum, sale_status_detail, payment_type_enum, customer, product, metadata }.
// Vem SEM "event" e com "customer": precisa ser reconhecida antes da NexoPayt.
const PERFECTPAY_STATUS_MAP: Record<number, string> = { 2: "Compra Aprovada", 10: "Compra Aprovada", 5: "Compra Recusada", 6: "Compra cancelada", 13: "Compra cancelada", 7: "Compra Reembolsada", 9: "Chargeback", 12: "Abandono de carrinho" };
const PERFECTPAY_PAYMENT_LABEL: Record<number, string> = { 1: "Cartão", 2: "Boleto", 3: "PayPal", 4: "Cartão", 5: "Grátis", 6: "Cartão" };
function isPerfectPayShaped(body: any): boolean {
  return !!(body && typeof body.event !== "string" && body.sale_status_enum !== undefined && body.code && body.customer && typeof body.customer === "object");
}
function resolvePerfectPayTipoEvento(body: any): string | null {
  const st = Number(body.sale_status_enum);
  const detail = String(body.sale_status_detail || "").toLowerCase();
  if (st === 1 || st === 3) {
    if (Number(body.payment_type_enum) === 2 || body.billet_url) return "Boleto Gerado";
    if (detail.includes("pix")) return "Pix Gerado";
    return null;
  }
  if (st === 0 && detail === "checkout_saved") return "Abandono de carrinho";
  return PERFECTPAY_STATUS_MAP[st] || null;
}
// Kiwify (docs.kiwify.com.br/api-reference/webhooks/receiving): { order_id, order_status, webhook_event_type, … }.
// Os campos de cliente/produto/valor não estão no exemplo oficial: lidos nas duas grafias (Customer/customer).
const KIWIFY_EVENT_MAP: Record<string, string> = {
  billet_created: "Boleto Gerado",
  pix_created: "Pix Gerado",
  order_approved: "Compra Aprovada",
  order_rejected: "Compra Recusada",
  order_refunded: "Compra Reembolsada",
  chargeback: "Chargeback",
  subscription_canceled: "Cancelamento de Assinatura"
};
function isKiwifyShaped(body: any): boolean {
  return !!(body && typeof body.event !== "string" && body.order_id && (typeof body.webhook_event_type === "string" || typeof body.order_status === "string"));
}
// Kirvano (help.kirvano.com): { event: "PIX_GENERATED", sale_id, checkout_id, total_price: "R$ 169,80", customer, products, payment }.
const KIRVANO_EVENT_MAP: Record<string, string> = {
  PIX_GENERATED: "Pix Gerado",
  BANK_SLIP_GENERATED: "Boleto Gerado",
  SALE_APPROVED: "Compra Aprovada",
  SALE_REFUSED: "Compra Recusada",
  SALE_REFUNDED: "Compra Reembolsada",
  SALE_CHARGEBACK: "Chargeback",
  ABANDONED_CART: "Abandono de carrinho",
  PIX_EXPIRED: "Compra cancelada",
  BANK_SLIP_EXPIRED: "Compra cancelada"
};
function isKirvanoShaped(body: any): boolean {
  return !!(body && typeof body.event === "string" && KIRVANO_EVENT_MAP[body.event] && (body.sale_id || body.checkout_id));
}
// "R$ 1.169,80" / "169.80" / 169.8 → número
function moneyBR(v: any): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[^\d,.-]/g, "");
  const n = s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s);
  return Number.isFinite(n) ? n : null;
}

// Prova de origem por plataforma (0079): com a chave da plataforma cadastrada no token, o aviso
// precisa provar que veio dela. Kirvano não documenta a prova; Hotmart usa o hottok (verifyPostbackAuth).
async function verifyPlatformProof(platform: string, secret: string, rawBody: string, body: any, signature: string | null): Promise<boolean> {
  const same = (a: unknown, b: string) => typeof a === "string" && a.length === b.length && timingSafe(a, b);
  switch (platform) {
    case "kiwify": {
      if (!signature) return false;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
      const hex = Array.from(mac).map((x) => x.toString(16).padStart(2, "0")).join("");
      return same(String(signature).toLowerCase(), hex);
    }
    case "cakto": return same(body && body.secret, secret);
    case "payt": return same(body && body.integration_key, secret);
    case "perfectpay": return same(body && body.token, secret);
    default: return true;
  }
}
function timingSafe(a: string, b: string): boolean {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function normalizePayload(body: any): {
  tipoEvento: string; email: string | null; name: string | null; phone: string | null;
  product: string | null; value: number | null; paymentMethod: string | null;
  externalId: string | null; sourceEvent: string; isPix?: boolean;
} | null {
  if (!body) return null;

  if (isHotmartShaped(body)) {
    const tipoEvento = HOTMART_EVENT_MAP[body.event];
    if (!tipoEvento) return null;
    const buyer = body.data.buyer || body.data.subscriber || {};
    const purchase = body.data.purchase || {};
    const product = body.data.product || {};
    if (!buyer.email) return null;
    return {
      tipoEvento,
      email: buyer.email,
      name: buyer.name || null,
      phone: buyer.checkout_phone ?? buyer.phone ?? null, // checkout_phone é o campo comum do Webhook v2
      product: product.name || null,
      value: purchase?.price?.value ?? purchase?.full_price?.value ?? null,
      paymentMethod: purchase?.payment?.type || null,
      // Idempotência por TRANSIÇÃO de status (igual ao branch nexopayt): a Hotmart usa
      // o MESMO transaction code em APPROVED e depois em REFUNDED/CHARGEBACK — sem o
      // sufixo do tipo_evento, o refund era dedupado e fluxos de reembolso nunca disparavam.
      externalId: body.data.purchase?.transaction
        ? `${body.data.purchase.transaction}:${tipoEvento}`
        : (body.id || null),
      sourceEvent: body.event,
    };
  }

  // NexoPayt/NexusPayt: sem campo `event` no raiz — o evento sai dos status. Status não
  // mapeável → null (200 "ignored" no chamador, nunca 4xx).
  if (isCaktoShaped(body)) {
    const d = body.data;
    const tipoEvento2 = CAKTO_EVENT_MAP[body.event];
    const c = d.customer || {};
    if (!c.email) return null;
    const amount = d.amount ?? d.baseAmount ?? d.offer?.price;
    const pm = String(d.paymentMethod || "").toLowerCase();
    return {
      tipoEvento: tipoEvento2,
      email: c.email,
      name: c.name || null,
      phone: c.phone || null,
      product: d.product?.name || d.offer?.name || null,
      value: amount != null && !Number.isNaN(Number(amount)) ? Number(amount) : null,
      paymentMethod: NEXOPAYT_PAYMENT_LABEL[pm] || (pm || null),
      // idempotência por transição: o mesmo pedido passa por pix_gerado e depois purchase_approved
      externalId: d.id ? `${d.id}:${tipoEvento2}` : null,
      sourceEvent: body.event,
      isPix: tipoEvento2 === "Pix Gerado"
    };
  }
  if (isPerfectPayShaped(body)) {
    const tipoEvento2 = resolvePerfectPayTipoEvento(body);
    if (!tipoEvento2) return null;
    const c = body.customer || {};
    if (!c.email) return null;
    const phone = `${c.phone_area_code ?? ""}${c.phone_number ?? ""}` || null;
    return {
      tipoEvento: tipoEvento2,
      email: c.email,
      name: c.full_name || null,
      phone,
      product: body.product?.name || body.plan?.name || null,
      value: body.sale_amount != null && !Number.isNaN(Number(body.sale_amount)) ? Number(body.sale_amount) : null,
      paymentMethod: PERFECTPAY_PAYMENT_LABEL[Number(body.payment_type_enum)] || null,
      externalId: `${body.code}:${tipoEvento2}`,
      sourceEvent: String(body.sale_status_detail || body.sale_status_enum),
      isPix: tipoEvento2 === "Pix Gerado"
    };
  }
  if (isKiwifyShaped(body)) {
    const ev = String(body.webhook_event_type || "");
    const st = String(body.order_status || "").toLowerCase();
    const pm = String(body.payment_method || "").toLowerCase();
    let tipoEvento2 = KIWIFY_EVENT_MAP[ev] || null;
    if (!tipoEvento2) tipoEvento2 = st === "paid" ? "Compra Aprovada" : st === "refused" ? "Compra Recusada" : st === "refunded" ? "Compra Reembolsada" : st === "chargedback" ? "Chargeback"
      : st === "waiting_payment" ? (pm === "pix" ? "Pix Gerado" : pm === "boleto" ? "Boleto Gerado" : null) : null;
    if (!tipoEvento2) return null;
    const c = body.Customer || body.customer || {};
    if (!c.email) return null;
    const prod = body.Product || body.product || {};
    const com = body.Commissions || body.commissions || {};
    const cents = com.charge_amount ?? body.charge_amount ?? null;
    return {
      tipoEvento: tipoEvento2,
      email: c.email,
      name: c.full_name || c.name || null,
      phone: c.mobile || c.phone || null,
      product: prod.product_name || prod.name || null,
      value: cents != null && !Number.isNaN(Number(cents)) ? Number(cents) / 100 : null,
      paymentMethod: NEXOPAYT_PAYMENT_LABEL[pm] || (pm || null),
      externalId: `${body.order_id}:${tipoEvento2}`,
      sourceEvent: ev || st,
      isPix: tipoEvento2 === "Pix Gerado"
    };
  }
  if (isKirvanoShaped(body)) {
    const tipoEvento2 = KIRVANO_EVENT_MAP[body.event];
    const c = body.customer || {};
    if (!c.email) return null;
    const prods = Array.isArray(body.products) ? body.products : [];
    const pm = String(body.payment_method || body.payment?.method || "").toLowerCase();
    const id = body.sale_id || body.checkout_id;
    return {
      tipoEvento: tipoEvento2,
      email: c.email,
      name: c.name || null,
      phone: c.phone_number || c.phone || null,
      product: prods.map((p: any) => p && (p.name || p.offer_name)).filter(Boolean).join(", ") || null,
      value: moneyBR(body.total_price),
      paymentMethod: NEXOPAYT_PAYMENT_LABEL[pm] || (pm || null),
      externalId: `${id}:${tipoEvento2}`,
      sourceEvent: body.event,
      isPix: tipoEvento2 === "Pix Gerado"
    };
  }
  if (isNexopaytShaped(body)) {
    const tx = (body.transaction ?? {}) as Record<string, any>;
    const pm = String(tx.payment_method ?? body.payment_method ?? "").toLowerCase();
    const tipoEvento = resolveNexopaytTipoEvento(body, tx, pm);
    if (!tipoEvento) return null;
    const c = (body.customer ?? {}) as Record<string, any>;
    const prod = (body.product ?? {}) as Record<string, any>;
    if (!c.email) return null;
    // Heurística de UNIDADE do valor: string decimal ("197.90") => já em reais;
    // inteiro ("19790") => centavos. ⚠️ A CONFIRMAR com 1 postback real.
    const rawStr = String(tx.total_price ?? body.total_price ?? prod.price ?? "");
    const n = Number(rawStr);
    const value = !n ? null : (rawStr.includes(".") ? Math.round(n * 100) / 100 : Math.round(n) / 100);
    const txId = body.transaction_id ?? tx.id ?? body.id ?? null;
    return {
      tipoEvento,
      email: c.email,
      name: c.name ?? null,
      phone: c.phone ?? c.phone_number ?? null,
      product: prod.name ?? prod.title ?? null,
      value,
      paymentMethod: NEXOPAYT_PAYMENT_LABEL[pm] ?? (pm || null),
      externalId: txId ? `${txId}:${tipoEvento}` : null, // idempotência por transição de status
      sourceEvent: String(tx.payment_status || body.payment_status || body.status || ""),
      isPix: tipoEvento === "Pix Gerado",
    };
  }

  // Envelope ENTITY: NÃO inventa mapeamento novo — reaproveita resolveNexopaytTipoEvento
  // (a MESMA função/regra de negócio do adapter NexoPayt), passando data.status.value como
  // payment_status/status e data.method.value como método. waiting_payment+pix => "Pix
  // Gerado", waiting_payment+boleto => "Boleto Gerado", paid => "Compra Aprovada", e os
  // demais status (refused/refunded/chargeback/canceled) já herdam de NEXOPAYT_PAYMENT_STATUS_MAP
  // por usarem o mesmo vocabulário de valores.
  if (isEntityShaped(body)) {
    const d = (body.data ?? {}) as Record<string, any>;
    const pm = String(d.method?.value ?? "").toLowerCase();
    const statusValue = String(d.status?.value ?? "").toLowerCase();
    // Sufixo de body.event, ex.: "entity.transaction.paid" → "paid".
    const eventSuffix = body.event.slice("entity.transaction.".length).toLowerCase();
    const suffixTipoEvento = ENTITY_EVENT_SUFFIX_MAP[eventSuffix] ?? null;
    let tipoEvento: string | null;
    if (suffixTipoEvento) {
      // event tem mapeamento próprio confirmado para este sufixo → PREVALECE sobre
      // data.status.value (cobre entity.transaction.refunded/.chargeback/.canceled
      // chegando com status.value ainda em "paid").
      tipoEvento = suffixTipoEvento;
    } else {
      // Sufixo sem mapeamento próprio (ex.: "created") → deriva do status, igual ao
      // adapter NexoPayt (waiting_payment+pix/boleto). Único par CONFIRMADO em produção
      // para "created" é status=waiting_payment (ver isEntityShaped acima) — qualquer
      // outra combinação é não prevista: devolve null (dead-letter) em vez de adivinhar.
      tipoEvento = eventSuffix === "created" && statusValue === "waiting_payment"
        ? resolveNexopaytTipoEvento({ status: statusValue, payment_status: statusValue }, {}, pm)
        : null;
    }
    if (!tipoEvento) return null;
    const c = (d.customer ?? {}) as Record<string, any>;
    if (!c.email) return null;
    const items = Array.isArray(d.items) ? d.items : [];
    const product = items.map((i: any) => i?.name).filter(Boolean).join(", ") || null;
    // amount vem em CENTAVOS — confirmado no dead-letter real comparando com o preço do
    // item (ex.: amount=1490 + item "Atendimento Prioritário" price=1490 => R$14,90 plausível).
    const value = d.amount != null && !Number.isNaN(Number(d.amount)) ? Math.round(Number(d.amount)) / 100 : null;
    const rawPhone = c.phone;
    const phone = rawPhone && typeof rawPhone === "object"
      ? (`${rawPhone.countryCode ?? ""}${rawPhone.number ?? ""}` || null)
      : (typeof rawPhone === "string" ? rawPhone : null);
    const txId = d.id ?? null;
    return {
      tipoEvento,
      email: c.email,
      name: c.name ?? null,
      phone,
      product,
      value,
      paymentMethod: d.method?.label || NEXOPAYT_PAYMENT_LABEL[pm] || (pm || null),
      // idempotência por TRANSIÇÃO de status: o mesmo data.id se repete entre
      // entity.transaction.created e entity.transaction.paid (confirmado no dead-letter real).
      externalId: txId ? `${txId}:${tipoEvento}` : null,
      sourceEvent: statusValue || body.event,
      isPix: tipoEvento === "Pix Gerado",
    };
  }

  if (!body.event) return null;
  const tipoEvento = EVENT_MAP[body.event];
  if (!tipoEvento || !body.email) return null;
  return {
    tipoEvento,
    email: body.email,
    name: body.name || null,
    phone: body.phone ?? null,
    product: body.product || null,
    value: body.value ?? null,
    paymentMethod: body.payment_method || null,
    externalId: body.external_id || null,
    sourceEvent: body.event,
  };
}

// Varre o payload cru atrás do MELHOR link de recuperação/checkout que a plataforma
// mandar (varia por provedor: checkout_url, billet_url, link em metadata, etc.).
// Pontua por relevância da chave e ignora URLs de imagem/logo/callback. Esse link vira
// o destino do botão do e-mail (trocado no envio pelo process-steps).
// Parâmetros de rastreio (UTM, src, sck) — mesma regra de server/src/ingest/utm.js (Trackeamento, 0075).
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src", "sck"];
const UTM_ALIAS: Record<string, string> = { xcod: "sck", source: "utm_source", medium: "utm_medium", campaign: "utm_campaign", content: "utm_content", term: "utm_term" };
const UTM_PARENTS = /^(utm|utms|tracking|trackingparameters|tracking_parameters|origin|origem)$/i;
const UTM_URL_KEYS = /^(checkout_?url|url|link|page_?url|landing_?page|referrer|src_url)$/i;
function extractUtm(body: any): Record<string, string> | null {
  const out: Record<string, string> = {};
  const urls: unknown[] = [];
  const clean = (v: unknown) => (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim().slice(0, 200) : null;
  const walk = (o: any, depth: number, parent: string | null) => {
    if (!o || typeof o !== "object" || depth > 5) return;
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (v && typeof v === "object") { walk(v, depth + 1, key); continue; }
      if (UTM_URL_KEYS.test(key)) urls.push(v);
      const target = UTM_KEYS.includes(key) ? key : (UTM_PARENTS.test(parent || "") ? UTM_ALIAS[key] : undefined);
      if (target && !out[target]) { const c = clean(v); if (c) out[target] = c; }
    }
  };
  walk(body, 0, null);
  for (const raw of urls) {
    if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) continue;
    try { const u = new URL(raw); for (const k of UTM_KEYS) if (!out[k]) { const c = clean(u.searchParams.get(k)); if (c) out[k] = c; } } catch { /* URL inválida */ }
  }
  return Object.keys(out).length ? out : null;
}

function extractRecoveryLink(payload: any): string | null {
  const URL_RE = /^https?:\/\/\S+/i;
  const BAD = /(image|img|photo|logo|avatar|thumb|icon|notif|webhook|callback|postback|terms|privacy|unsub|producer|affiliate|banner|cover)/i;
  let best: { score: number; url: string } | null = null;
  const seen = new Set<any>();
  const consider = (key: string, url: string) => {
    if (BAD.test(key)) return;
    let score = 0;
    if (/(checkout|recover|carrinho|cart)/i.test(key)) score = 4;
    else if (/(billet|boleto|pix)/i.test(key)) score = 3;
    else if (/(payment|pay|invoice|offer)/i.test(key)) score = 2;
    else if (/(link|url)/i.test(key)) score = 1;
    else return;
    if (!best || score > best.score) best = { score, url };
  };
  const walk = (obj: any, parentKey = "") => {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    if (parentKey && BAD.test(parentKey)) return; // não desce em subárvores de imagem/produtor/etc.
    seen.add(obj);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && URL_RE.test(v.trim())) consider(k, v.trim());
      else if (v && typeof v === "object") walk(v, k);
    }
  };
  walk(payload);
  // Valida antes de devolver: o `consider` acima só exige que a string comece com
  // http, então uma chave com nome plausível e valor lixo ("https://a b", por exemplo
  // — passa no URL_RE porque \S+ casa com "a", mas o espaço no host faz o new URL()
  // abaixo lançar) passaria e seria gravada como link de recuperação. Link inválido é
  // PIOR que ausente — atravessa o gate do process-steps e vira botão quebrado na
  // caixa do comprador.
  if (!best) return null;
  try {
    return new URL(best.url).hostname ? best.url : null;
  } catch {
    return null;
  }
}

// Extrai os campos-chave que tornam uma linha de dead-letter truncada ainda
// diagnosticável/reprocessável (fora do `head`, que pode cortar no meio do JSON).
function extractDeadLetterKeys(parsed: any): Record<string, unknown> {
  const keys: Record<string, unknown> = {};
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.event === "string") keys.event = parsed.event;
    if (typeof parsed.kind === "string") keys.kind = parsed.kind;
    const email = parsed?.data?.customer?.email;
    if (typeof email === "string") keys.email = email;
    const id = parsed?.data?.id;
    if (id !== undefined) keys.id = id;
  }
  return keys;
}

// Achados dos revisores (Tarefa 3d): dead-letter sem limite gravava o payload cru
// inteiro, sem teto. Se o corpo bruto passar de ~16 KB, guarda um objeto truncado —
// mas preserva os campos-chave (event, kind, data.customer.email, data.id) FORA do
// `head`, já que reprocessar dead-letter foi o que salvou o incidente de hoje e um
// `head` cortado no meio do JSON pode não ser mais parseável sozinho. Corte por
// BYTES (não por caracteres) já que o limiar é medido em bytes.
function deadLetterPayload(raw: string, parsed: any): any {
  const encoded = new TextEncoder().encode(raw);
  if (encoded.length <= DEAD_LETTER_MAX_BYTES) return parsed;
  const head = new TextDecoder().decode(encoded.slice(0, DEAD_LETTER_HEAD_BYTES));
  return { _truncated: true, ...extractDeadLetterKeys(parsed), head };
}

// ── Autenticação além do token na URL (migração 0073) ────────────────────────
// INLINADO de supabase/functions/_shared/postback_auth.ts (testado lá com deno test) — manter iguais.
const SIGNATURE_TOLERANCE_S = 300;
type PostbackToken = { signing_secret: string; hottok: string | null; require_signature: boolean };
function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function parseSignature(header: string | null): { t: number | null; v1: string[] } {
  const out = { t: null as number | null, v1: [] as string[] };
  for (const part of String(header || "").split(",")) {
    const [k, v] = part.split("=").map((s) => (s || "").trim());
    if (k === "t" && /^\d{9,11}$/.test(v)) out.t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) out.v1.push(v.toLowerCase());
  }
  return out;
}
async function signPostback(secret: string, t: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifyPostbackAuth(token: PostbackToken, headers: Headers, rawBody: string, nowS = Math.floor(Date.now() / 1000)):
  Promise<{ ok: true; mode: string } | { ok: false; reason: string }> {
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
function tokenFrom(headers: Headers, url: URL): string | null {
  const auth = /^Bearer (pbk_[A-Za-z0-9]+)$/.exec(headers.get("authorization") || "");
  return headers.get("x-kobly-token") || (auth ? auth[1] : null) || url.searchParams.get("token");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Achados dos revisores (RISCO NOVO introduzido hoje): o caminho de "evento não
  // reconhecido" deixou de ser zero-I/O — agora faz 2 counts (rate limit) + 1 insert em
  // webhook_dead_letter ANTES de responder. Sem um try/catch de topo, qualquer rejeição
  // nesses awaits (rede, PostgREST fora do ar, etc.) vira exceção não tratada e o Deno
  // devolve 500 ao provedor — e o cabeçalho deste arquivo já explica que responder
  // não-2xx faz plataformas DESATIVAREM o webhook. Por isso TUDO abaixo roda dentro de
  // um try/catch que SEMPRE devolve 200, mesmo em falha interna.
  try {
    // ── Token ──
    const url = new URL(req.url);
    const token = tokenFrom(req.headers, url);
    if (!token) return json({ error: "missing_token", detail: "Envie o token no cabeçalho X-Kobly-Token (ou ?token=pbk_xxx na URL)" }, 401);

    // ── Body ──
    const rawBody = await req.text();
    let body: any;
    try { body = JSON.parse(rawBody || "{}"); } catch { return json({ error: "invalid_json" }, 400); }

    // ── Supabase client ──
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── Validar token → organization_id + token id (WEB-1) ──
    // Precisamos do id do token para filtrar campanhas vinculadas a um webhook nomeado.
    // IMPORTANTE: isto roda ANTES do normalizePayload/dead-letter de propósito — assim
    // só remetente autenticado (token válido) consegue gravar em webhook_dead_letter,
    // e a tabela não vira alvo de flood anônimo (?token=qualquercoisa + payload lixo).
    const { data: tokRow, error: tokErr } = await sb.from("postback_tokens")
      .select("id, organization_id, signing_secret, hottok, require_signature, last_unsigned_at, platform, platform_secret")
      .eq("token", token)
      .eq("ativo", true)
      .maybeSingle();
    if (tokErr || !tokRow) return json({ error: "invalid_token", detail: "Token inválido ou inativo" }, 401);
    // Prova no cabeçalho (assinatura Kobly ou hottok da Hotmart). Inválida → 401 sempre;
    // ausente → só passa se o token não estiver em modo estrito (compatibilidade com a URL antiga).
    const auth = await verifyPostbackAuth(tokRow as PostbackToken, req.headers, rawBody);
    if (!auth.ok) return json({ error: auth.reason }, 401);
    if (tokRow.platform && tokRow.platform_secret) {
      let parsedForProof: any = null;
      try { parsedForProof = JSON.parse(rawBody || "{}"); } catch { parsedForProof = null; }
      const okProof = await verifyPlatformProof(tokRow.platform as string, tokRow.platform_secret as string, rawBody, parsedForProof, url.searchParams.get("signature"));
      if (!okProof) return json({ error: "invalid_platform_proof", detail: "O aviso não traz a chave/assinatura da plataforma cadastrada." }, 401);
    }
    if (auth.mode === "legado_url" && (!tokRow.last_unsigned_at || Date.now() - new Date(tokRow.last_unsigned_at as string).getTime() > 3600e3)) {
      await sb.from("postback_tokens").update({ last_unsigned_at: new Date().toISOString() }).eq("id", tokRow.id);
    }
    const org = tokRow.organization_id as string;
    const tokenId = tokRow.id as string;

    // ── Rate limit ──
    // Achados dos revisores (Tarefa 3d): antes só contava webhook_events — o caminho de
    // dead-letter nunca gravava lá, então um token válido com tráfego de eventos não
    // mapeados nunca disparava o limite (gravando dead-letter ilimitadamente). Agora soma
    // as duas tabelas na mesma janela de 60s, por org. Promise.allSettled (não Promise.all):
    // se UM dos dois counts rejeitar, não derruba o outro nem o request inteiro — trata
    // como 0 (fail-open: não bloqueia tráfego legítimo por causa de uma falha no próprio
    // check de rate limit) e segue.
    const since = new Date(Date.now() - 60_000).toISOString();
    const [evtRes, dlRes] = await Promise.allSettled([
      sb.from("webhook_events").select("id", { count: "exact", head: true })
        .eq("organization_id", org).gte("created_at", since),
      sb.from("webhook_dead_letter").select("id", { count: "exact", head: true })
        .eq("organization_id", org).gte("created_at", since),
    ]);
    if (evtRes.status === "rejected") console.error("rate limit: count webhook_events rejeitado", evtRes.reason);
    if (dlRes.status === "rejected") console.error("rate limit: count webhook_dead_letter rejeitado", dlRes.reason);
    const recentEvents = evtRes.status === "fulfilled" ? (evtRes.value.count ?? 0) : 0;
    const recentDeadLetters = dlRes.status === "fulfilled" ? (dlRes.value.count ?? 0) : 0;
    const recent = recentEvents + recentDeadLetters;
    if (recent > RATE_LIMIT_PER_MIN) {
      // Achados dos revisores: antes respondia 429 e descartava o evento SEM gravar
      // dead-letter — reintroduzia exatamente a perda silenciosa que a tabela foi criada
      // para eliminar. Agora sempre 200 "ignored" (nunca 4xx pro provedor) + uma linha de
      // dead-letter (reason='rate_limited') pra o evento continuar visível/reprocessável.
      const { error: dlErr } = await sb.from("webhook_dead_letter").insert({
        organization_id: org,
        postback_token_id: tokenId,
        provider: "postback",
        reason: "rate_limited",
        detail: `recent=${recent} limit=${RATE_LIMIT_PER_MIN}`,
        raw_payload: deadLetterPayload(rawBody, body),
      });
      if (dlErr) console.error("webhook_dead_letter insert failed (rate_limited)", dlErr.message);
      return json({ ok: true, ignored: true, reason: "rate_limited" });
    }

    // ── Normaliza (contrato genérico Kobly, payload nativo Hotmart OU nativo NexoPayt) ──
    // Evento não reconhecido/sem e-mail → 200 "ignored", NUNCA 4xx: plataformas como a
    // Hotmart desativam automaticamente um Webhook que fica respondendo erro, o que
    // derrubaria TODOS os eventos futuros por causa de um único tipo não mapeado ainda.
    // Grava dead-letter ANTES de responder — sem isso o evento desaparecia sem rastro
    // (era o bug provado pela auditoria E2E: 18 POSTs 200 em ~25min, 0 linhas gravadas).
    const norm = normalizePayload(body);
    if (!norm) {
      const receivedEvent = body?.event ?? body?.transaction?.payment_status ?? body?.status ?? null;
      const { error: dlErr } = await sb.from("webhook_dead_letter").insert({
        organization_id: org,
        postback_token_id: tokenId,
        provider: "postback",
        reason: "unknown_event_or_missing_email",
        detail: receivedEvent != null ? `received_event=${String(receivedEvent)}` : null,
        raw_payload: deadLetterPayload(rawBody, body),
      });
      if (dlErr) console.error("webhook_dead_letter insert failed (unknown_event)", dlErr.message);
      return json({
        ok: true, ignored: true, reason: "unknown_event_or_missing_email",
        // NexoPayt não tem `event` no raiz — devolve o status recebido p/ facilitar o debug.
        received_event: receivedEvent,
      });
    }
    const tipoEvento = norm.tipoEvento;

    // ── Idempotência: dedup por external_id (se fornecido), composto com a ORG ──
    // A unique de webhook_events é global (webhook_id NULL colide entre orgs) — a mesma
    // transação entregue a duas orgs diferentes NÃO pode dedupar entre elas.
    const idWebhook = norm.externalId ? `${org}:${norm.externalId}` : `pbk:${crypto.randomUUID()}`;
    // Pix: o branch nexopayt já resolve (norm.isPix); genérico distingue via sourceEvent;
    // Hotmart não tem evento dedicado de Pix (ver comentário do HOTMART_EVENT_MAP).
    const isPix = norm.isPix ?? norm.sourceEvent === "pix_generated";
    // Link de recuperação/checkout que a plataforma mandou (se houver) → destino do botão do e-mail.
    const recoveryLink = extractRecoveryLink(body);
    const utm = extractUtm(body); // origem do tráfego; no lead fica o 1º toque

    // ── 1) webhook_events (idempotente) ──
    const evt = {
      organization_id: org,
      tipo_evento: tipoEvento,
      provider: "postback",
      id_webhook: idWebhook,
      email: norm.email,
      nome_comprador: norm.name,
      produto: norm.product,
      valor_produto: norm.value,
      metodo_pagamento: norm.paymentMethod,
      pix_gerado: isPix,
      checkout_url: recoveryLink,
      payload: body,
      utm,
    };
    const ins = await sb.from("webhook_events").insert(evt).select("id").single();
    if (ins.error) {
      // Achados dos revisores (Tarefa 3c): unique (webhook_id, id_webhook) NULLS NOT
      // DISTINCT faz de 'insert_failed' o caminho NORMAL de dedupe — toda reentrega
      // idempotente do provedor cai aqui via violação de unicidade (código '23505' no
      // Postgres/PostgREST). Isso não é falha: não grava dead-letter (evita ruído com o
      // payload cru inteiro para tráfego legítimo), só responde 200 'deduped' como antes.
      // Só grava dead-letter para erros que são de fato falha de insert.
      const isDuplicate = (ins.error as { code?: string }).code === "23505";
      if (!isDuplicate) {
        const { error: dlErr } = await sb.from("webhook_dead_letter").insert({
          organization_id: org,
          postback_token_id: tokenId,
          provider: "postback",
          reason: "insert_failed",
          detail: ins.error.message,
          raw_payload: deadLetterPayload(rawBody, body),
        });
        if (dlErr) console.error("webhook_dead_letter insert failed (insert_failed)", dlErr.message);
      }
      return json({ ok: true, deduped: true, detail: ins.error.message });
    }
    const webhookEventId = ins.data.id;
    // contador da página da plataforma (último aviso e total)
    await sb.from("postback_tokens").update({ last_event_at: new Date().toISOString() }).eq("id", tokenId).then(() => {}, () => {});

    // ── 2) Lead por (org, email) ──
    let leadId: string | null = null;
    const { data: ex } = await sb.from("leads")
      .select("id, utm")
      .eq("organization_id", org)
      .eq("email", norm.email)
      .maybeSingle();

    if (ex) {
      leadId = ex.id;
      await sb.from("leads").update({
        ultimo_evento: tipoEvento,
        produto: norm.product,
        valor_compra: norm.value,
        metodo_pagamento: norm.paymentMethod,
        pix_gerado: isPix,
        // Só sobrescreve telefone/link se este evento trouxe um (não apaga valor válido anterior).
        ...(norm.phone ? { telefone: norm.phone } : {}),
        ...(recoveryLink ? { link_recuperacao: recoveryLink } : {}),
        ...(utm && !ex.utm ? { utm } : {}),
      }).eq("id", leadId);
    } else {
      const { data: nl } = await sb.from("leads").insert({
        organization_id: org,
        email: norm.email,
        nome: norm.name,
        telefone: norm.phone,
        produto: norm.product,
        valor_compra: norm.value,
        metodo_pagamento: norm.paymentMethod,
        pix_gerado: isPix,
        ultimo_evento: tipoEvento,
        link_recuperacao: recoveryLink,
        utm,
      }).select("id").single();
      leadId = nl?.id ?? null;
    }

    if (leadId) {
      await sb.from("webhook_events").update({ lead_id: leadId }).eq("id", webhookEventId);
    }

    // ── 2b) Atribuição de VENDA RECUPERADA (dado real) ──
    // Regra: só conta como recuperado se o lead RECEBEU e-mail de automação
    // (email_events.status='enviado', canal e-mail) ANTES desta compra.
    // 1ª "Compra Aprovada" do lead; credita cada campanha que já enviou pra ele.
    if (tipoEvento === "Compra Aprovada" && leadId) {
      const { count: convCount } = await sb.from("webhook_events")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org).eq("lead_id", leadId).eq("tipo_evento", "Compra Aprovada");
      // convCount já inclui o evento recém-inserido → == 1 significa primeira conversão
      if ((convCount ?? 0) <= 1) {
        const purchaseAt = new Date().toISOString();
        // Só e-mail de automação (channel null/email) enviado ANTES da compra.
        const { data: sentEmail } = await sb.from("email_events")
          .select("campaign_id")
          .eq("organization_id", org).eq("email", norm.email).eq("status", "enviado")
          .not("campaign_id", "is", null)
          .lt("timestamp", purchaseAt)
          .or("channel.is.null,channel.eq.email");
        const campIds = Array.from(new Set((sentEmail || []).map((e: any) => e.campaign_id).filter(Boolean)));
        for (const cid of campIds) {
          // Incremento atômico via RPC (evita race read-modify-write).
          const { error: bumpErr } = await sb.rpc("increment_vendas_recuperadas", { p_campaign_id: cid });
          if (bumpErr) {
            // Fallback se a RPC ainda não estiver deployada: select + update + create se faltar row.
            const { data: cs } = await sb.from("campaign_stats").select("id, vendas_recuperadas").eq("campaign_id", cid).maybeSingle();
            if (cs) {
              await sb.from("campaign_stats")
                .update({ vendas_recuperadas: (Number(cs.vendas_recuperadas) || 0) + 1, ultimo_calculo: new Date().toISOString() })
                .eq("id", cs.id);
            } else {
              const { data: camp } = await sb.from("campaigns").select("organization_id").eq("id", cid).maybeSingle();
              if (camp) {
                await sb.from("campaign_stats").insert({
                  campaign_id: cid, organization_id: camp.organization_id, vendas_recuperadas: 1, ultimo_calculo: new Date().toISOString(),
                });
              }
            }
          }
        }
      }
    }

    // ── 3) Enfileira etapas das campanhas ATIVAS cujo Gatilho casa o tipo_evento ──
    // WEB-1: uma campanha dispara se (a) não tem vínculo (NULL — qualquer token,
    // comportamento padrão/retrocompatível) OU (b) está vinculada ao token que
    // originou este evento. Assim um token "Hotmart - Produto A" só aciona as
    // campanhas dele (e as sem vínculo), nunca as de outro produto.
    const { data: camps, error: campErr } = await sb.from("campaigns")
      .select("id, campaign_flows(id, flow_steps!flow_id(id, tipo_card, tipo_evento, atraso, posicao))")
      .eq("organization_id", org)
      .eq("status_campanha", "Ativa")
      .or(`postback_token_id.is.null,postback_token_id.eq.${tokenId}`);

    if (campErr) {
      return json({
        ok: true, lead_id: leadId, webhook_event_id: webhookEventId,
        enqueued: 0, warn: "match_failed", detail: campErr.message,
      });
    }

    let enqueued = 0;
    const campanhasAcionadas: string[] = [];
    // Diagnóstico de "por que nada foi agendado". Sem isto, um postback que casa o evento
    // mas não encontra campanha nenhuma respondia {ok:true, enqueued:0} com status 200 — do
    // ponto de vista do provedor, do log e do painel, sucesso. Foi assim que a org
    // d47ca6d3 ficou de 20 a 21/07 recebendo 496 eventos (314 "Pix Gerado", 218 leads) e
    // agendando ZERO passos: a plataforma posta no token "Nexopayt - GERAL", que não tinha
    // nenhuma campanha ATIVA amarrada (a única estava em Rascunho), então o filtro de
    // campanhas voltava vazio e o laço abaixo nem rodava. Contamos os estágios para poder
    // dizer em qual deles o fluxo morreu.
    let gatilhosCasados = 0;
    let insertsFalhos = 0;

    for (const c of camps || []) {
      const campId = (c as any).id as string;
      const flow = Array.isArray((c as any).campaign_flows)
        ? (c as any).campaign_flows[0]
        : (c as any).campaign_flows;
      const steps = (flow && flow.flow_steps) || [];

      // Verifica se algum step Gatilho casa com o tipo_evento
      const casa = steps.some((s: any) => s.tipo_card === "Gatilho" && s.tipo_evento === tipoEvento);
      if (!casa || !leadId) continue;
      gatilhosCasados++;

      // Coleta as ações (exclui o Gatilho e o card Condição — este é só o marcador
      // visual do redirecionador; a condição é compilada em flow_steps.condicao dos
      // filhos e avaliada pelo process-steps na hora do envio), ordena por posição
      const acoes = steps
        .filter((s: any) => s.tipo_card !== "Gatilho" && s.tipo_card !== "Condição")
        .sort((a: any, b: any) => a.posicao - b.posicao);

      // Auditoria E2E (Flow engine ALTO): o atraso é CUMULATIVO — cada etapa aguarda
      // "X após a etapa anterior" (como a UI promete), não X após o gatilho. Sem isto,
      // três etapas com atraso 30/30/30 disparavam TODAS juntas em +30min.
      let accMin = 0;
      const rows = acoes.map((s: any) => {
        accMin += Number(s.atraso) || 0;
        return {
          organization_id: org,
          step_id: s.id,
          lead_id: leadId,
          webhook_event_id: webhookEventId,
          status_agendamento: "Iniciado",
          run_at: new Date(Date.now() + accMin * 60000).toISOString(),
        };
      });

      if (rows.length) {
        const r = await sb.from("scheduled_steps").insert(rows);
        if (!r.error) {
          enqueued += rows.length;
          campanhasAcionadas.push(campId);
        } else {
          // ANTES: o erro era descartado em silêncio — o gatilho casava, o insert falhava,
          // e a resposta seguia {ok:true, enqueued:0}. Uma falha de constraint/RLS aqui
          // derrubaria a automação inteira sem deixar UM rastro em lugar nenhum.
          insertsFalhos++;
          console.error(
            "postback-receiver: insert de scheduled_steps falhou",
            JSON.stringify({ campanha: campId, lead_id: leadId, passos: rows.length, erro: r.error.message }),
          );
        }
      }
    }

    // Nada agendado é sempre anômalo quando o evento foi reconhecido e tem lead: alguém
    // configurou um postback esperando automação. Distinguimos os três motivos possíveis
    // para que o diagnóstico seja de um olhar, em vez de uma investigação no banco.
    let motivoSemAgendamento: string | null = null;
    if (enqueued === 0 && leadId) {
      if (insertsFalhos > 0) motivoSemAgendamento = "insert_falhou";
      else if ((camps || []).length === 0) motivoSemAgendamento = "nenhuma_campanha_ativa_para_este_token";
      else if (gatilhosCasados === 0) motivoSemAgendamento = "nenhum_gatilho_casa_com_o_evento";
      else motivoSemAgendamento = "campanha_sem_acoes";
      console.warn(
        "postback-receiver: evento reconhecido mas NADA agendado",
        JSON.stringify({
          motivo: motivoSemAgendamento, org, token_id: tokenId, tipo_evento: tipoEvento,
          campanhas_ativas_no_token: (camps || []).length, gatilhos_casados: gatilhosCasados,
        }),
      );
    }

    return json({
      ok: true,
      event: norm.sourceEvent,
      tipo_evento: tipoEvento,
      lead_id: leadId,
      webhook_event_id: webhookEventId,
      enqueued,
      campanhas_acionadas: campanhasAcionadas,
      // Só aparece quando nada foi agendado — é o campo que responde "por que não chegou
      // e-mail?" sem precisar abrir o banco. Segue 200/ok de propósito: o provedor de
      // checkout não deve reprocessar por causa de configuração nossa (ver topo do arquivo).
      ...(motivoSemAgendamento ? { motivo_sem_agendamento: motivoSemAgendamento } : {}),
    });
  } catch (err) {
    // Nunca deixa uma exceção não tratada virar 500 pro provedor de checkout (ver
    // comentário no topo do handler) — loga pra investigar e responde 200 sempre.
    console.error("postback-receiver: erro não tratado", err instanceof Error ? err.message : err);
    return json({ ok: true, ignored: true, reason: "internal_error" });
  }
});
