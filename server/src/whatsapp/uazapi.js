// WhatsApp não oficial pela Uazapi (docs.uazapi.com): o cliente conecta o número lendo um QR Code.
// Vários servidores (0081): a Kobly cadastra servidores Uazapi (endereço + admintoken + limite de números);
// cada número novo vai para o servidor ativo com mais folga e fica preso a ele (server_id). O servidor do
// ambiente (UAZAPI_BASE_URL + UAZAPI_ADMIN_TOKEN) conta como mais um, com limite UAZAPI_CAPACITY.
//   POST /instance/create  (admintoken)  { name }  → token da instância (guardado cifrado)
//   POST /instance/connect (token)       {}        → inicia o QR Code (sem "phone")
//   GET  /instance/status  (token)                 → disconnected | connecting | connected | hibernated (+ qrcode)
//   POST /webhook          (token)       { enabled, url, events, excludeMessages }
//   POST /send/text        (token)       { number, text }
//   POST /profile/name     (token)       { name }   (até 25 caracteres)
//   POST /profile/image    (token)       { image }  (JPEG 640x640: link, base64 ou "remove")
// Aviso "messages": { EventType, token, message: { messageid, chatid, sender, senderName, fromMe, isGroup, messageType, text } }.
// O aviso é aceito só se o "token" dele for o da instância daquela URL.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from './crypto.js';

const UUID = /^[0-9a-f-]{36}$/i;
const STATUS = new Set(['disconnected', 'connecting', 'connected', 'hibernated']);
const SAFE = 'id, label, status, phone, profile_name, profile_pic_url, is_business, last_seen_at, disconnect_reason, pause_flows_on_disconnect, last_error, connected_at, created_at';
const digits = (v) => String(v || '').split('@')[0].replace(/\D/g, '');
const ENV = 'env'; // id do servidor do ambiente na lista de servidores

// resposta do /instance/status (ou do /instance/connect) → { status, qrcode, paircode, phone, profileName, profilePicUrl, isBusiness, disconnectReason }
export function parseUazapiStatus(r) {
  const inst = (r && r.instance) || {};
  const flag = r && r.status && typeof r.status === 'object' ? r.status : {};
  let status = String(inst.status || (typeof r.status === 'string' ? r.status : '') || '').toLowerCase();
  if (flag.connected === true || flag.loggedIn === true) status = 'connected';
  if (!STATUS.has(status)) status = inst.qrcode || r.qrcode ? 'connecting' : 'disconnected';
  const qrcode = status === 'connected' ? null : (inst.qrcode || r.qrcode || null);
  return { status, qrcode, paircode: status === 'connected' ? null : (inst.paircode || r.paircode || null),
    phone: digits(inst.owner || flag.jid || r.owner) || null, profileName: inst.profileName || null,
    profilePicUrl: /^https:\/\//.test(String(inst.profilePicUrl || '')) ? String(inst.profilePicUrl).slice(0, 1000) : null,
    isBusiness: typeof inst.isBusiness === 'boolean' ? inst.isBusiness : null,
    disconnectReason: status === 'connected' ? null : (String(inst.lastDisconnectReason || '').slice(0, 200) || null) };
}

