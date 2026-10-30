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
//   POST /chat/find        (token)       { sort, limit, offset, wa_isGroup } → { chats: [{ wa_chatid, phone, name, wa_contactName, wa_isGroup }], pagination }
//   POST /message/find     (token)       { chatid, limit, offset } → { messages: [...] } (mais recentes primeiro)
//   POST /message/download (token)       { id, generate_mp3 } → { fileURL, mimetype }  (link vale 2 dias)
//   POST /chat/avatar      (token)       { number, preview } → { url }
//   POST /call/make        (token)       { number, call_duration } → ligação (muda) só para chamar a atenção
// Aviso "messages": { EventType, token, chat, message: { messageid, chatid, sender, sender_pn, senderName, fromMe, isGroup, messageType, text, messageTimestamp (ms) } }.
// Toda conversa do número aparece em Conversas: quem escreve e não é lead vira lead (utm_source = whatsapp) e o que a
// empresa responde pelo celular entra como saída "celular". Ao conectar, puxa o histórico recente (HISTORY_*).
// O aviso é aceito só se o "token" dele for o da instância daquela URL.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from './crypto.js';
import { OPT_OUT } from './service.js';

const UUID = /^[0-9a-f-]{36}$/i;
const STATUS = new Set(['disconnected', 'connecting', 'connected', 'hibernated']);
const SAFE = 'id, label, status, phone, profile_name, profile_pic_url, is_business, last_seen_at, disconnect_reason, pause_flows_on_disconnect, last_error, connected_at, created_at, history_status, history_count, history_at, history_error';
const digits = (v) => String(v || '').split('@')[0].replace(/\D/g, '');
const ENV = 'env'; // id do servidor do ambiente na lista de servidores
const HISTORY_CHATS = 150, HISTORY_PER_CHAT = 40; // conversas mais recentes e mensagens de cada uma

