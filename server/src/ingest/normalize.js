// Normalização dos postbacks (contrato Kobly, Hotmart, Cakto, PerfectPay, NexoPayt, ENTITY). Portado 1:1 de supabase/functions/postback-receiver.
const RATE_LIMIT_PER_MIN = 120;
const DEAD_LETTER_MAX_BYTES = 16 * 1024;
const DEAD_LETTER_HEAD_BYTES = 8 * 1024;
const EVENT_MAP = {
  cart_abandoned: "Abandono de carrinho",
  payment_approved: "Compra Aprovada",
  payment_refused: "Compra Recusada",
  payment_refunded: "Compra Reembolsada",
  payment_chargeback: "Chargeback",
  payment_canceled: "Compra cancelada",
  subscription_canceled: "Cancelamento de Assinatura",
  pix_generated: "Pix Gerado",
  boleto_generated: "Boleto Gerado",
  deposit_requested: "Dep\xF3sito Solicitado"
};
const HOTMART_EVENT_MAP = {
  PURCHASE_APPROVED: "Compra Aprovada",
  PURCHASE_COMPLETE: "Compra Aprovada",
  PURCHASE_CANCELED: "Compra cancelada",
  PURCHASE_EXPIRED: "Compra cancelada",
  PURCHASE_REFUNDED: "Compra Reembolsada",
  PURCHASE_CHARGEBACK: "Chargeback",
  PURCHASE_BILLET_PRINTED: "Boleto Gerado",
  PURCHASE_OUT_OF_SHOPPING_CART: "Abandono de carrinho",
  SUBSCRIPTION_CANCELLATION: "Cancelamento de Assinatura"
};
function isHotmartShaped(body) {
  return !!(body && body.data && (body.data.buyer || body.data.purchase || body.data.subscriber));
}
const NEXOPAYT_PAYMENT_STATUS_MAP = {
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
  canceled: "Compra cancelada"
};
const NEXOPAYT_ORDER_STATUS_MAP = {
  paid: "Compra Aprovada",
  canceled: "Compra cancelada",
  lost_cart: "Abandono de carrinho",
  subscription_canceled: "Cancelamento de Assinatura"
};
const NEXOPAYT_PAYMENT_LABEL = { pix: "Pix", credit_card: "Cart\xE3o", boleto: "Boleto" };
const ENTITY_EVENT_SUFFIX_MAP = {
  paid: "Compra Aprovada",
  refused: "Compra Recusada",
  refunded: "Compra Reembolsada",
  chargeback: "Chargeback",
  canceled: "Compra cancelada",
  cancelled: "Compra cancelada"
};
function resolveNexopaytTipoEvento(root, tx, pm) {
  const payStatus = String(tx.payment_status ?? root.payment_status ?? "").toLowerCase();
  const orderStatus = String(root.status ?? "").toLowerCase();
  if (payStatus === "waiting_payment" || orderStatus === "waiting_payment") {
    if (pm === "boleto") return "Boleto Gerado";
    if (pm === "pix") return "Pix Gerado";
    return null;
  }
  return NEXOPAYT_PAYMENT_STATUS_MAP[payStatus] || NEXOPAYT_ORDER_STATUS_MAP[orderStatus] || null;
}
function isNexopaytShaped(body) {
  if (!body || typeof body !== "object" || isHotmartShaped(body)) return false;
  if (typeof body.event === "string") return false;
  const hasTx = !!body.transaction && typeof body.transaction === "object";
  const hasCustomer = !!body.customer && typeof body.customer === "object";
  return hasTx || hasCustomer || typeof body.integration_key === "string";
}
function isEntityShaped(body) {
  return !!(body && body.kind === "ENTITY" && typeof body.event === "string" && body.event.startsWith("entity.transaction."));
}
// Cakto (docs.cakto.com.br): { secret, event, data: { id, status, amount, paymentMethod, checkoutUrl, customer, product, pix } }.
const CAKTO_EVENT_MAP = {
  purchase_approved: "Compra Aprovada",
  purchase_refused: "Compra Recusada",
  pix_gerado: "Pix Gerado",
  boleto_gerado: "Boleto Gerado",
  refund: "Compra Reembolsada",
  chargeback: "Chargeback",
  checkout_abandonment: "Abandono de carrinho",
  subscription_canceled: "Cancelamento de Assinatura"
};
function isCaktoShaped(body) {
  return !!(body && typeof body.event === "string" && CAKTO_EVENT_MAP[body.event] && body.data && typeof body.data === "object" && body.data.customer && "secret" in body);
}
// PerfectPay (help.perfectpay.com.br): { token, code, sale_amount, sale_status_enum, sale_status_detail, payment_type_enum, customer, product, metadata }.
// Vem SEM "event" e com "customer": precisa ser reconhecida antes da NexoPayt.
const PERFECTPAY_STATUS_MAP = { 2: "Compra Aprovada", 10: "Compra Aprovada", 5: "Compra Recusada", 6: "Compra cancelada", 13: "Compra cancelada", 7: "Compra Reembolsada", 9: "Chargeback", 12: "Abandono de carrinho" };
const PERFECTPAY_PAYMENT_LABEL = { 1: "Cartão", 2: "Boleto", 3: "PayPal", 4: "Cartão", 5: "Grátis", 6: "Cartão" };
function isPerfectPayShaped(body) {
  return !!(body && typeof body.event !== "string" && body.sale_status_enum !== undefined && body.code && body.customer && typeof body.customer === "object");
}
function resolvePerfectPayTipoEvento(body) {
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
function normalizePayload(body) {
  if (!body) return null;
  if (isHotmartShaped(body)) {
    const tipoEvento2 = HOTMART_EVENT_MAP[body.event];
    if (!tipoEvento2) return null;
    const buyer = body.data.buyer || body.data.subscriber || {};
    const purchase = body.data.purchase || {};
    const product = body.data.product || {};
    if (!buyer.email) return null;
    return {
      tipoEvento: tipoEvento2,
      email: buyer.email,
      name: buyer.name || null,
      phone: buyer.checkout_phone ?? buyer.phone ?? null,
      // checkout_phone é o campo comum do Webhook v2
      product: product.name || null,
      value: purchase?.price?.value ?? purchase?.full_price?.value ?? null,
      paymentMethod: purchase?.payment?.type || null,
      // Idempotência por TRANSIÇÃO de status (igual ao branch nexopayt): a Hotmart usa
      // o MESMO transaction code em APPROVED e depois em REFUNDED/CHARGEBACK — sem o
      // sufixo do tipo_evento, o refund era dedupado e fluxos de reembolso nunca disparavam.
      externalId: body.data.purchase?.transaction ? `${body.data.purchase.transaction}:${tipoEvento2}` : body.id || null,
      sourceEvent: body.event
    };
  }
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
  if (isNexopaytShaped(body)) {
    const tx = body.transaction ?? {};
    const pm = String(tx.payment_method ?? body.payment_method ?? "").toLowerCase();
    const tipoEvento2 = resolveNexopaytTipoEvento(body, tx, pm);
    if (!tipoEvento2) return null;
    const c = body.customer ?? {};
    const prod = body.product ?? {};
    if (!c.email) return null;
    const rawStr = String(tx.total_price ?? body.total_price ?? prod.price ?? "");
    const n = Number(rawStr);
    const value = !n ? null : rawStr.includes(".") ? Math.round(n * 100) / 100 : Math.round(n) / 100;
    const txId = body.transaction_id ?? tx.id ?? body.id ?? null;
    return {
      tipoEvento: tipoEvento2,
      email: c.email,
      name: c.name ?? null,
      phone: c.phone ?? c.phone_number ?? null,
      product: prod.name ?? prod.title ?? null,
      value,
      paymentMethod: NEXOPAYT_PAYMENT_LABEL[pm] ?? (pm || null),
      externalId: txId ? `${txId}:${tipoEvento2}` : null,
      // idempotência por transição de status
      sourceEvent: String(tx.payment_status || body.payment_status || body.status || ""),
      isPix: tipoEvento2 === "Pix Gerado"
    };
  }
  if (isEntityShaped(body)) {
    const d = body.data ?? {};
    const pm = String(d.method?.value ?? "").toLowerCase();
    const statusValue = String(d.status?.value ?? "").toLowerCase();
    const eventSuffix = body.event.slice("entity.transaction.".length).toLowerCase();
    const suffixTipoEvento = ENTITY_EVENT_SUFFIX_MAP[eventSuffix] ?? null;
    let tipoEvento2;
    if (suffixTipoEvento) {
      tipoEvento2 = suffixTipoEvento;
    } else {
      tipoEvento2 = eventSuffix === "created" && statusValue === "waiting_payment" ? resolveNexopaytTipoEvento({ status: statusValue, payment_status: statusValue }, {}, pm) : null;
    }
    if (!tipoEvento2) return null;
    const c = d.customer ?? {};
    if (!c.email) return null;
    const items = Array.isArray(d.items) ? d.items : [];
    const product = items.map((i) => i?.name).filter(Boolean).join(", ") || null;
    const value = d.amount != null && !Number.isNaN(Number(d.amount)) ? Math.round(Number(d.amount)) / 100 : null;
    const rawPhone = c.phone;
    const phone = rawPhone && typeof rawPhone === "object" ? `${rawPhone.countryCode ?? ""}${rawPhone.number ?? ""}` || null : typeof rawPhone === "string" ? rawPhone : null;
    const txId = d.id ?? null;
    return {
      tipoEvento: tipoEvento2,
      email: c.email,
      name: c.name ?? null,
      phone,
      product,
      value,
      paymentMethod: d.method?.label || NEXOPAYT_PAYMENT_LABEL[pm] || (pm || null),
      // idempotência por TRANSIÇÃO de status: o mesmo data.id se repete entre
      // entity.transaction.created e entity.transaction.paid (confirmado no dead-letter real).
      externalId: txId ? `${txId}:${tipoEvento2}` : null,
      sourceEvent: statusValue || body.event,
      isPix: tipoEvento2 === "Pix Gerado"
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
    sourceEvent: body.event
  };
}
function extractRecoveryLink(payload) {
  const URL_RE = /^https?:\/\/\S+/i;
  const BAD = /(image|img|photo|logo|avatar|thumb|icon|notif|webhook|callback|postback|terms|privacy|unsub|producer|affiliate|banner|cover)/i;
  let best = null;
  const seen = /* @__PURE__ */ new Set();
  const consider = (key, url) => {
    if (BAD.test(key)) return;
    let score = 0;
    if (/(checkout|recover|carrinho|cart)/i.test(key)) score = 4;
    else if (/(billet|boleto|pix)/i.test(key)) score = 3;
    else if (/(payment|pay|invoice|offer)/i.test(key)) score = 2;
    else if (/(link|url)/i.test(key)) score = 1;
    else return;
    if (!best || score > best.score) best = { score, url };
  };
  const walk = (obj, parentKey = "") => {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    if (parentKey && BAD.test(parentKey)) return;
    seen.add(obj);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && URL_RE.test(v.trim())) consider(k, v.trim());
      else if (v && typeof v === "object") walk(v, k);
    }
  };
  walk(payload);
  if (!best) return null;
  try {
    return new URL(best.url).hostname ? best.url : null;
  } catch {
    return null;
  }
}
function extractDeadLetterKeys(parsed) {
  const keys = {};
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.event === "string") keys.event = parsed.event;
    if (typeof parsed.kind === "string") keys.kind = parsed.kind;
    const email = parsed?.data?.customer?.email;
    if (typeof email === "string") keys.email = email;
    const id = parsed?.data?.id;
    if (id !== void 0) keys.id = id;
  }
  return keys;
}
function deadLetterPayload(raw, parsed) {
  const encoded = new TextEncoder().encode(raw);
  if (encoded.length <= DEAD_LETTER_MAX_BYTES) return parsed;
  const head = new TextDecoder().decode(encoded.slice(0, DEAD_LETTER_HEAD_BYTES));
  return { _truncated: true, ...extractDeadLetterKeys(parsed), head };
}
export {
  RATE_LIMIT_PER_MIN,
  deadLetterPayload,
  extractRecoveryLink,
  normalizePayload
};
