// WhatsApp não oficial pela Uazapi (docs.uazapi.com): o cliente conecta o número lendo um QR Code.
// O servidor Uazapi é o da Kobly (UAZAPI_BASE_URL + UAZAPI_ADMIN_TOKEN, só no ambiente do servidor).
//   POST /instance/create  (admintoken)  { name }  → token da instância (guardado cifrado)
//   POST /instance/connect (token)       {}        → inicia o QR Code (sem "phone")
//   GET  /instance/status  (token)                 → disconnected | connecting | connected | hibernated (+ qrcode)
//   POST /webhook          (token)       { enabled, url, events, excludeMessages }
//   POST /send/text        (token)       { number, text }
// Aviso "messages": { EventType, token, message: { messageid, chatid, sender, senderName, fromMe, isGroup, messageType, text } }.
// O aviso é aceito só se o "token" dele for o da instância daquela URL.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from './crypto.js';

const UUID = /^[0-9a-f-]{36}$/i;
const STATUS = new Set(['disconnected', 'connecting', 'connected', 'hibernated']);
const SAFE = 'id, label, status, phone, profile_name, last_error, connected_at, created_at';
const digits = (v) => String(v || '').split('@')[0].replace(/\D/g, '');

// resposta do /instance/status (ou do /instance/connect) → { status, qrcode, paircode, phone, profileName }
export function parseUazapiStatus(r) {
  const inst = (r && r.instance) || {};
  const flag = r && r.status && typeof r.status === 'object' ? r.status : {};
  let status = String(inst.status || (typeof r.status === 'string' ? r.status : '') || '').toLowerCase();
  if (flag.connected === true || flag.loggedIn === true) status = 'connected';
  if (!STATUS.has(status)) status = inst.qrcode || r.qrcode ? 'connecting' : 'disconnected';
  const qrcode = status === 'connected' ? null : (inst.qrcode || r.qrcode || null);
  return { status, qrcode, paircode: status === 'connected' ? null : (inst.paircode || r.paircode || null),
    phone: digits(inst.owner || flag.jid || r.owner) || null, profileName: inst.profileName || null };
}

