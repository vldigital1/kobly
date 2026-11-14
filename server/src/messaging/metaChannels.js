// Rota POST /functions/v1/meta-channels: Instagram Direct e Messenger da empresa.
// Dois jeitos de conectar:
//  * "Entrar com Instagram" (login direto, sem página do Facebook): volta em GET /oauth/instagram/callback, troca o código pelo
//    token de 60 dias (renovado sozinho antes de vencer) e já conecta a conta. API em graph.instagram.com.
//  * "Conectar com Facebook" (página + Instagram ligado a ela, e Messenger): volta em GET /oauth/meta/callback (o mesmo do
//    Facebook Ads; o "state" diz que é deste módulo), o token fica 30 min em meta_channel_oauth e a empresa escolhe as páginas.
// Mensagens, comentários e stories chegam em POST /webhooks/meta-messaging (assinados com o segredo do app) e entram na
// mesma caixa do Chat ao vivo e nos mesmos fluxos do WhatsApp. Envio: POST /me/messages.
// Quem conversa por aqui não tem telefone: o lead guarda ig_user_id / fb_psid e o endereço de envio é "ig:<id>" / "fb:<id>".
// Comentário num post: a 1ª mensagem do fluxo sai como "resposta privada" ao comentário (o Instagram deixa uma por
// comentário, em até 7 dias); depois que a pessoa responde no Direct, a conversa segue normal (24 h).
//   oauth_status | oauth_start | ig_oauth_start | oauth_pages | connect | list | remove | ig_media
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

const SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,instagram_basic,instagram_manage_messages,instagram_manage_comments,business_management';
export const IG_SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
const IG_FIELDS = 'messages,messaging_postbacks,comments';
const STATE_TTL_MS = 15 * 60_000;
const DAY = 86_400_000;
const SAFE = 'id, kind, auth, page_id, external_id, name, username, picture_url, status, last_error, created_at';
const KIND_OF = { ig: 'instagram', fb: 'messenger' };