// Servidor para um número novo: ativo, com vaga, o de menor ocupação proporcional (empate: o mais antigo).
export function pickServer(servers) {
  const free = servers.filter((s) => s.active && s.used < s.capacity);
  free.sort((a, b) => a.used / a.capacity - b.used / b.capacity || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return free[0] || null;
}

export function createUazapi({ pool, secretKey, base = '', adminToken = '', envCapacity = 300, publicBaseUrl = '', fetchImpl = globalThis.fetch, onInbound = null }) {
  const envServer = base && adminToken ? { id: ENV, label: 'Servidor do ambiente', base, adminToken, capacity: envCapacity, active: true, fromEnv: true, created_at: '0' } : null;
  const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };

  // Todos os servidores com o uso atual (números cadastrados em cada um)
  async function servers() {
    const used = new Map((await pool.query(`select coalesce(server_id::text, '${ENV}') as sid, count(*)::int as n,
      count(*) filter (where status = 'connected')::int as on_ from public.whatsapp_uazapi_instances group by 1`)).rows.map((r) => [r.sid, r]));
    const db = secretKey ? (await pool.query(`select * from public.uazapi_servers order by created_at`)).rows.map((s) => ({
      id: s.id, label: s.label, base: s.base_url, tokenHint: s.token_hint, capacity: s.capacity, active: s.active, created_at: s.created_at.toISOString(),
      adminToken: decrypt(s.admin_token_enc, secretKey) })) : [];
    return [...(envServer ? [envServer] : []), ...db].map((s) => ({ ...s, used: (used.get(s.id) || {}).n || 0, connected: (used.get(s.id) || {}).on_ || 0 }));
  }
  async function serverOf(row) {
    if (!row.server_id) { if (!envServer) throw new AuthError(503, 'uazapi_unconfigured', 'O servidor deste número não está mais configurado.'); return envServer; }
    const s = (await pool.query(`select * from public.uazapi_servers where id = $1`, [row.server_id])).rows[0];
    if (!s) throw new AuthError(503, 'uazapi_unconfigured', 'O servidor deste número não existe mais.');
    return { id: s.id, base: s.base_url, adminToken: decrypt(s.admin_token_enc, secretKey) };
  }
  const configured = async () => !!secretKey && (await servers()).some((s) => s.active);

  async function call(server, path, { method = 'GET', token = null, admin = false, body } = {}) {
    let res;
    try {
      res = await fetchImpl(`${String(server.base).replace(/\/$/, '')}${path}`, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(admin ? { admintoken: server.adminToken } : { token }) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    } catch { throw new AuthError(502, 'uazapi_unreachable', 'O servidor do WhatsApp (Uazapi) não respondeu.'); }
    let j = null; try { j = await res.json(); } catch { /* sem corpo */ }
    if (res.status === 401 || res.status === 403) throw new AuthError(502, 'uazapi_auth', 'Uazapi recusou a credencial do servidor.');
    if (!res.ok) throw new AuthError(502, 'uazapi_error', `Uazapi: ${(j && (j.message || j.error)) || `HTTP ${res.status}`}`);
    return j || {};
  }
  async function own(orgId, id) {
    if (!UUID.test(String(id || ''))) fail('Conexão inválida.');
    const r = (await pool.query(`select * from public.whatsapp_uazapi_instances where id = $1 and organization_id = $2`, [id, orgId])).rows[0];
    if (!r) throw new AuthError(404, 'not_found', 'Conexão não encontrada.');
    return r;
  }
  const tokenOf = (row) => decrypt(row.token_enc, secretKey);
  async function refresh(row) {
    const s = parseUazapiStatus(await call(await serverOf(row), '/instance/status', { token: tokenOf(row) }));
    await pool.query(`update public.whatsapp_uazapi_instances set status = $2, phone = coalesce($3, phone), profile_name = coalesce($4, profile_name),
      profile_pic_url = coalesce($5, profile_pic_url), is_business = coalesce($6, is_business), disconnect_reason = $7,
      last_seen_at = case when $2 = 'connected' then now() else last_seen_at end,
      connected_at = case when $2 = 'connected' and status <> 'connected' then now() else connected_at end, last_error = null where id = $1`,
      [row.id, s.status, s.phone, s.profileName, s.profilePicUrl, s.isBusiness, s.disconnectReason]);
    await statusChanged(row, s.status);
    return s;
  }
  // "Pausar fluxos ao desconectar": caiu e a empresa ficou sem WhatsApp conectado → pausa os fluxos ativos e guarda quais;
  // voltou → reativa só esses (os que ninguém mexeu nesse meio-tempo).
  async function statusChanged(row, status) {
    if (!row.pause_flows_on_disconnect || row.status === status) return;
    if (row.status === 'connected' && status !== 'connected') {
      const other = (await pool.query(`select (select count(*) from public.whatsapp_uazapi_instances where organization_id = $1 and id <> $2 and status = 'connected')
        + (select count(*) from public.whatsapp_accounts where organization_id = $1 and status = 'connected') as n`, [row.organization_id, row.id])).rows[0];
      if (Number(other.n) > 0) return;
      const r = await pool.query(`update public.campaigns c set status_campanha = 'Pausada' where c.organization_id = $1 and c.status_campanha = 'Ativa'
        and exists (select 1 from public.campaign_flows f join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where f.campaign_id = c.id) returning c.id`, [row.organization_id]);
      if (r.rowCount) await pool.query(`update public.whatsapp_uazapi_instances set paused_campaigns = $2 where id = $1`, [row.id, r.rows.map((x) => x.id)]);
    } else if (status === 'connected' && (row.paused_campaigns || []).length) {
      await pool.query(`update public.campaigns set status_campanha = 'Ativa' where id = any($2::uuid[]) and organization_id = $1 and status_campanha = 'Pausada'`, [row.organization_id, row.paused_campaigns]);
      await pool.query(`update public.whatsapp_uazapi_instances set paused_campaigns = '{}' where id = $1`, [row.id]);
    }
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar conexões.'); };
    const need = async () => { if (!(await configured())) throw new AuthError(503, 'uazapi_unconfigured', 'WhatsApp por QR Code ainda não está ativo neste servidor (falta configurar a Uazapi).'); };
    switch (body.action) {
      case 'list': { // + quantos fluxos publicados estão ligados (todos os números da empresa atendem os fluxos)
        const flows = (await pool.query(`select count(distinct c.id)::int as n from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
          join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where c.organization_id = $1 and c.status_campanha = 'Ativa'`, [orgId])).rows[0].n;
        return { configured: await configured(), flows_active: flows, instances: (await pool.query(`select ${SAFE} from public.whatsapp_uazapi_instances where organization_id = $1 order by created_at`, [orgId])).rows };
      }
      case 'create': { // escolhe o servidor com vaga, cria a instância, aponta o webhook para a Kobly e já pede o QR Code
        editor(); await need();
        const server = pickServer(await servers());
        if (!server) throw new AuthError(503, 'uazapi_full', 'Todos os servidores de WhatsApp estão cheios agora. Avise o suporte da Kobly.');
        const label = String(body.label || '').trim().slice(0, 60) || 'WhatsApp';
        const name = `kobly-${String(orgId).slice(0, 8)}-${randomBytes(4).toString('hex')}`;
        const c = await call(server, '/instance/create', { method: 'POST', admin: true, body: { name } });
        const token = c.token || (c.instance && c.instance.token);
        if (!token) throw new AuthError(502, 'uazapi_error', 'Uazapi não devolveu o token da instância.');
        const row = (await pool.query(`insert into public.whatsapp_uazapi_instances (organization_id, label, instance_name, token_enc, status, server_id) values ($1,$2,$3,$4,'connecting',$5) returning *`,
          [orgId, label, name, encrypt(token, secretKey), server.id === ENV ? null : server.id])).rows[0];
        await call(server, '/webhook', { method: 'POST', token, body: { enabled: true, url: `${String(publicBaseUrl).replace(/\/$/, '')}/webhooks/uazapi/${row.webhook_public_id}`, events: ['messages', 'connection'], excludeMessages: ['wasSentByApi'] } });
        const s = parseUazapiStatus(await call(server, '/instance/connect', { method: 'POST', token, body: {} }));
        return { instance: { id: row.id, label, status: s.status }, qrcode: s.qrcode, paircode: s.paircode };
      }
      case 'qrcode': { // QR novo (o anterior expira em poucos segundos)
        editor();
        const row = await own(orgId, body.id);
        const s = parseUazapiStatus(await call(await serverOf(row), '/instance/connect', { method: 'POST', token: tokenOf(row), body: {} }));
        await pool.query(`update public.whatsapp_uazapi_instances set status = $2 where id = $1`, [row.id, s.status]);
        return { status: s.status, qrcode: s.qrcode, paircode: s.paircode };
      }
      case 'status': { const s = await refresh(await own(orgId, body.id)); return { status: s.status, qrcode: s.qrcode, phone: s.phone, profile_name: s.profileName, profile_pic_url: s.profilePicUrl, is_business: s.isBusiness }; }
      case 'rename': { // nome da conexão na Kobly (não muda o perfil do WhatsApp)
        editor();
        const row = await own(orgId, body.id);
        const label = String(body.label || '').trim().slice(0, 60);
        if (!label) fail('Dê um nome para a conexão.');
        await pool.query(`update public.whatsapp_uazapi_instances set label = $2 where id = $1`, [row.id, label]);
        return { ok: true };
      }
      case 'disconnect': { // sai do WhatsApp (precisa ler o QR de novo para voltar)
        editor();
        const row = await own(orgId, body.id);
        await call(await serverOf(row), '/instance/disconnect', { method: 'POST', token: tokenOf(row), body: {} }).catch(() => {});
        await pool.query(`update public.whatsapp_uazapi_instances set status = 'disconnected' where id = $1`, [row.id]);
        await statusChanged(row, 'disconnected');
        return { ok: true };
      }
      case 'settings': { // opções da conexão na Kobly
        editor();
        const row = await own(orgId, body.id);
        if (typeof body.pause_flows_on_disconnect === 'boolean') await pool.query(`update public.whatsapp_uazapi_instances set pause_flows_on_disconnect = $2 where id = $1`, [row.id, body.pause_flows_on_disconnect]);
        return { ok: true };
      }
      case 'profile': { // nome e foto do perfil no WhatsApp (todos os contatos veem)
        editor();
        const row = await own(orgId, body.id);
        if (row.status !== 'connected') fail('Conecte o número antes de mudar o perfil.');
        const server = await serverOf(row), token = tokenOf(row);
        if (body.name !== undefined) {
          const name = String(body.name || '').trim();
          if (!name || name.length > 25) fail('O nome do perfil precisa ter de 1 a 25 caracteres.');
          await call(server, '/profile/name', { method: 'POST', token, body: { name } });
        }
        if (body.remove_image === true) await call(server, '/profile/image', { method: 'POST', token, body: { image: 'remove' } });
        else if (body.image !== undefined) {
          const img = String(body.image || '');
          if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 1_500_000) fail('Envie a foto em JPEG (a Kobly ajusta para 640×640).');
          await call(server, '/profile/image', { method: 'POST', token, body: { image: img } });
        }
        if (body.remove_image === true) await pool.query(`update public.whatsapp_uazapi_instances set profile_pic_url = null where id = $1`, [row.id]);
        const s = await refresh({ ...row });
        return { ok: true, profile_name: s.profileName, profile_pic_url: body.remove_image === true ? null : s.profilePicUrl };
      }
      case 'remove': {
        editor();
        const row = await own(orgId, body.id);
        const server = await serverOf(row).catch(() => null);
        if (server) await call(server, '/instance', { method: 'DELETE', token: tokenOf(row) }).catch(() => {}); // some do servidor Uazapi; na Kobly sai de qualquer jeito
        await pool.query(`delete from public.whatsapp_uazapi_instances where id = $1`, [row.id]);
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  // Rota uazapi-servers (só Administrador da Kobly): list | add | update | remove.
  async function handleServers(body) {
    if (!secretKey) throw new AuthError(503, 'uazapi_unconfigured', 'Chave de segurança ausente neste ambiente.');
    switch (body.action) {
      case 'list': {
        const list = await servers();
        const tot = list.filter((s) => s.active).reduce((t, s) => ({ capacity: t.capacity + s.capacity, used: t.used + s.used }), { capacity: 0, used: 0 });
        return { servers: list.map(({ adminToken, base: b, ...s }) => ({ ...s, base_url: b, token_hint: s.tokenHint || `…${String(adminToken).slice(-4)}` })), totals: tot };
      }
      case 'add': {
        const url = String(body.base_url || '').trim().replace(/\/$/, '');
        if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) fail('Endereço do servidor precisa começar com https://');
        const token = String(body.admin_token || '').trim();
        if (token.length < 8) fail('Cole o admintoken do servidor.');
        const capacity = Number(body.capacity || 300);
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) fail('Limite de números inválido.');
        if (envServer && url === String(envServer.base).replace(/\/$/, '')) fail('Este servidor já está configurado no ambiente.');
        try {
          const r = await pool.query(`insert into public.uazapi_servers (label, base_url, admin_token_enc, token_hint, capacity) values ($1,$2,$3,$4,$5) returning id`,
            [String(body.label || '').trim().slice(0, 60) || `Servidor ${url.replace(/^https:\/\//, '').split('.')[0]}`, url, encrypt(token, secretKey), `…${token.slice(-4)}`, capacity]);
          return { ok: true, id: r.rows[0].id };
        } catch (e) { if (e.code === '23505') fail('Este servidor já foi cadastrado.'); throw e; }
      }
      case 'update': { // limite, nome ou pausar (servidor pausado não recebe números novos; os que já estão continuam)
        if (!UUID.test(String(body.id || ''))) fail('Servidor inválido.');
        const sets = [], vals = [body.id];
        if (body.capacity !== undefined) { const c = Number(body.capacity); if (!Number.isInteger(c) || c < 1 || c > 100000) fail('Limite de números inválido.'); vals.push(c); sets.push(`capacity = $${vals.length}`); }
        if (body.active !== undefined) { vals.push(!!body.active); sets.push(`active = $${vals.length}`); }
        if (body.label !== undefined) { vals.push(String(body.label).trim().slice(0, 60) || 'Servidor'); sets.push(`label = $${vals.length}`); }
        if (!sets.length) fail('Nada para alterar.');
        const r = await pool.query(`update public.uazapi_servers set ${sets.join(', ')} where id = $1`, vals);
        if (!r.rowCount) throw new AuthError(404, 'not_found', 'Servidor não encontrado.');
        return { ok: true };
      }
      case 'remove': {
        if (!UUID.test(String(body.id || ''))) fail('Servidor inválido.');
        const n = (await pool.query(`select count(*)::int as n from public.whatsapp_uazapi_instances where server_id = $1`, [body.id])).rows[0].n;
        if (n) fail(`Este servidor ainda tem ${n} número(s). Pause o servidor para não receber novos e remova quando esvaziar.`);
        await pool.query(`delete from public.uazapi_servers where id = $1`, [body.id]);
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
        last_seen_at = case when $2 = 'connected' then now() else last_seen_at end, disconnect_reason = $4,
        connected_at = case when $2 = 'connected' and status <> 'connected' then now() else connected_at end where id = $1`, [row.id, s.status, s.phone, s.disconnectReason]);
      if (s.status) await statusChanged(row, s.status);
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
  const msgIdOf = (r) => r.messageid || r.id || (r.message && r.message.messageid) || null;
  // Envio de texto por uma instância conectada da empresa (sem janela de 24 h: é o WhatsApp comum)
  async function sendTextTo(orgId, { to, text }) {
    const row = secretKey ? await connectedRow(orgId) : null;
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const number = digits(to);
    if (number.length < 10) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDI + DDD + número.');
    const r = await call(await serverOf(row), '/send/text', { method: 'POST', token: tokenOf(row), body: { number, text: String(text || '').slice(0, 4096) } });
    return { ok: true, id: msgIdOf(r), to: number, channel: 'uazapi', instanceId: row.id };
  }
  // Mídia por link público: POST /send/media { number, type, file, text, docName }
  async function sendMediaTo(orgId, { to, kind, url, caption, filename }) {
    const row = secretKey ? await connectedRow(orgId) : null;
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const number = digits(to);
    if (number.length < 10) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDI + DDD + número.');
    const type = { image: 'image', video: 'video', audio: 'ptt', document: 'document' }[kind] || 'document';
    const body = { number, type, file: url, ...(caption && kind !== 'audio' ? { text: String(caption).slice(0, 1024) } : {}), ...(kind === 'document' && filename ? { docName: String(filename).slice(0, 120) } : {}) };
    const r = await call(await serverOf(row), '/send/media', { method: 'POST', token: tokenOf(row), body });
    return { ok: true, id: msgIdOf(r), to: number, channel: 'uazapi', instanceId: row.id };
  }
  // Apaga para todos uma mensagem enviada pela instância: POST /message/delete { id }
  async function deleteMessage(orgId, { instanceId, messageId }) {
    const row = await own(orgId, instanceId);
    if (row.status !== 'connected') throw new AuthError(409, 'not_connected', 'O WhatsApp desta mensagem está desconectado.');
    await call(await serverOf(row), '/message/delete', { method: 'POST', token: tokenOf(row), body: { id: String(messageId) } });
    return { ok: true };
  }
  const hasConnected = async (orgId) => !!secretKey && !!(await connectedRow(orgId));
  return { handle, handleServers, receiveWebhook, sendTextTo, sendMediaTo, deleteMessage, hasConnected, configured };
}