// telefone do contato da conversa (nunca o do próprio número): JID @s.whatsapp.net, o "phone" do chat ou o sender_pn
// de quem mandou. Conversa só com @lid (sem telefone conhecido) fica de fora.
export function contactPhone(m, chat) {
  const pn = (j) => { const v = String(j || ''); return !v.includes('@') || /@s\.whatsapp\.net$/.test(v) ? digits(v) : ''; };
  const c = chat || {};
  const v = pn(m.chatid) || pn(c.wa_chatid) || digits(c.phone) || (!m.fromMe ? pn(m.sender_pn) || pn(m.sender) : '');
  return v.length >= 10 ? v : '';
}
// texto para a lista: legenda/texto ou o tipo da mídia
export function messageText(m) {
  const t = String(m.text || '').trim();
  if (t) return t.slice(0, 4096);
  const k = String(m.messageType || '').toLowerCase();
  for (const [w, label] of [['image', 'imagem'], ['audio', 'áudio'], ['ptt', 'áudio'], ['video', 'vídeo'], ['document', 'arquivo'], ['sticker', 'figurinha'], ['location', 'localização'], ['contact', 'contato']]) if (k.includes(w)) return `[${label}]`;
  return '[mensagem]';
}
// tipo da mídia para o chat tocar/mostrar: image | audio | video | document | sticker | text
export function mediaKind(m) {
  const k = String((m && m.messageType) || '').toLowerCase();
  if (k.includes('sticker')) return 'sticker';
  if (k.includes('image')) return 'image';
  if (k.includes('audio') || k.includes('ptt')) return 'audio';
  if (k.includes('video')) return 'video';
  if (k.includes('document')) return 'document';
  return 'text';
}
const avatarOfChat = (c) => { const u = String((c && (c.imagePreview || c.image)) || ''); return /^https:\/\//.test(u) ? u.slice(0, 1000) : null; };
// messageTimestamp vem em milissegundos (alguns servidores mandam em segundos)
const tsOf = (v) => { const n = Number(v); return n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(); };

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
    if (s.status === 'connected') startHistory(row);
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

  // lead do contato (mesma regra de telefone do descadastro: últimos 10 dígitos); cria se ainda não existir
  async function saveAvatar(leadId, url) {
    if (url) await pool.query(`update public.leads set avatar_url = $2, avatar_at = now() where id = $1`, [leadId, url]);
  }
  async function leadFor(orgId, phone, name) {
    const found = (await pool.query(`select id, nome from public.leads where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2 order by updated_at desc limit 1`, [orgId, phone.slice(-10)])).rows[0];
    const nome = String(name || '').trim().slice(0, 120) || null;
    if (found) { if (!found.nome && nome) await pool.query(`update public.leads set nome = $2 where id = $1`, [found.id, nome]); return found.id; }
    return (await pool.query(`insert into public.leads (organization_id, nome, telefone, utm) values ($1, $2, $3, '{"utm_source":"whatsapp"}'::jsonb) returning id`, [orgId, nome, phone])).rows[0].id;
  }
  // anúncio que trouxe o lead (Click-to-WhatsApp): vem em contextInfo.externalAdReply; mesmo formato do "referral" da API oficial
  function adReplyOf(m) {
    const c = m && typeof m.content === 'object' && m.content ? m.content : {};
    const x = (c.contextInfo && c.contextInfo.externalAdReply) || (m.contextInfo && m.contextInfo.externalAdReply) || m.externalAdReply || null;
    if (!x || typeof x !== 'object') return null;
    const pick = (...k) => { for (const key of k) if (x[key]) return String(x[key]).slice(0, 500); return undefined; };
    const r = { source_id: pick('sourceID', 'sourceId', 'source_id'), source_url: pick('sourceURL', 'sourceUrl', 'source_url'), headline: pick('title', 'headline'), body: pick('body'), ctwa_clid: pick('ctwaClid', 'ctwa_clid'), source_type: pick('sourceType', 'source_type') };
    return Object.values(r).some(Boolean) ? r : null;
  }
  // o que a empresa mandou pelo próprio celular (não passou pela Kobly)
  async function saveFromPhone(row, leadId, phone, m) {
    return (await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, wa_message_id, channel, created_at, msg_type, instance_id)
      select $1, $2, $3, 'celular', $4, $5, 'uazapi', $6, $7, $8 where not exists (select 1 from public.whatsapp_outbound_messages where organization_id = $1 and wa_message_id = $5)`,
      [row.organization_id, leadId, phone, messageText(m), `uaz:${m.messageid}`, tsOf(m.messageTimestamp), mediaKind(m), row.id])).rowCount;
  }

  // Histórico: as conversas mais recentes do número (sem grupos), sem disparar fluxo nem resposta automática.
  const importing = new Set();
  function startHistory(row) {
    if (row.history_status || importing.has(row.id)) return; // uma vez por conexão; "Importar de novo" zera o status
    importing.add(row.id);
    importHistory(row).catch(() => {}).finally(() => importing.delete(row.id));
  }
  async function importHistory(row) {
    const claimed = await pool.query(`update public.whatsapp_uazapi_instances set history_status = 'running', history_error = null where id = $1 and (history_status is null or history_status <> 'running') returning id`, [row.id]);
    if (!claimed.rowCount) return;
    let count = 0;
    try {
      const server = await serverOf(row), token = tokenOf(row);
      const chats = [];
      for (let offset = 0; chats.length < HISTORY_CHATS; offset += 50) {
        const r = await call(server, '/chat/find', { method: 'POST', token, body: { operator: 'AND', sort: '-wa_lastMsgTimestamp', limit: 50, offset, wa_isGroup: false } });
        const page = Array.isArray(r.chats) ? r.chats : [];
        chats.push(...page.filter((c) => !c.wa_isGroup && !/@(g\.us|newsletter|broadcast)$/.test(String(c.wa_chatid || ''))));
        if (!page.length || !(r.pagination && r.pagination.hasMore)) break;
      }
      for (const chat of chats.slice(0, HISTORY_CHATS)) {
        const phone = contactPhone({}, chat);
        if (!phone || phone === digits(row.phone)) continue;
        const r = await call(server, '/message/find', { method: 'POST', token, body: { chatid: chat.wa_chatid, limit: HISTORY_PER_CHAT, offset: 0 } }).catch(() => ({}));
        const msgs = (Array.isArray(r.messages) ? r.messages : []).filter((m) => m.messageid && !m.isGroup && !m.wasSentByApi);
        if (!msgs.length) continue;
        const leadId = await leadFor(row.organization_id, phone, chat.wa_contactName || chat.name || chat.wa_name || (msgs.find((m) => !m.fromMe) || {}).senderName);
        await saveAvatar(leadId, avatarOfChat(chat));
        let lastIn = null;
        for (const m of msgs) {
          if (m.fromMe) { count += await saveFromPhone(row, leadId, phone, m); continue; }
          const at = tsOf(m.messageTimestamp);
          const ins = await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, instance_id, wa_message_id, from_phone, lead_id, msg_type, body, payload, received_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) on conflict (wa_message_id) do nothing`,
            [row.organization_id, row.id, `uaz:${m.messageid}`, phone, leadId, mediaKind(m), messageText(m), JSON.stringify({ history: true, uaz_id: m.id || null }), at]);
          count += ins.rowCount;
          if (!lastIn || at > lastIn) lastIn = at;
        }
        if (lastIn) await pool.query(`update public.leads set whatsapp_last_inbound_at = greatest(coalesce(whatsapp_last_inbound_at, $2), $2) where id = $1`, [leadId, lastIn]);
        await pool.query(`update public.whatsapp_uazapi_instances set history_count = $2 where id = $1`, [row.id, count]);
      }
      await pool.query(`update public.whatsapp_uazapi_instances set history_status = 'done', history_count = $2, history_at = now() where id = $1`, [row.id, count]);
    } catch (e) {
      await pool.query(`update public.whatsapp_uazapi_instances set history_status = 'error', history_count = $2, history_error = $3, history_at = now() where id = $1`, [row.id, count, String(e.message || e).slice(0, 300)]);
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
        const instances = (await pool.query(`select ${SAFE} from public.whatsapp_uazapi_instances where organization_id = $1 order by created_at`, [orgId])).rows;
        for (const i of instances) if (i.status === 'connected' && !i.history_status) { startHistory({ ...(await own(orgId, i.id)) }); i.history_status = 'running'; } // conectado antes desta versão
        return { configured: await configured(), flows_active: flows, instances };
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
      case 'import_history': { // puxa de novo as conversas recentes (roda em segundo plano)
        editor();
        const row = await own(orgId, body.id);
        if (row.status !== 'connected') fail('Conecte o número antes de importar as conversas.');
        if (row.history_status === 'running') return { ok: true, running: true };
        await pool.query(`update public.whatsapp_uazapi_instances set history_status = null where id = $1`, [row.id]);
        startHistory({ ...row, history_status: null });
        return { ok: true, running: true };
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
      if (s.status === 'connected') startHistory(row);
      return { status: 200 };
    }
    if (p.EventType !== 'messages' || !p.message) return { status: 200 };
    const m = p.message;
    if (m.isGroup || m.wasSentByApi || !m.messageid) return { status: 200 }; // grupos ficam de fora; o que a Kobly mandou já está guardado
    const from = contactPhone(m, p.chat);
    if (!from || from === digits(row.phone)) return { status: 200 };
    const leadId = await leadFor(row.organization_id, from, m.fromMe ? (p.chat && (p.chat.wa_contactName || p.chat.name)) : m.senderName);
    await saveAvatar(leadId, avatarOfChat(p.chat));
    if (m.fromMe) { await saveFromPhone(row, leadId, from, m); return { status: 200 }; } // a empresa respondeu pelo celular
    // "SAIR", "PARAR"...: o lead deixa de receber WhatsApp (mesma regra da API Oficial)
    if (OPT_OUT.test(String(m.text || '')) && from.length >= 10) {
      await pool.query(`update public.leads set whatsapp_opt_out = true where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2 and not whatsapp_opt_out`, [row.organization_id, from.slice(-10)]);
    }
    if (!onInbound) return { status: 200 };
    await onInbound({ orgId: row.organization_id, accountId: null, instanceId: row.id,
      message: { id: `uaz:${m.messageid}`, from, type: 'text', text: { body: messageText(m) }, timestamp: m.messageTimestamp, ...(adReplyOf(m) ? { referral: adReplyOf(m) } : {}) },
      contacts: m.senderName ? [{ profile: { name: m.senderName }, wa_id: from }] : [] });
    const kind = mediaKind(m);
    if (kind !== 'text') await pool.query(`update public.whatsapp_inbound_messages set msg_type = $2 where wa_message_id = $1`, [`uaz:${m.messageid}`, kind]);
    return { status: 200 };
  }

  async function connectedRow(orgId) {
    return (await pool.query(`select * from public.whatsapp_uazapi_instances where organization_id = $1 and status = 'connected' order by connected_at desc nulls last limit 1`, [orgId])).rows[0] || null;
  }
  const msgIdOf = (r) => r.messageid || r.id || (r.message && r.message.messageid) || null;
  // Envio de texto por uma instância conectada da empresa (sem janela de 24 h: é o WhatsApp comum)
  const uazId = (id) => (id && String(id).startsWith('uaz:') ? String(id).slice(4) : null);
  // opções do bloco do fluxo: responder a mensagem do lead, marcar como encaminhada, prévia de link
  const extras = ({ replyTo, forwarded, linkPreview }) => ({ ...(uazId(replyTo) ? { replyid: uazId(replyTo) } : {}), ...(forwarded ? { forward: true } : {}), ...(linkPreview !== undefined ? { linkPreview: !!linkPreview } : {}) });
  async function sendTextTo(orgId, { to, text, replyTo = null, forwarded = false, linkPreview }) {
    const row = secretKey ? await connectedRow(orgId) : null;
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const number = digits(to);
    if (number.length < 10) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDI + DDD + número.');
    const r = await call(await serverOf(row), '/send/text', { method: 'POST', token: tokenOf(row), body: { number, text: String(text || '').slice(0, 4096), ...extras({ replyTo, forwarded, linkPreview }) } });
    return { ok: true, id: msgIdOf(r), to: number, channel: 'uazapi', instanceId: row.id };
  }
  // Mídia por link público: POST /send/media { number, type, file, text, docName }
  async function sendMediaTo(orgId, { to, kind, url, caption, filename, ptt = true, viewOnce = false, replyTo = null, forwarded = false }) {
    const row = secretKey ? await connectedRow(orgId) : null;
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const number = digits(to);
    if (number.length < 10) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDI + DDD + número.');
    // áudio: "gravação de voz" (ptt, com o microfone verde) ou arquivo de áudio comum
    const type = { image: 'image', video: 'video', audio: ptt === false ? 'audio' : 'ptt', document: 'document' }[kind] || 'document';
    const body = { number, type, file: url, ...(caption && kind !== 'audio' ? { text: String(caption).slice(0, 1024) } : {}), ...(kind === 'document' && filename ? { docName: String(filename).slice(0, 120) } : {}),
      ...(viewOnce && kind !== 'document' ? { viewOnce: true } : {}), ...extras({ replyTo, forwarded }) };
    const r = await call(await serverOf(row), '/send/media', { method: 'POST', token: tokenOf(row), body });
    return { ok: true, id: msgIdOf(r), to: number, channel: 'uazapi', instanceId: row.id };
  }
  // Reage com emoji a uma mensagem do lead: POST /message/react { number, text, id }
  async function reactTo(orgId, { to, messageId, emoji }) {
    const row = secretKey ? await connectedRow(orgId) : null;
    if (!row || !uazId(messageId)) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    await call(await serverOf(row), '/message/react', { method: 'POST', token: tokenOf(row), body: { number: digits(to), text: String(emoji || '👍').slice(0, 8), id: uazId(messageId) } });
    return { ok: true };
  }
  // Apaga para todos uma mensagem enviada pela instância: POST /message/delete { id }
  async function deleteMessage(orgId, { instanceId, messageId }) {
    const row = await own(orgId, instanceId);
    if (row.status !== 'connected') throw new AuthError(409, 'not_connected', 'O WhatsApp desta mensagem está desconectado.');
    await call(await serverOf(row), '/message/delete', { method: 'POST', token: tokenOf(row), body: { id: String(messageId) } });
    return { ok: true };
  }
  const hasConnected = async (orgId) => !!secretKey && !!(await connectedRow(orgId));
  const rowFor = async (orgId, instanceId) => (instanceId ? await own(orgId, instanceId).catch(() => null) : null) || await connectedRow(orgId);
  // link (2 dias) do arquivo de uma mensagem; áudio sai em mp3 para tocar em qualquer navegador
  async function mediaLink(orgId, { instanceId, messageId }) {
    const row = secretKey ? await rowFor(orgId, instanceId) : null;
    if (!row) throw new AuthError(409, 'not_connected', 'Conecte o WhatsApp para abrir esta mídia.');
    const server = await serverOf(row), token = tokenOf(row);
    const id = String(messageId || '').replace(/^uaz:/, '');
    let r;
    try { r = await call(server, '/message/download', { method: 'POST', token, body: { id, generate_mp3: true } }); }
    catch { r = await call(server, '/message/download', { method: 'POST', token, body: { id: `${digits(row.phone)}:${id}`, generate_mp3: true } }); }
    if (!r.fileURL) throw new AuthError(404, 'media_gone', 'Esta mídia não está mais disponível no WhatsApp.');
    return { url: r.fileURL, mimetype: r.mimetype || null };
  }
  // foto do contato (link temporário do WhatsApp; vazio quando a pessoa não tem foto ou esconde)
  async function avatarOf(orgId, phone) {
    const row = secretKey ? await connectedRow(orgId) : null;
    if (!row) return null;
    const r = await call(await serverOf(row), '/chat/avatar', { method: 'POST', token: tokenOf(row), body: { number: digits(phone), preview: true } }).catch(() => ({}));
    return /^https:\/\//.test(String(r.url || '')) ? String(r.url).slice(0, 1000) : '';
  }
  // ligação muda: o telefone da pessoa toca por alguns segundos (chamar a atenção)
  async function ringCall(orgId, phone) {
    const row = secretKey ? await connectedRow(orgId) : null;
    if (!row) throw new AuthError(409, 'not_connected', 'Ligação só funciona com o WhatsApp por QR Code conectado.');
    await call(await serverOf(row), '/call/make', { method: 'POST', token: tokenOf(row), body: { number: digits(phone), call_duration: 20 } });
    return { ok: true };
  }
  return { handle, handleServers, receiveWebhook, sendTextTo, sendMediaTo, reactTo, deleteMessage, hasConnected, configured, mediaLink, avatarOf, ringCall };
}