// "ig:123" / "fb:456" → { kind, id }
export function channelAddress(to) {
  const m = /^(ig|fb):([0-9A-Za-z_-]{3,64})$/.exec(String(to || ''));
  return m ? { kind: KIND_OF[m[1]], id: m[2] } : null;
}
export const addressOf = (lead) => (lead && lead.telefone) || (lead && lead.ig_user_id ? `ig:${lead.ig_user_id}` : lead && lead.fb_psid ? `fb:${lead.fb_psid}` : null);
const kindOfAttachment = (t) => ({ image: 'image', video: 'video', audio: 'audio', file: 'document', sticker: 'sticker', animated_image_share: 'image', story_mention: 'image', ig_reel: 'video', reel: 'video' }[t] || 'text');
const httpsOr = (u) => (/^https:\/\//.test(String(u || '')) ? String(u) : null);

export function createMetaChannels({ pool, secretKey, fetchImpl = globalThis.fetch, graphBase = 'https://graph.facebook.com/v26.0', appId = '', appSecret = '',
  configId = '', verifyToken = '', publicBaseUrl = '', siteUrl = '', onInbound = null, onComment = null,
  igAppId = '', igAppSecret = '', igGraphBase = 'https://graph.instagram.com/v26.0', igApiBase = 'https://api.instagram.com', now = () => new Date() }) {
  const fail = (m) => { throw new AuthError(422, 'validation_failed', m); };
  const oauthOn = () => !!(appId && appSecret && publicBaseUrl && secretKey);
  const igOn = () => !!(igAppId && igAppSecret && publicBaseUrl && secretKey);
  const redirectUri = () => `${publicBaseUrl}/oauth/meta/callback`;
  const igRedirectUri = () => `${publicBaseUrl}/oauth/instagram/callback`;
  const ver = (/\/(v[0-9.]+)\/?$/.exec(graphBase) || [null, 'v26.0'])[1];
  const igBaseNoVer = igGraphBase.replace(/\/v[0-9.]+\/?$/, '');

  async function graph(token, path, query = {}, method = 'GET', json = null, base = graphBase) {
    const url = new URL(base.replace(/\/$/, '') + path);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let body;
    if (json) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
    else if (method === 'POST') { body = new URLSearchParams(query).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (method === 'GET' || json) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res;
    try { res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(20000) }); }
    catch { throw new AuthError(502, 'meta_unreachable', 'O Instagram/Facebook não respondeu agora.'); }
    const j = await res.json().catch(() => null);
    if (!res.ok || (j && j.error)) {
      const e = (j && j.error) || {};
      if (e.code === 190) throw new AuthError(400, 'meta_bad_token', 'O acesso à conta expirou ou foi removido. Conecte de novo.');
      if (e.code === 10 && e.error_subcode === 2018278) throw new AuthError(409, 'window_closed', 'Passou de 24 h desde a última mensagem desta pessoa: o Instagram/Messenger só deixa responder dentro desse prazo.');
      if (e.code === 551 || e.error_subcode === 2018001) throw new AuthError(409, 'unavailable', 'Esta pessoa não pode receber mensagens agora.');
      throw new AuthError(502, 'meta_error', `Instagram/Facebook: ${e.message || (j && j.error_message) || `HTTP ${res.status}`}`);
    }
    return j || {};
  }
  const baseOf = (ch) => (ch.auth === 'ig_login' ? igGraphBase : graphBase);
  // token do canal; o do login do Instagram vale 60 dias e é renovado quando faltam menos de 10
  async function tokenOf(ch) {
    const token = decrypt(ch.token_enc, secretKey);
    if (ch.auth !== 'ig_login' || !ch.token_expires_at || new Date(ch.token_expires_at).getTime() - now().getTime() > 10 * DAY) return token;
    try {
      const r = await graph(null, '/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: token }, 'GET', null, igBaseNoVer);
      if (r.access_token) {
        await pool.query(`update public.meta_channels set token_enc = $2, token_expires_at = $3 where id = $1`,
          [ch.id, encrypt(r.access_token, secretKey), new Date(now().getTime() + (Number(r.expires_in) || 60 * 86400) * 1000)]);
        return r.access_token;
      }
    } catch (e) { console.error('[instagram] renovar token:', e.message); }
    return token;
  }
  const api = async (ch, path, query = {}, method = 'GET', json = null) => graph(await tokenOf(ch), path, query, method, json, baseOf(ch));

  const sign = (p) => createHmac('sha256', secretKey).update(`meta-msg:${p}`).digest('base64url');
  function makeState(orgId, tag = 'msg') {
    const p = Buffer.from(JSON.stringify({ k: tag, o: orgId, e: Date.now() + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
    return `${tag}.${p}.${sign(p)}`;
  }
  function readState(state, want = 'msg') {
    const [tag, p, sig] = String(state || '').split('.');
    if (tag !== want || !p || !sig || !secretKey) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(p));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try { const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return j.e > Date.now() && typeof j.o === 'string' && j.k === want ? j : null; } catch { return null; }
  }
  const ownsState = (state) => String(state || '').startsWith('msg.');

  // página que avisa a janela da Kobly e fecha sozinha
  const closePage = (ok, msg) => {
    const data = JSON.stringify({ kobly: 'meta-msg', ok, message: msg });
    return `<!doctype html><meta charset="utf-8"><title>Kobly</title><body style="font-family:system-ui;background:#0d0d0d;color:#f6f6f6;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:340px;padding:16px"><div style="width:48px;height:48px;border-radius:12px;background:#ff6201;margin:0 auto 16px"></div><p>${msg}</p><p style="opacity:.6;font-size:13px">Pode fechar esta janela.</p></div>
<script>try{window.opener&&window.opener.postMessage(${data},"*")}catch(e){}setTimeout(function(){window.close()},${ok ? 800 : 5000})</script></body>`;
  };

  // GET /oauth/meta/callback com state "msg."
  async function oauthCallback(q) {
    const st = readState(q.state);
    if (!st) return closePage(false, 'Este link de login expirou. Volte para a Kobly e clique em "Conectar" de novo.');
    if (q.error || !q.code) return closePage(false, 'Você cancelou o login do Facebook. Nada foi conectado.');
    try {
      const short = await graph(null, '/oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri(), code: String(q.code) });
      const long = await graph(null, '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }).catch(() => ({}));
      const token = long.access_token || short.access_token;
      if (!token) throw new Error('sem token');
      const me = await graph(token, '/me', { fields: 'name' }).catch(() => ({}));
      await pool.query(`insert into public.meta_channel_oauth (organization_id, token_enc, user_name, expires_at) values ($1,$2,$3, now() + interval '30 minutes')
        on conflict (organization_id) do update set token_enc = excluded.token_enc, user_name = excluded.user_name, expires_at = excluded.expires_at, created_at = now()`,
        [st.o, encrypt(token, secretKey), me.name || null]);
      return closePage(true, 'Facebook conectado! Voltando para a Kobly…');
    } catch {
      return closePage(false, 'O Facebook não confirmou o login. Tente de novo em alguns instantes.');
    }
  }

  // GET /oauth/instagram/callback: login direto do Instagram → token de 60 dias → conta conectada e assinada
  async function igOauthCallback(q) {
    const st = readState(q.state, 'igl');
    if (!st) return closePage(false, 'Este link de login expirou. Volte para a Kobly e clique em "Entrar com Instagram" de novo.');
    if (q.error || !q.code) return closePage(false, 'Você cancelou o login do Instagram. Nada foi conectado.');
    try {
      const code = String(q.code).replace(/#_$/, '');
      const t = await graph(null, '/oauth/access_token', { client_id: igAppId, client_secret: igAppSecret, grant_type: 'authorization_code', redirect_uri: igRedirectUri(), code }, 'POST', null, igApiBase);
      const short = t.access_token || (t.data && t.data[0] && t.data[0].access_token);
      if (!short) throw new Error('sem token');
      const long = await graph(null, '/access_token', { grant_type: 'ig_exchange_token', client_secret: igAppSecret, access_token: short }, 'GET', null, igBaseNoVer).catch(() => ({}));
      const token = long.access_token || short;
      const expires = new Date(now().getTime() + (Number(long.expires_in) || (long.access_token ? 60 * 86400 : 3600)) * 1000);
      const me = await graph(token, '/me', { fields: 'user_id,username,name,profile_picture_url,account_type' }, 'GET', null, igGraphBase);
      const igId = String(me.user_id || me.id || '');
      if (!/^[0-9]{3,25}$/.test(igId)) throw new Error('conta sem id');
      await graph(token, '/me/subscribed_apps', { subscribed_fields: IG_FIELDS }, 'POST', null, igGraphBase);
      await pool.query(`insert into public.meta_channels (organization_id, kind, auth, page_id, external_id, name, username, picture_url, token_enc, token_expires_at, status, last_error)
        values ($1,'instagram','ig_login',null,$2,$3,$4,$5,$6,$7,'connected',null)
        on conflict (kind, external_id) do update set organization_id = excluded.organization_id, auth = 'ig_login', page_id = null, name = excluded.name, username = excluded.username,
          picture_url = excluded.picture_url, token_enc = excluded.token_enc, token_expires_at = excluded.token_expires_at, status = 'connected', last_error = null`,
        [st.o, igId, me.name || me.username || null, me.username || null, httpsOr(me.profile_picture_url), encrypt(token, secretKey), expires]);
      return closePage(true, `Instagram @${me.username || ''} conectado! Voltando para a Kobly…`);
    } catch (e) {
      console.error('[instagram] login:', e.message);
      return closePage(false, 'O Instagram não confirmou o login. Confira se a conta é profissional (Empresa ou Criador) e tente de novo.');
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
  async function igChannel(orgId, id) {
    const q = id ? [`select * from public.meta_channels where organization_id = $1 and kind = 'instagram' and id::text = $2`, [orgId, String(id)]]
      : [`select * from public.meta_channels where organization_id = $1 and kind = 'instagram' and status = 'connected' order by created_at limit 1`, [orgId]];
    const ch = (await pool.query(...q)).rows[0];
    if (!ch) throw new AuthError(409, 'not_connected', 'Conecte o Instagram da empresa em Conexões.');
    return ch;
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar conexões.'); };
    switch (body.action) {
      case 'oauth_status': return { enabled: oauthOn(), ig_enabled: igOn() };
      case 'oauth_start': {
        editor();
        if (!oauthOn()) throw new AuthError(503, 'meta_oauth_off', 'O Instagram e o Messenger ainda não foram ativados no servidor da Kobly.');
        const u = new URL(`https://www.facebook.com/${ver}/dialog/oauth`);
        u.searchParams.set('client_id', appId); u.searchParams.set('redirect_uri', redirectUri());
        u.searchParams.set('state', makeState(orgId)); u.searchParams.set('response_type', 'code');
        if (configId) u.searchParams.set('config_id', configId); else u.searchParams.set('scope', SCOPES);
        return { url: u.toString() };
      }
      case 'ig_oauth_start': {
        editor();
        if (!igOn()) throw new AuthError(503, 'ig_oauth_off', 'O login do Instagram ainda não foi ativado no servidor da Kobly.');
        const u = new URL('https://www.instagram.com/oauth/authorize');
        u.searchParams.set('client_id', igAppId); u.searchParams.set('redirect_uri', igRedirectUri());
        u.searchParams.set('response_type', 'code'); u.searchParams.set('scope', IG_SCOPES);
        u.searchParams.set('state', makeState(orgId, 'igl')); u.searchParams.set('enable_fb_login', '0'); u.searchParams.set('force_reauth', 'true');
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
            const r = await pool.query(`insert into public.meta_channels (organization_id, kind, auth, page_id, external_id, name, username, picture_url, token_enc, status, last_error)
              values ($1,$2,'page',$3,$4,$5,$6,$7,$8,'connected',null)
              on conflict (kind, external_id) do update set organization_id = excluded.organization_id, auth = 'page', page_id = excluded.page_id, name = excluded.name, username = excluded.username,
                picture_url = excluded.picture_url, token_enc = excluded.token_enc, token_expires_at = null, status = 'connected', last_error = null returning ${SAFE}`,
              [orgId, kind, pg.id, ext, name, username, pic || null, encrypt(pg.token, secretKey)]);
            saved.push(r.rows[0]);
          };
          if (want.has('messenger')) await save('messenger', pg.id, pg.name, null, pg.picture);
          if (want.has('instagram') && pg.instagram) await save('instagram', pg.instagram.id, pg.instagram.name || pg.name, pg.instagram.username, pg.instagram.picture);
        }
        await pool.query(`delete from public.meta_channel_oauth where organization_id = $1`, [orgId]);
        return { channels: saved };
      }
      case 'list': return { enabled: oauthOn(), ig_enabled: igOn(), channels: (await pool.query(`select ${SAFE} from public.meta_channels where organization_id = $1 order by kind, created_at`, [orgId])).rows };
      case 'remove': {
        editor();
        const r = await pool.query(`delete from public.meta_channels where id::text = $1 and organization_id = $2 returning id`, [String(body.id || ''), orgId]);
        if (!r.rowCount) throw new AuthError(404, 'not_found', 'Conexão não encontrada.');
        return { ok: true };
      }
      case 'ig_media': { // posts e Reels do Instagram conectado (para escolher no gatilho "Comentário")
        const ch = await igChannel(orgId, body.channel_id);
        const j = await api(ch, `/${ch.auth === 'ig_login' ? 'me' : ch.external_id}/media`, { fields: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp', limit: '30' });
        return { username: ch.username, media: (j.data || []).map((m) => ({ id: String(m.id), caption: String(m.caption || '').slice(0, 300), type: m.media_product_type === 'REELS' ? 'reel' : String(m.media_type || '').toLowerCase(),
          thumb: httpsOr(m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url) || httpsOr(m.thumbnail_url), link: httpsOr(m.permalink), at: m.timestamp || null })) };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  // ---- Webhook ---------------------------------------------------------------------------
  function verify(q) {
    if (q['hub.mode'] === 'subscribe' && verifyToken && q['hub.verify_token'] === verifyToken) return { status: 200, body: String(q['hub.challenge'] || '') };
    return { status: 403, body: 'forbidden' };
  }
  // assinado com o segredo do app do Facebook OU com o do app do Instagram (login direto)
  function signed(raw, header) {
    const got = String(header || '');
    return [appSecret, igAppSecret].filter(Boolean).some((s) => {
      const want = `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`;
      return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
    });
  }
  // contato: acha pelo id do Instagram/Messenger (ou pelo @ do Instagram); senão cria com nome e foto do perfil
  async function leadFor(ch, userId, username = null) {
    const col = ch.kind === 'instagram' ? 'ig_user_id' : 'fb_psid';
    const found = (await pool.query(`select id from public.leads where organization_id = $1 and ${col} = $2`, [ch.organization_id, userId])).rows[0];
    if (found) return found.id;
    if (username && ch.kind === 'instagram') {
      const byName = (await pool.query(`update public.leads set ig_user_id = $3 where id = (select id from public.leads where organization_id = $1 and lower(ig_username) = lower($2) and ig_user_id is distinct from $3 limit 1)
        and not exists (select 1 from public.leads where organization_id = $1 and ig_user_id = $3) returning id`, [ch.organization_id, username, userId]).catch(() => ({ rows: [] }))).rows[0];
      if (byName) return byName.id;
    }
    const prof = await api(ch, `/${userId}`, { fields: ch.kind === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic' }).catch(() => ({}));
    const uname = prof.username || username || null;
    const nome = ch.kind === 'instagram' ? (prof.name || (uname ? `@${uname}` : null)) : [prof.first_name, prof.last_name].filter(Boolean).join(' ') || null;
    const r = await pool.query(`insert into public.leads (organization_id, nome, ${col}, ig_username, chat_channel, utm, avatar_url, avatar_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7, now()) on conflict (organization_id, ${col}) where ${col} is not null do update set chat_channel = coalesce(public.leads.chat_channel, excluded.chat_channel) returning id`,
      [ch.organization_id, nome, userId, uname, ch.kind, JSON.stringify({ utm_source: ch.kind }), httpsOr(prof.profile_pic)]);
    return r.rows[0].id;
  }

  // comentário num post/Reels: guarda uma vez, liga ao contato, deixa a resposta privada pendente e chama os fluxos
  async function receiveComment(ch, v) {
    const from = v.from || {};
    const fromId = String(from.id || '');
    if (!v.id || !fromId || fromId === ch.external_id || (from.username && ch.username && String(from.username).toLowerCase() === String(ch.username).toLowerCase())) return;
    const ev = await pool.query(`insert into public.ig_comment_events (organization_id, meta_channel_id, comment_id, media_id, body) values ($1,$2,$3,$4,$5) on conflict (comment_id) do nothing returning id`,
      [ch.organization_id, ch.id, String(v.id), v.media && v.media.id ? String(v.media.id) : null, String(v.text || '').slice(0, 2200)]);
    if (!ev.rowCount) return; // reentrega
    // o Instagram nem sempre manda o @ no aviso: pergunta pelo próprio comentário
    let uname = from.username || null;
    if (!uname) uname = (await api(ch, `/${v.id}`, { fields: 'username' }).catch(() => ({}))).username || null;
    const leadId = await leadFor(ch, fromId, uname);
    // contato criado antes sem nome (só comentou, nunca escreveu no Direct): passa a mostrar o @
    if (uname) await pool.query(`update public.leads set nome = '@' || $2::text, ig_username = coalesce(ig_username, $2::text) where id = $1 and (nome is null or nome = '')`, [leadId, uname]);
    await pool.query(`update public.leads set ig_comment_id = $2, ig_comment_at = now() where id = $1`, [leadId, String(v.id)]);
    let r = { started: [], replies: [] };
    if (onComment) r = (await onComment({ orgId: ch.organization_id, leadId, text: String(v.text || ''), mediaId: v.media && v.media.id ? String(v.media.id) : null, commentId: String(v.id) })
      .catch((e) => { console.error('[instagram] fluxo do comentário:', e.message); return null; })) || r;
    const replies = (r.replies || []).map((x) => String(x || '').trim()).filter(Boolean);
    let pub = null;
    if (replies.length) {
      pub = replies[Math.floor(Math.random() * replies.length)].slice(0, 2000);
      await api(ch, `/${v.id}/replies`, { message: pub }, 'POST').catch((e) => { console.error('[instagram] resposta pública:', e.message); pub = null; });
    }
    await pool.query(`update public.ig_comment_events set lead_id = $2, flows_started = $3, public_reply = $4 where id = $1`, [ev.rows[0].id, leadId, (r.started || []).length, pub]);
  }

  async function receiveWebhook(raw, sigHeader) {
    if (!signed(raw, sigHeader)) return { status: 401 };
    let p; try { p = JSON.parse(raw.toString('utf8')); } catch { return { status: 400 }; }
    if (p.object !== 'page' && p.object !== 'instagram') return { status: 200 };
    const kind = p.object === 'instagram' ? 'instagram' : 'messenger';
    for (const entry of p.entry || []) {
      const ch = (await pool.query(`select * from public.meta_channels where kind = $1 and external_id = $2`, [kind, String(entry.id)])).rows[0];
      if (!ch) continue;
      for (const c of entry.changes || []) {
        if (kind === 'instagram' && c.field === 'comments' && c.value) await receiveComment(ch, c.value).catch((e) => console.error('[instagram] comentário:', e.message));
      }
      for (const ev of entry.messaging || []) {
        // botão de modelo/menu (postback): vira mensagem com o título do botão
        const m = ev.message || (ev.postback && ev.postback.mid ? { mid: ev.postback.mid, text: ev.postback.title || ev.postback.payload } : null);
        if (!m || !m.mid || m.is_deleted || m.is_unsupported) continue;
        const echo = !!m.is_echo;
        const other = String(echo ? (ev.recipient && ev.recipient.id) : (ev.sender && ev.sender.id) || '');
        if (!other || other === ch.external_id) continue;
        const leadId = await leadFor(ch, other);
        const att = (m.attachments || [])[0];
        const story = att && att.type === 'story_mention' ? 'mention' : m.reply_to && m.reply_to.story ? 'reply' : null;
        const storyUrl = story === 'mention' ? httpsOr(att.payload && att.payload.url) : story === 'reply' ? httpsOr(m.reply_to.story.url) : null;
        const tipo = att ? kindOfAttachment(att.type) : 'text';
        const url = att && att.payload ? httpsOr(att.payload.url) : null;
        const text = String(m.text || '') || (story === 'mention' ? '[mencionou você no story]'
          : att ? `[${{ image: 'imagem', video: 'vídeo', audio: 'áudio', document: 'arquivo', sticker: 'figurinha' }[tipo] || 'mensagem'}]` : '');
        const at = ev.timestamp ? new Date(Number(ev.timestamp)) : new Date();
        if (echo) { // a empresa respondeu pelo app do Instagram/Facebook (ou a própria Kobly: já está guardada)
          await pool.query(`insert into public.whatsapp_outbound_messages (organization_id, lead_id, to_phone, source, body, wa_message_id, channel, created_at, msg_type, media_url, media_at, meta_channel_id)
            select $1,$2,$3,'celular',$4,$5,$6,$7,$8,$9,$10,$11 where not exists (select 1 from public.whatsapp_outbound_messages where organization_id = $1 and wa_message_id = $5)`,
            [ch.organization_id, leadId, `${kind === 'instagram' ? 'ig' : 'fb'}:${other}`, text, m.mid, kind, at, tipo, url, url ? new Date() : null, ch.id]);
          continue;
        }
        const shown = story === 'reply' ? `↩︎ Respondeu ao seu story: ${text}` : text;
        const ins = await pool.query(`insert into public.whatsapp_inbound_messages (organization_id, meta_channel_id, wa_message_id, from_phone, lead_id, msg_type, body, payload, received_at, media_url, media_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) on conflict (wa_message_id) do nothing returning id`,
          [ch.organization_id, ch.id, m.mid, `${kind === 'instagram' ? 'ig' : 'fb'}:${other}`, leadId, tipo, shown, JSON.stringify({ channel: kind, story, story_url: storyUrl }), at, url, url ? new Date() : null]);
        if (!ins.rowCount) continue; // reentrega
        // menção em story não abre conversa no Direct: não conta como "a pessoa escreveu"
        await pool.query(`update public.leads set whatsapp_last_inbound_at = case when $4 then whatsapp_last_inbound_at else $2 end, chat_channel = $3,
          chat_archived_at = case when chat_archived_at is not null and chat_archived_at < $2 then null else chat_archived_at end where id = $1`, [leadId, at, kind, story === 'mention']);
        if (onInbound) await onInbound({ orgId: ch.organization_id, leadId, text: story === 'mention' ? '' : String(m.text || '') || text, messageId: m.mid, channel: kind, story, storyUrl })
          .catch((e) => console.error('[meta-msg] fluxo:', e.message));
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
  // o canal certo é o da última mensagem/comentário da pessoa (a empresa pode ter mais de uma conta)
  async function channelForLead(orgId, kind, userId) {
    const col = kind === 'instagram' ? 'ig_user_id' : 'fb_psid';
    const r = (await pool.query(`select c.* from public.whatsapp_inbound_messages m join public.leads l on l.id = m.lead_id join public.meta_channels c on c.id = m.meta_channel_id
      where l.organization_id = $1 and l.${col} = $2 and c.status = 'connected' order by m.received_at desc limit 1`, [orgId, userId])).rows[0];
    if (r) return r;
    if (kind === 'instagram') {
      const c = (await pool.query(`select c.* from public.ig_comment_events e join public.leads l on l.id = e.lead_id join public.meta_channels c on c.id = e.meta_channel_id
        where l.organization_id = $1 and l.ig_user_id = $2 and c.status = 'connected' order by e.created_at desc limit 1`, [orgId, userId])).rows[0];
      if (c) return c;
    }
    return channelFor(orgId, kind);
  }
  async function deliver(orgId, to, message) {
    const a = channelAddress(to);
    if (!a) throw new AuthError(422, 'bad_phone', 'Destino inválido.');
    const ch = await channelForLead(orgId, a.kind, a.id);
    let recipient = { id: a.id }, comment = null;
    if (a.kind === 'instagram') { // comentário sem resposta privada e conversa fechada: a mensagem vai como resposta ao comentário
      const l = (await pool.query(`select id, ig_comment_id, ig_comment_at, whatsapp_last_inbound_at from public.leads where organization_id = $1 and ig_user_id = $2`, [orgId, a.id])).rows[0];
      const open = l && l.whatsapp_last_inbound_at && now().getTime() - new Date(l.whatsapp_last_inbound_at).getTime() < DAY;
      if (l && l.ig_comment_id && !open && l.ig_comment_at && now().getTime() - new Date(l.ig_comment_at).getTime() < 7 * DAY) { recipient = { comment_id: l.ig_comment_id }; comment = l; }
    }
    const payload = (msg) => (ch.auth === 'ig_login' || comment ? { recipient, message: msg } : { recipient, messaging_type: 'RESPONSE', message: msg });
    let r;
    try { r = await api(ch, '/me/messages', {}, 'POST', payload(message)); }
    catch (e) {
      // a resposta privada pode não aceitar botões: manda o texto com as opções escritas
      if (!comment || !message.quick_replies) throw e;
      r = await api(ch, '/me/messages', {}, 'POST', payload({ text: `${message.text}\n\n${message.quick_replies.map((q) => `• ${q.title}`).join('\n')}`.slice(0, 1000) }));
    }
    if (comment) await pool.query(`update public.leads set ig_comment_id = null where id = $1 and ig_comment_id = $2`, [comment.id, comment.ig_comment_id]);
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
  // comentário ainda sem resposta privada (até 7 dias): dá para mandar UMA mensagem mesmo sem a pessoa ter escrito no Direct
  async function commentReplyPending(orgId, to) {
    const a = channelAddress(to);
    if (!a || a.kind !== 'instagram') return false;
    return (await pool.query(`select 1 from public.leads where organization_id = $1 and ig_user_id = $2 and ig_comment_id is not null and ig_comment_at > now() - interval '7 days'`, [orgId, a.id])).rowCount > 0;
  }
  const hasChannel = async (orgId) => (await pool.query(`select 1 from public.meta_channels where organization_id = $1 and status = 'connected' limit 1`, [orgId])).rowCount > 0;
  // a pessoa segue o perfil da empresa? (true/false; null se o Instagram não informar)
  async function followsBusiness(orgId, igUserId) {
    if (!igUserId) return null;
    try {
      const ch = await channelForLead(orgId, 'instagram', String(igUserId));
      const j = await api(ch, `/${igUserId}`, { fields: 'is_user_follow_business' });
      return typeof j.is_user_follow_business === 'boolean' ? j.is_user_follow_business : null;
    } catch (e) { console.error('[instagram] segue?', e.message); return null; }
  }

  return { handle, oauthCallback, igOauthCallback, ownsState, verify, receiveWebhook, sendTextTo, sendMediaTo, sendInteractiveTo, hasChannel, followsBusiness, commentReplyPending };
}
