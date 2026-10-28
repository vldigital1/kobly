// Rota POST /functions/v1/meta-channels: Instagram Direct e Messenger da empresa.
// "Conectar com Facebook" (janelinha): o login volta em GET /oauth/meta/callback (o mesmo endereço do Facebook Ads;
// o "state" diz que é deste módulo), o token de longa duração fica 30 min em meta_channel_oauth e a empresa escolhe
// as páginas. Para cada página: Messenger (id da página) e, se houver, o Instagram profissional ligado a ela.
// O token da página (não expira) fica cifrado; a Kobly assina a página no app (subscribed_apps).
// Mensagens chegam em POST /webhooks/meta-messaging (assinadas com o segredo do app) e entram na mesma caixa do
// Chat ao vivo e nos mesmos fluxos do WhatsApp. Envio: POST /me/messages com o token da página.
// Quem conversa por aqui não tem telefone: o lead guarda ig_user_id / fb_psid e o endereço de envio é "ig:<id>" / "fb:<id>".
//   oauth_status | oauth_start | oauth_pages | connect | list | remove
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

const SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,instagram_basic,instagram_manage_messages,business_management';
const STATE_TTL_MS = 15 * 60_000;
const SAFE = 'id, kind, page_id, external_id, name, username, picture_url, status, last_error, created_at';
const KIND_OF = { ig: 'instagram', fb: 'messenger' };

// "ig:123" / "fb:456" → { kind, id }
export function channelAddress(to) {
  const m = /^(ig|fb):([0-9A-Za-z_-]{3,64})$/.exec(String(to || ''));
  return m ? { kind: KIND_OF[m[1]], id: m[2] } : null;
}
export const addressOf = (lead) => (lead && lead.telefone) || (lead && lead.ig_user_id ? `ig:${lead.ig_user_id}` : lead && lead.fb_psid ? `fb:${lead.fb_psid}` : null);
const kindOfAttachment = (t) => ({ image: 'image', video: 'video', audio: 'audio', file: 'document', sticker: 'sticker', animated_image_share: 'image' }[t] || 'text');

