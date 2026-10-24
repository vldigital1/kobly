// Pixel da Meta pela API de Conversões (servidor → Meta). Token por empresa, cifrado no banco.
// Dados pessoais vão só em hash SHA-256 (e-mail minúsculo, telefone só dígitos), como a Meta exige.
import { createHash } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
export const EVENT_NAMES = { Purchase: 'Purchase', Lead: 'Lead', InitiateCheckout: 'InitiateCheckout', AddPaymentInfo: 'AddPaymentInfo' };

export function buildCapiEvent({ eventName, eventId, eventTime, lead, value, currency, actionSource = 'system_generated' }) {
  const user = {};
  const email = String((lead && lead.email) || '').trim().toLowerCase();
  const phone = String((lead && lead.telefone) || '').replace(/\D/g, '');
  if (email) user.em = [sha(email)];
  if (phone) user.ph = [sha(phone)];
  if (lead && lead.id) user.external_id = [sha(String(lead.id))];
  const ev = { event_name: eventName, event_time: eventTime, event_id: eventId, action_source: actionSource, user_data: user };
  if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) ev.custom_data = { value: Number(value), currency: currency || 'BRL' };
  return ev;
}

export function createPixel({ pool, secretKey, fetchImpl = globalThis.fetch, graphBase = 'https://graph.facebook.com/v21.0' }) {
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'pixel_unconfigured', 'Pixel não configurado neste ambiente (chave de segurança ausente).'); };
  const SAFE = 'id, organization_id, label, pixel_id, test_event_code, created_at, updated_at';

  async function post(pixelId, token, data, testCode) {
    const url = `${graphBase.replace(/\/$/, '')}/${encodeURIComponent(pixelId)}/events`;
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data, ...(testCode ? { test_event_code: testCode } : {}) }), signal: AbortSignal.timeout(15000) });
    } catch { throw Object.assign(new Error('A Meta não respondeu agora.'), { status: 503 }); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((j.error && (j.error.error_user_msg || j.error.message)) || `Meta respondeu ${res.status}`), { status: res.status });
    return j;
  }

  // Envio de um evento a partir do fluxo. Devolve { ok, detail } (o fluxo segue mesmo se falhar).
  async function send({ orgId, configId, eventName, eventId, lead, value, currency }) {
    const row = (await pool.query(`select * from public.pixel_configs where id::text = $1 and organization_id = $2`, [String(configId), orgId])).rows[0];
    if (!row) return { ok: false, detail: 'pixel não encontrado nesta empresa' };
    needKey();
    const ev = buildCapiEvent({ eventName, eventId, eventTime: Math.floor(Date.now() / 1000), lead, value, currency });
    try { const r = await post(row.pixel_id, decrypt(row.token_enc, secretKey), [ev], row.test_event_code); return { ok: true, detail: `recebido: ${r.events_received ?? '?'}` }; }
    catch (e) { return { ok: false, detail: String(e.message).slice(0, 200), status: e.status }; }
  }

  // Rota pixel-configs (list | save | delete | test).
  async function handle(ctx, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar o Pixel.'); };
    switch (body.action) {
      case 'list': return { pixels: (await pool.query(`select ${SAFE} from public.pixel_configs where organization_id = $1 order by created_at`, [orgId])).rows };
      case 'save': {
        editor(); needKey();
        const pixelId = String(body.pixel_id || '').trim(), token = String(body.access_token || '').trim();
        if (!/^\d{5,25}$/.test(pixelId)) throw new AuthError(422, 'validation_failed', 'O ID do Pixel tem só números.');
        if (token.length < 20) throw new AuthError(422, 'validation_failed', 'Informe o token da API de Conversões.');
        const test = body.test_event_code ? String(body.test_event_code).trim().slice(0, 40) : null;
        // a Meta não tem verificação de token sem enviar evento: a tela oferece a ação "test" depois de salvar
        const { rows } = await pool.query(`insert into public.pixel_configs (organization_id, label, pixel_id, token_enc, test_event_code) values ($1,$2,$3,$4,$5) returning ${SAFE}`,
          [orgId, String(body.label || 'Pixel').slice(0, 60), pixelId, encrypt(token, secretKey), test]);
        return { pixel: rows[0] };
      }
      case 'delete': { editor(); const r = await pool.query(`delete from public.pixel_configs where id = $1 and organization_id = $2`, [body.id, orgId]); return { ok: r.rowCount === 1 }; }
      case 'test': {
        const r = await send({ orgId, configId: body.id, eventName: 'Lead', eventId: `teste-${Date.now()}`, lead: { email: 'teste@kobly.test' }, value: null });
        if (!r.ok) throw new AuthError(400, 'pixel_test_failed', r.detail);
        return r;
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { send, handle };
}