export function createUazapi({ pool, secretKey, base = '', adminToken = '', publicBaseUrl = '', fetchImpl = globalThis.fetch, onInbound = null }) {
  const configured = () => !!(base && adminToken && secretKey);
  const need = () => { if (!configured()) throw new AuthError(503, 'uazapi_unconfigured', 'WhatsApp por QR Code ainda não está ativo neste servidor (falta configurar a Uazapi).'); };
  const url = (p) => `${String(base).replace(/\/$/, '')}${p}`;
  async function call(path, { method = 'GET', token = null, admin = false, body } = {}) {
    let res;
    try {
      res = await fetchImpl(url(path), { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(admin ? { admintoken: adminToken } : { token }) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    } catch { throw new AuthError(502, 'uazapi_unreachable', 'O servidor do WhatsApp (Uazapi) não respondeu.'); }
    let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
    if (res.status === 401 || res.status === 403) throw new AuthError(502, 'uazapi_auth', 'Uazapi recusou a credencial do servidor.');
    if (!res.ok) throw new AuthError(502, 'uazapi_error', `Uazapi: ${(j && (j.message || j.error)) || `HTTP ${res.status}`}`);
    return j || {};
  }
  async function own(orgId, id) {
    if (!UUID.test(String(id || ''))) throw new AuthError(422, 'validation_failed', 'Conexão inválida.');
    const r = (await pool.query(`select * from public.whatsapp_uazapi_instances where id = $1 and organization_id = $2`, [id, orgId])).rows[0];
    if (!r) throw new AuthError(404, 'not_found', 'Conexão não encontrada.');
    return r;
  }
  const tokenOf = (row) => decrypt(row.token_enc, secretKey);
  async function refresh(row) {
    const s = parseUazapiStatus(await call('/instance/status', { token: tokenOf(row) }));
    await pool.query(`update public.whatsapp_uazapi_instances set status = $2, phone = coalesce($3, phone), profile_name = coalesce($4, profile_name),
      connected_at = case when $2 = 'connected' and status <> 'connected' then now() else connected_at end, last_error = null where id = $1`, [row.id, s.status, s.phone, s.profileName]);
    return s;
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar conexões.'); };
    switch (body.action) {
      case 'list': return { configured: configured(), instances: (await pool.query(`select ${SAFE} from public.whatsapp_uazapi_instances where organization_id = $1 order by created_at`, [orgId])).rows };
      case 'create': { // cria a instância, aponta o webhook para a Kobly e já pede o QR Code
        editor(); need();
        const label = String(body.label || '').trim().slice(0, 60) || 'WhatsApp';
        const name = `kobly-${String(orgId).slice(0, 8)}-${randomBytes(4).toString('hex')}`;
        const c = await call('/instance/create', { method: 'POST', admin: true, body: { name } });
        const token = c.token || (c.instance && c.instance.token);
        if (!token) throw new AuthError(502, 'uazapi_error', 'Uazapi não devolveu o token da instância.');
        const row = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status) values ($1,$2,$3,$4,'connecting') returning *`,
          [orgId, label, name, encrypt(token, secretKey)])).rows[0];
        await call('/webhook', { method: 'POST', token, body: { enabled: true, url: `${String(publicBaseUrl).replace(/\/$/, '')}/webhooks/uazapi/${row.webhook_public_id}`, events: ['messages', 'connection'], excludeMessages: ['wasSentByApi'] } });
        const s = parseUazapiStatus(await call('/instance/connect', { method: 'POST', token, body: {} }));
        return { instance: { id: row.id, label, status: s.status }, qrcode: s.qrcode, paircode: s.paircode };
      }
      case 'qrcode': { // QR novo (o anterior expira em poucos segundos)
        editor(); need();
        const row = await own(orgId, body.id);
        const s = parseUazapiStatus(await call('/instance/connect', { method: 'POST', token: tokenOf(row), body: {} }));
        await pool.query(`update public.whatsapp_uazapi_instances set status = $2 where id = $1`, [row.id, s.status]);
        return { status: s.status, qrcode: s.qrcode, paircode: s.paircode };
      }
      case 'status': { need(); const s = await refresh(await own(orgId, body.id)); return { status: s.status, qrcode: s.qrcode, phone: s.phone, profile_name: s.profileName }; }
      case 'disconnect': { // sai do WhatsApp (precisa ler o QR de novo para voltar)
        editor(); need();
        const row = await own(orgId, body.id);
        await call('/instance/disconnect', { method: 'POST', token: tokenOf(row), body: {} }).catch(() => {});
        await pool.query(`update public.whatsapp_uazapi_instances set status = 'disconnected' where id = $1`, [row.id]);
        return { ok: true };
      }
      case 'remove': {
        editor(); need();
        const row = await own(orgId, body.id);
        await call('/instance', { method: 'DELETE', token: tokenOf(row) }).catch(() => {}); // some do servidor Uazapi; na Kobly sai de qualquer jeito
        await pool.query(`delete from public.whatsapp_uazapi_instances where id = $1`, [row.id]);
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  // Aviso da Uazapi em /webhooks/uazapi/:publicId
  async function receiveWebhook(publicId, rawBody) {
    if (!UUID.test(String(publicId || ''))) return { status: 404 };
    const row = (await pool.query(`select * from public.whatsapp_uazapi_instances where webhook_public_id = $1`, [publicId])).rows[0];
    if (!row || !secretKey) return { status: 404 };
    let p; try { p = JSON.parse(rawBody || '{}'); } catch { return { status: 400 }; }
    const real = tokenOf(row);
    if (typeof p.token !== 'string' || p.token.length !== real.length || !timingSafeEqual(Buffer.from(p.token), Buffer.from(real))) return { status: 401 };
    if (p.EventType === 'connection') {
      const s = parseUazapiStatus(p);
      if (s.status) await pool.query(`update public.whatsapp_uazapi_instances set status = $2, phone = coalesce($3, phone),
        connected_at = case when $2 = 'connected' and status <> 'connected' then now() else connected_at end where id = $1`, [row.id, s.status, s.phone]);
      return { status: 200 };
    }
    if (p.EventType !== 'messages' || !p.message) return { status: 200 };
    const m = p.message;
    if (m.fromMe || m.isGroup || m.wasSentByApi) return { status: 200 }; // só o que o lead manda, fora de grupos
    const from = digits(m.sender || m.chatid);
    if (!m.messageid || from.length < 8 || !onInbound) return { status: 200 };
    await onInbound({ orgId: row.organization_id, accountId: null, instanceId: row.id,
      message: { id: `uaz:${m.messageid}`, from, type: 'text', text: { body: String(m.text || '') }, timestamp: m.messageTimestamp },
      contacts: m.senderName ? [{ profile: { name: m.senderName }, wa_id: from }] : [] });
    return { status: 200 };
  }

  async function connectedRow(orgId) {
    return (await pool.query(`select * from public.whatsapp_uazapi_instances where organization_id = $1 and status = 'connected' order by connected_at desc nulls last limit 1`, [orgId])).rows[0] || null;
  }
  // Envio de texto por uma instância conectada da empresa (sem janela de 24 h: é o WhatsApp comum)
  async function sendTextTo(orgId, { to, text }) {
    if (!configured()) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const row = await connectedRow(orgId);
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const number = digits(to);
    if (number.length < 10) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDI + DDD + número.');
    const r = await call('/send/text', { method: 'POST', token: tokenOf(row), body: { number, text: String(text || '').slice(0, 4096) } });
    return { ok: true, id: r.messageid || r.id || (r.message && r.message.messageid) || null, to: number, channel: 'uazapi' };
  }
  const hasConnected = async (orgId) => configured() && !!(await connectedRow(orgId));
  return { handle, receiveWebhook, sendTextTo, hasConnected, configured };
}
