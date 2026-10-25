// Pixels pelo servidor (Integrações → Trackeamento). Token por empresa, cifrado no banco.
//   Meta   — API de Conversões: POST graph.facebook.com/{pixel}/events (e-mail/telefone em SHA-256).
//   TikTok — Events API: POST business-api.tiktok.com/open_api/v1.3/event/track/ (Access-Token; e-mail e
//            telefone +DDI em SHA-256; compra = CompletePayment).
//   Google — GA4 Measurement Protocol: POST www.google-analytics.com/mp/collect?measurement_id=G-…&api_secret=…
//            (client_id estável por lead; compra = purchase com transaction_id).
// O bloco Pixel do fluxo usa nomes da Meta (Purchase, Lead, InitiateCheckout, AddPaymentInfo); cada envio traduz.
import { createHash } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
export const EVENT_NAMES = { Purchase: 'Purchase', Lead: 'Lead', InitiateCheckout: 'InitiateCheckout', AddPaymentInfo: 'AddPaymentInfo' };
export const TIKTOK_EVENTS = { Purchase: 'CompletePayment', Lead: 'SubmitForm', InitiateCheckout: 'InitiateCheckout', AddPaymentInfo: 'AddPaymentInfo' };
export const GA4_EVENTS = { Purchase: 'purchase', Lead: 'generate_lead', InitiateCheckout: 'begin_checkout', AddPaymentInfo: 'add_payment_info' };
export const PIXEL_PROVIDERS = {
  meta: { label: 'Meta (Facebook/Instagram)', idRe: /^\d{5,25}$/, idMsg: 'O ID do Pixel da Meta tem só números.', tokenMsg: 'Informe o token da API de Conversões.' },
  tiktok: { label: 'TikTok', idRe: /^[A-Z0-9]{10,40}$/, idMsg: 'Código do Pixel do TikTok inválido (letras maiúsculas e números).', tokenMsg: 'Informe o Access Token da Events API.' },
  google: { label: 'Google (GA4)', idRe: /^G-[A-Z0-9]{4,20}$/, idMsg: 'Use o ID de métricas do GA4 (começa com G-).', tokenMsg: 'Informe o "API secret" do Measurement Protocol.' },
};
const hasValue = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const normEmail = (lead) => String((lead && lead.email) || '').trim().toLowerCase();
const normPhone = (lead) => String((lead && lead.telefone) || '').replace(/\D/g, '');

export function buildCapiEvent({ eventName, eventId, eventTime, lead, value, currency, actionSource = 'system_generated' }) {
  const user = {};
  const email = normEmail(lead), phone = normPhone(lead);
  if (email) user.em = [sha(email)];
  if (phone) user.ph = [sha(phone)];
  if (lead && lead.id) user.external_id = [sha(String(lead.id))];
  const ev = { event_name: eventName, event_time: eventTime, event_id: eventId, action_source: actionSource, user_data: user };
  if (hasValue(value)) ev.custom_data = { value: Number(value), currency: currency || 'BRL' };
  return ev;
}

export function buildTikTokBody({ pixelCode, eventName, eventId, eventTime, lead, value, currency, testCode }) {
  const user = {};
  const email = normEmail(lead), phone = normPhone(lead);
  if (email) user.email = sha(email);
  if (phone) user.phone = sha(`+${phone}`); // E.164 antes do hash
  if (lead && lead.id) user.external_id = sha(String(lead.id));
  const ev = { event: TIKTOK_EVENTS[eventName] || eventName, event_time: eventTime, event_id: String(eventId), user };
  if (hasValue(value)) ev.properties = { value: Number(value), currency: currency || 'BRL', ...(eventName === 'Purchase' ? { order_id: String(eventId) } : {}) };
  return { event_source: 'web', event_source_id: pixelCode, ...(testCode ? { test_event_code: testCode } : {}), data: [ev] };
}

// client_id estável por lead (formato numérico "x.y" que o GA4 espera)
export const ga4ClientId = (lead) => { const h = sha(String((lead && (lead.id || lead.email)) || 'kobly')); return `${parseInt(h.slice(0, 8), 16)}.${parseInt(h.slice(8, 16), 16)}`; };
export function buildGa4Body({ eventName, eventId, lead, value, currency }) {
  const params = { engagement_time_msec: 1 };
  if (hasValue(value)) { params.value = Number(value); params.currency = currency || 'BRL'; }
  if (eventName === 'Purchase') params.transaction_id = String(eventId); // o GA4 não conta duas vezes a mesma compra
  return { client_id: ga4ClientId(lead), events: [{ name: GA4_EVENTS[eventName] || String(eventName).toLowerCase(), params }] };
}