export function createMetaChannels({ pool, secretKey, fetchImpl = globalThis.fetch, graphBase = 'https://graph.facebook.com/v26.0', appId = '', appSecret = '',
  configId = '', verifyToken = '', publicBaseUrl = '', siteUrl = '', onInbound = null }) {
  const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };
  const oauthOn = () => !!(appId && appSecret && publicBaseUrl && secretKey);
  const redirectUri = () => `${publicBaseUrl}/oauth/meta/callback`;
  const ver = (/\/(v[0-9.]+)\/?$/.exec(graphBase) || [null, 'v26.0'])[1];

  async function graph(token, path, query = {}, method = 'GET', json = null) {
    const url = new URL(graphBase.replace(/\/$/, '') + path);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let body;
    if (json) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
    else if (method === 'POST') { body = new URLSearchParams(query).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (method === 'GET' || json) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res;
    try { res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(20000) }); }
    catch { throw new AuthError(502, 'meta_unreachable', 'O Facebook não respondeu agora.'); }
    const j = await res.json().catch(() => null);
    if (!res.ok || (j && j.error)) {
      const e = (j && j.error) || {};
      if (e.code === 190) throw new AuthError(400, 'meta_bad_token', 'O acesso à página expirou ou foi removido. Conecte de novo.');
      if (e.code === 10 && e.error_subcode === 2018278) throw new AuthError(409, 'window_closed', 'Passou de 24 h desde a última mensagem desta pessoa: o Instagram/Messenger só deixa responder dentro desse prazo.');
      if (e.code === 551 || e.error_subcode === 2018001) throw new AuthError(409, 'unavailable', 'Esta pessoa não pode receber mensagens agora.');
      throw new AuthError(502, 'meta_error', `Facebook: ${e.message || `HTTP ${res.status}`}`);
    }
    return j || {};
  }

  const sign = (p) => createHmac('sha256', secretKey).update(`meta-msg:${p}`).digest('base64url');
  function makeState(orgId) {
    const p = Buffer.from(JSON.stringify({ k: 'msg', o: orgId, e: Date.now() + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
    return `msg.${p}.${sign(p)}`;
  }
  function readState(state) {
    const [tag, p, sig] = String(state || '').split('.');
    if (tag !== 'msg' || !p || !sig || !secretKey) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(p));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try { const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return j.e > Date.now() && typeof j.o === 'string' ? j : null; } catch { return null; }
  }
  const ownsState = (state) => String(state || '').startsWith('msg.');

  // GET /oauth/meta/callback com state "msg." — a página avisa a janela da Kobly e fecha sozinha
  async function oauthCallback(q) {
    const page = (ok, msg) => {
      const data = JSON.stringify({ kobly: 'meta-msg', ok, message: msg });
      return `<!doctype html><meta charset="utf-8"><title>Kobly</title><body style="font-family:system-ui;background:#0d0d0d;color:#f6f6f6;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:340px;padding:16px"><div style="width:48px;height:48px;border-radius:12px;background:#ff6201;margin:0 auto 16px"></div><p>${msg}</p><p style="opacity:.6;font-size:13px">Pode fechar esta janela.</p></div>
<script>try{window.opener&&window.opener.postMessage(${data},"*")}catch(e){}setTimeout(function(){window.close()},${ok ? 800 : 5000})</script></body>`;
    };
    const st = readState(q.state);
    if (!st) return page(false, 'Este link de login expirou. Volte para a Kobly e clique em "Conectar" de novo.');
    if (q.error || !q.code) return page(false, 'Você cancelou o login do Facebook. Nada foi conectado.');
    try {
      const short = await graph(null, '/oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri(), code: String(q.code) });
      const long = await graph(null, '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }).catch(() => ({}));
      const token = long.access_token || short.access_token;
      if (!token) throw new Error('sem token');
      const me = await graph(token, '/me', { fields: 'name' }).catch(() => ({}));
      await pool.query(`insert into public.meta_channel_oauth (organization_id, token_enc, user_name, expires_at) values ($1,$2,$3, now() + interval '30 minutes')
        on conflict (organization_id) do update set token_enc = excluded.token_enc, user_name = excluded.user_name, expires_at = excluded.expires_at, created_at = now()`,
        [st.o, encrypt(token, secretKey), me.name || null]);
      return page(true, 'Facebook conectado! Voltando para a Kobly…');
    } catch {
      return page(false, 'O Facebook não confirmou o login. Tente de novo em alguns instantes.');
    }
  }

  async function pendingToken(orgId) {
    const r = (await pool.query(`select token_enc, user_name from public.meta_channel_oauth where organization_id = $1 and expires_at > now()`, [orgId])).rows[0];
    if (!r) throw new AuthError(410, 'meta_oauth_expired', 'O login com o Facebook expirou. Clique em "Conectar" de novo.');
    return { token: decrypt(r.token_enc, secretKey), userName: r.user_name };
  }
  async function listPages(token) {
    const j = await graph(token, '/me/accounts', { fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url,name}', limit: '100' });
    return (j.data || []).map((p) => ({ id: p.id, name: p.name, token: p.access_token, picture: p.picture && p.picture.data && p.picture.data.url,
      instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username, name: p.instagram_business_account.name, picture: p.instagram_business_account.profile_picture_url } : null }));
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar conexões.'); };
    switch (body.action) {
      case 'oauth_status': return { enabled: oauthOn() };
      case 'oauth_start': {
        editor();
        if (!oauthOn()) throw new AuthError(503, 'meta_oauth_off', 'O Instagram e o Messenger ainda não foram ativados no servidor da Kobly.');
        const u = new URL(`https://www.facebook.com/${ver}/dialog/oauth`);
        u.searchParams.set('client_id', appId); u.searchParams.set('redirect_uri', redirectUri());
        u.searchParams.set('state', makeState(orgId)); u.searchParams.set('response_type', 'code');
        if (configId) u.searchParams.set('config_id', configId); else u.searchParams.set('scope', SCOPES);
        return { url: u.toString() };
      }
      case 'oauth_pages': {
        editor();
        const p = await pendingToken(orgId);
        const pages = await listPages(p.token);
        return { user_name: p.userName, pages: pages.map(({ token, ...x }) => x) };
      }
      case 'connect': { // página escolhida → Messenger e (se marcado) o Instagram ligado a ela
        editor();
        const ids = (Array.isArray(body.page_ids) ? body.page_ids : []).map(String).filter((x) => /^[0-9]{3,25}$/.test(x));
        if (!ids.length) fail('Escolha pelo menos uma página.');
        const want = new Set(Array.isArray(body.kinds) && body.kinds.length ? body.kinds : ['messenger', 'instagram']);
        const p = await pendingToken(orgId);
        const pages = (await listPages(p.token)).filter((x) => ids.includes(x.id));
        if (!pages.length) fail('Essas páginas não aparecem mais nesta conta do Facebook.');
        const saved = [];
        for (const pg of pages) {
          if (!pg.token) continue;
          await graph(pg.token, `/${pg.id}/subscribed_apps`, { subscribed_fields: 'messages,messaging_postbacks,message_echoes' }, 'POST');
          const save = async (kind, ext, name, username, pic) => {
            const r = await pool.query(`insert into public.meta_channels (organization_id, kind, page_id, external_id, name, username, picture_url, token_enc, status, last_error)
              values ($1,$2,$3,$4,$5,$6,$7,$8,'connected',null)
              on conflict (kind, external_id) do update set organization_id = excluded.organization_id, page_id = excluded.page_id, name = excluded.name, username = excluded.username,
                picture_url = excluded.picture_url, token_enc = excluded.token_enc, status = 'connected', last_error = null returning ${SAFE}`,
              [orgId, kind, pg.id, ext, name, username, pic || null, encrypt(pg.token, secretKey)]);
            saved.push(r.rows[0]);
          };
          if (want.has('messenger')) await save('messenger', pg.id, pg.name, null, pg.picture);
          if (want.has('instagram') && pg.instagram) await save('instagram', pg.instagram.id, pg.instagram.name || pg.name, pg.instagram.username, pg.instagram.picture);
        }
        await pool.query(`delete from public.meta_channel_oauth where organization_id = $1`, [orgId]);
        return { channels: saved };
      }
      case 'list': return { enabled: oauthOn(), channels: (await pool.query(`select ${SAFE} from public.meta_channels where organization_id = $1 order by kind, created_at`, [orgId])).rows };
      case 'remove': {
        editor();
        const r = await pool.query(`delete from public.meta_channels where id::text = $1 and organization_id = $2 returning id`, [String(body.id || ''), orgId]);
        if (!r.rowCount) throw new AuthError(404, 'not_found', 'Conexão não encontrada.');
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  // ---- Webhook ---------------------------------------------------------------------------
  function verify(q) {
    if (q['hub.mode'] === 'subscribe' && verifyToken && q['hub.verify_token'] === verifyToken) return { status: 200, body: String(q['hub.challenge'] || '') };
    return { status: 403, body: 'forbidden' };
  }
  function signed(raw, header) {
    if (!appSecret) return false;
    const want = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
    const got = String(header || '');
    return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }
  // contato: acha pelo id do Instagram/Messenger; senão cria (com nome e foto do perfil)
  async function leadFor(ch, userId) {
    const col = ch.kind === 'instagram' ? 'ig_user_id' : 'fb_psid';
    const found = (await pool.query(`select id from public.leads where organization_id = $1 and ${col} = $2`, [ch.organization_id, userId])).rows[0];
    if (found) return found.id;
    const token = decrypt(ch.token_enc, secretKey);
    const prof = await graph(token, `/${userId}`, { fields: ch.kind === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic' }).catch(() => ({}));
    const nome = ch.kind === 'instagram' ? (prof.name || (prof.username ? `@${prof.username}` : null)) : [prof.first_name, prof.last_name].filter(Boolean).join(' ') || null;
    const r = await pool.query(`insert into public.leads (organization_id, nome, ${col}, ig_username, chat_channel, utm, avatar_url, avatar_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7, now()) on conflict (organization_id, ${col}) where ${col} is not null do update set chat_channel = excluded.chat_channel returning id`,
      [ch.organization_id, nome, userId, prof.username || null, ch.kind, JSON.stringify({ utm_source: ch.kind }), /^https:\/\//.test(String(prof.profile_pic || '')) ? prof.profile_pic : null]);
    return r.rows[0].id;
  }
  async function receiveWebhook(raw, sigHeader) {
    if (!signed(raw, sigHeader)) return { status: 401 };
    let p; try { p = JSON.parse(raw.toString('utf8')); } catch { return { status: 400 }; }
    if (p.object !== 'page' && p.object !== 'instagram') return { status: 200 };
    const kind = p.object === 'instagram' ? 'instagram' : 'messenger';
    for (const entry of p.entry || []) {
      const ch = (await pool.query(`select * from public.meta_channels where kind = $1 and external_id = $2`, [kind, String(entry.id)])).rows[0];
      if (!ch) continue;
      for (const ev of entry.messaging || []) {
        const m = ev.message;
        if (!m || !m.mid || m.is_deleted) continue;
        const echo = !!m.is_echo;
        const other = String(echo ? (ev.recipient && ev.recipient.id) : (ev.sender && ev.sender.id) || '');
        if (!other || other === ch.external_id) continue;
        const leadId = await leadFor(ch, other);
        const att = (m.attachments || [])[0];
        const tipo = att ? kindOfAttachment(att.type) : 'text';
        const url = att && att.payload && /^https:\/\//.test(String(att.payload.url || '')) ? att.payload.url : null;
        const text = String(m.text || '') || (att ? `[${{ image: 'imagem', video: 'vídeo', audio: 'áudio', document: 'arquivo', sticker: 'figurinha' }[tipo] || 'mensagem'}]` : '');
        const at = ev.timestamp ? new Date(Number(ev.timestamp)) : new Date();
        if (echo) { // a empresa respondeu pelo app do Instagram/Facebook (ou a própria Kobly: já está guardada)
          await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, wa_message_id, channel, created_at, msg_type, media_url, media_at, meta_channel_id)
            select $1,$2,$3,'celular',$4,$5,$6,$7,$8,$9,$10,$11 where not exists (select 1 from public.whatsapp_outbound_messages where organization_id = $1 and wa_message_id = $5)`,
            [ch.organization_id, leadId, `${kind === 'instagram' ? 'ig' : 'fb'}:${other}`, text, m.mid, kind, at, tipo, url, url ? new Date() : null, ch.id]);
          continue;
        }
        const ins = await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, meta_channel_id, wa_message_id, from_phone, lead_id, msg_type, body, payload, received_at, media_url, media_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) on conflict (wa_message_id) do nothing returning id`,
          [ch.organization_id, ch.id, m.mid, `${kind === 'instagram' ? 'ig' : 'fb'}:${other}`, leadId, tipo, text, JSON.stringify({ channel: kind }), at, url, url ? new Date() : null]);
        if (!ins.rowCount) continue; // reentrega
        await pool.query(`update public.leads set whatsapp_last_inbound_at = $2, chat_channel = $3, chat_archived_at = case when chat_archived_at is not null and chat_archived_at < $2 then null else chat_archived_at end where id = $1`, [leadId, at, kind]);
        if (onInbound) await onInbound({ orgId: ch.organization_id, leadId, text, messageId: m.mid }).catch((e) => console.error('[meta-msg] fluxo:', e.message));
      }
    }
    return { status: 200 };
  }

  // ---- Envio ------------------------------------------------------------------------------
  async function channelFor(orgId, kind) {
    const ch = (await pool.query(`select * from public.meta_channels where organization_id = $1 and kind = $2 and status = 'connected' order by created_at limit 1`, [orgId, kind])).rows[0];
    if (!ch) throw new AuthError(409, 'not_connected', kind === 'instagram' ? 'Conecte o Instagram da empresa em Conexões.' : 'Conecte a página do Facebook em Conexões.');
    return ch;
  }
  // o canal certo é o da última mensagem que a pessoa mandou (a empresa pode ter mais de uma página)
  async function channelForLead(orgId, kind, userId) {
    const col = kind === 'instagram' ? 'ig_user_id' : 'fb_psid';
    const r = (await pool.query(`select c.* from public.whatsapp_inbound_messages m join public.leads l on l.id = m.lead_id join public.meta_channels c on c.id = m.meta_channel_id
      where l.organization_id = $1 and l.${col} = $2 and c.status = 'connected' order by m.received_at desc limit 1`, [orgId, userId])).rows[0];
    return r || channelFor(orgId, kind);
  }
  async function deliver(orgId, to, message) {
    const a = channelAddress(to);
    if (!a) throw new AuthError(422, 'bad_phone', 'Destino inválido.');
    const ch = await channelForLead(orgId, a.kind, a.id);
    const r = await graph(decrypt(ch.token_enc, secretKey), '/me/messages', {}, 'POST', { recipient: { id: a.id }, messaging_type: 'RESPONSE', message });
    return { ok: true, id: r.message_id || null, to, channel: a.kind, metaChannelId: ch.id };
  }
  const sendTextTo = (orgId, { to, text }) => deliver(orgId, to, { text: String(text || '').slice(0, 1000) });
  const sendMediaTo = (orgId, { to, kind, url }) => deliver(orgId, to, { attachment: { type: { image: 'image', video: 'video', audio: 'audio' }[kind] || 'file', payload: { url, is_reusable: false } } });
  // botões do fluxo viram "respostas rápidas" (até 13, 20 letras cada)
  function sendInteractiveTo(orgId, { to, interactive }) {
    const i = interactive || {};
    const text = String((i.body && i.body.text) || '').slice(0, 1000) || '.';
    const opts = i.type === 'button' ? ((i.action && i.action.buttons) || []).map((b) => b.reply && b.reply.title)
      : ((i.action && i.action.sections) || []).flatMap((s) => (s.rows || []).map((r) => r.title));
    const quick = opts.filter(Boolean).slice(0, 13).map((t) => ({ content_type: 'text', title: String(t).slice(0, 20), payload: String(t).slice(0, 1000) }));
    return deliver(orgId, to, quick.length ? { text, quick_replies: quick } : { text });
  }
  const hasChannel = async (orgId) => (await pool.query(`select 1 from public.meta_channels where organization_id = $1 and status = 'connected' limit 1`, [orgId])).rowCount > 0;

  return { handle, oauthCallback, ownsState, verify, receiveWebhook, sendTextTo, sendMediaTo, sendInteractiveTo, hasChannel };
}