export function createPixel({ pool, secretKey, fetchImpl = globalThis.fetch, graphBase = 'https://graph.facebook.com/v21.0', tiktokBase = 'https://business-api.tiktok.com/open_api/v1.3', ga4Base = 'https://www.google-analytics.com' }) {
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'pixel_unconfigured', 'Pixel não configurado neste ambiente (chave de segurança ausente).'); };
  const SAFE = 'id, organization_id, provider, label, pixel_id, test_event_code, created_at, updated_at';
  const fail = (msg, status) => Object.assign(new Error(msg), { status });
  async function request(url, init, who) {
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) }); } catch { throw fail(`${who} não respondeu agora.`, 503); }
    const j = await res.json().catch(() => ({}));
    return { res, j };
  }

  async function sendMeta(row, token, ev) {
    const { res, j } = await request(`${graphBase.replace(/\/$/, '')}/${encodeURIComponent(row.pixel_id)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: [buildCapiEvent(ev)], ...(row.test_event_code ? { test_event_code: row.test_event_code } : {}) }) }, 'A Meta');
    if (!res.ok) throw fail((j.error && (j.error.error_user_msg || j.error.message)) || `Meta respondeu ${res.status}`, res.status);
    return `recebido: ${j.events_received ?? '?'}`;
  }
  async function sendTikTok(row, token, ev) {
    const { res, j } = await request(`${tiktokBase}/event/track/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Access-Token': token },
      body: JSON.stringify(buildTikTokBody({ ...ev, pixelCode: row.pixel_id, testCode: row.test_event_code })) }, 'O TikTok');
    if (!res.ok || (j.code !== undefined && j.code !== 0)) throw fail(`TikTok: ${j.message || `HTTP ${res.status}`}`, res.ok ? 400 : res.status);
    return 'recebido pelo TikTok';
  }
  async function sendGa4(row, secret, ev, debug = false) {
    const q = `measurement_id=${encodeURIComponent(row.pixel_id)}&api_secret=${encodeURIComponent(secret)}`;
    const { res, j } = await request(`${ga4Base}/${debug ? 'debug/' : ''}mp/collect?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildGa4Body(ev)) }, 'O Google');
    if (!res.ok) throw fail(`Google respondeu ${res.status}`, res.status);
    // o envio normal sempre responde 2xx; só o modo de validação diz o que está errado
    const msgs = (j && j.validationMessages) || [];
    if (debug && msgs.length) throw fail(`Google: ${msgs[0].description || 'evento inválido'}`, 400);
    return debug ? 'validado pelo Google' : 'enviado ao Google';
  }

  // Envio a partir do fluxo. Devolve { ok, detail } (o fluxo segue mesmo se falhar).
  async function send({ orgId, configId, eventName, eventId, lead, value, currency, debug = false }) {
    const row = (await pool.query(`select * from public.pixel_configs where id::text = $1 and organization_id = $2`, [String(configId), orgId])).rows[0];
    if (!row) return { ok: false, detail: 'pixel não encontrado nesta empresa' };
    needKey();
    const ev = { eventName, eventId, eventTime: Math.floor(Date.now() / 1000), lead, value, currency };
    const token = decrypt(row.token_enc, secretKey);
    try {
      const detail = row.provider === 'tiktok' ? await sendTikTok(row, token, ev) : row.provider === 'google' ? await sendGa4(row, token, ev, debug) : await sendMeta(row, token, ev);
      return { ok: true, detail };
    } catch (e) { return { ok: false, detail: String(e.message).slice(0, 200), status: e.status }; }
  }

  // Rota pixel-configs (list | save | delete | test).
  async function handle(ctx, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar o Pixel.'); };
    switch (body.action) {
      case 'list': return { pixels: (await pool.query(`select ${SAFE} from public.pixel_configs where organization_id = $1 order by created_at`, [orgId])).rows };
      case 'save': {
        editor(); needKey();
        const provider = PIXEL_PROVIDERS[body.provider] ? body.provider : 'meta';
        const p = PIXEL_PROVIDERS[provider];
        const pixelId = String(body.pixel_id || '').trim().toUpperCase(), token = String(body.access_token || '').trim();
        if (!p.idRe.test(provider === 'meta' ? pixelId.replace(/\D/g, '') : pixelId)) throw new AuthError(422, 'validation_failed', p.idMsg);
        if (token.length < (provider === 'google' ? 10 : 20)) throw new AuthError(422, 'validation_failed', p.tokenMsg);
        const test = provider !== 'google' && body.test_event_code ? String(body.test_event_code).trim().slice(0, 40) : null;
        // nenhuma das três confere o token sem mandar evento: a tela oferece "Testar" depois de salvar
        const { rows } = await pool.query(`insert into public.pixel_configs (organization_id, provider, label, pixel_id, token_enc, test_event_code) values ($1,$2,$3,$4,$5,$6) returning ${SAFE}`,
          [orgId, provider, String(body.label || p.label).slice(0, 60), provider === 'meta' ? pixelId.replace(/\D/g, '') : pixelId, encrypt(token, secretKey), test]);
        return { pixel: rows[0] };
      }
      case 'delete': { editor(); const r = await pool.query(`delete from public.pixel_configs where id = $1 and organization_id = $2`, [body.id, orgId]); return { ok: r.rowCount === 1 }; }
      case 'test': {
        const r = await send({ orgId, configId: body.id, eventName: 'Lead', eventId: `teste-${Date.now()}`, lead: { email: 'teste@kobly.test' }, value: null, debug: true });
        if (!r.ok) throw new AuthError(400, 'pixel_test_failed', r.detail);
        return r;
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { send, handle };
}
