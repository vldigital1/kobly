// WhatsApp oficial (Meta Cloud API): uma empresa pode ter vários números. Cada envio sai pelo número escolhido
// ou, se nenhum foi escolhido, pelo mesmo número em que a pessoa escreveu por último.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth.js';
import { MetaError } from './graph.js';
import { encrypt, decrypt } from './crypto.js';
import { countVariables, bodyOf, buildSendComponents, normalizePhone, buildTemplateRequest } from './templates.js';

const SAFE_COLS = 'id, organization_id, waba_id, phone_number_id, display_phone, verified_name, quality_rating, messaging_limit, status, last_error, webhook_public_id, verify_token, connected_at';
export const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|nao quero|não quero)\s*[.!]?\s*$/i;

function metaToHttp(e) {
  if (!(e instanceof MetaError)) return e;
  if (e.code === 190) return new AuthError(400, 'meta_token_invalid', 'O token de acesso da Meta é inválido ou expirou. Gere um novo e conecte de novo.');
  if (e.status === 502) return new AuthError(502, e.code, e.message);
  if (e.code === 100 || e.status === 400 || e.status === 404) return new AuthError(400, 'meta_rejected', `A Meta recusou: ${e.message}`);
  if (e.status === 401 || e.status === 403) return new AuthError(400, 'meta_forbidden', 'Este token não tem permissão para esse número/conta. Confira as permissões do token.');
  return new AuthError(502, 'meta_error', `Erro da Meta: ${e.message}`);
}

// Cadastro incorporado (um clique): appId/appSecret = app da Kobly; esConfigId = configuração do "Login do Facebook para
// Empresas" com o cadastro do WhatsApp; appVerifyToken = senha do webhook do app (/webhooks/whatsapp-app).
export function createWhatsapp({ pool, graph, secretKey, publicBaseUrl, globalAppSecret, appId = '', appSecret = '', esConfigId = '', appVerifyToken = '', graphVersion = 'v21.0' }) {
  const view = (row) => row && ({
    id: row.id, organization_id: row.organization_id, waba_id: row.waba_id, phone_number_id: row.phone_number_id,
    display_phone: row.display_phone, verified_name: row.verified_name, quality_rating: row.quality_rating,
    messaging_limit: row.messaging_limit, status: row.status, last_error: row.last_error, connected_at: row.connected_at,
    webhook_url: `${publicBaseUrl}/webhooks/whatsapp/${row.webhook_public_id}`, verify_token: row.verify_token,
    has_app_secret: !!row.app_secret_enc, embedded: !!row.embedded,
  });
  const embeddedOn = () => !!(appId && appSecret && esConfigId && secretKey);

  // Resolve a organização alvo e confere que o usuário PODE mexer nela (mesma regra da RLS do banco).
  async function resolveOrg(user, orgId) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role kobly_authenticated`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, role: 'kobly_authenticated' })]);
      let target = orgId;
      if (!target) {
        const p = await client.query(`select organization_id from public.profiles where auth_id = auth.uid()`);
        target = p.rows[0] && p.rows[0].organization_id;
      }
      if (!target) throw new AuthError(400, 'no_org', 'Sua conta ainda não tem uma empresa.');
      const ok = await client.query(`select public.has_org_access($1::uuid) as ok`, [target]);
      if (!ok.rows[0].ok) throw new AuthError(403, 'forbidden', 'Você não tem acesso a esta empresa.');
      // quem só atende chamados (Suporte) não configura canais do cliente
      const role = await client.query(`select tipo_user_geral, team_role, organization_id from public.profiles where auth_id = auth.uid()`);
      await client.query('commit');
      const p = role.rows[0] || {};
      // papel na equipe só vale dentro da própria empresa (Gestor/Admin da Kobly não têm)
      return { orgId: target, role: p.tipo_user_geral, teamRole: p.organization_id === target ? p.team_role || 'admin' : null };
    } catch (e) { try { await client.query('rollback'); } catch {} throw e; } finally { client.release(); }
  }
  const requireManager = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar a conexão do WhatsApp.'); };

  // um número específico (accountId) ou o principal da empresa (o primeiro conectado)
  async function accountRow(orgId, accountId = null) {
    const { rows } = accountId
      ? await pool.query(`select * from public.whatsapp_accounts where organization_id = $1 and id::text = $2`, [orgId, String(accountId)])
      : await pool.query(`select * from public.whatsapp_accounts where organization_id = $1 order by (status = 'connected') desc, connected_at nulls last, created_at limit 1`, [orgId]);
    return rows[0] || null;
  }
  const accountsOf = async (orgId) => (await pool.query(`select * from public.whatsapp_accounts where organization_id = $1 order by connected_at nulls last, created_at`, [orgId])).rows;
  // número para falar com alguém: o escolhido; senão o da última mensagem que a pessoa mandou (mesma conversa); senão o principal
  async function accountFor(orgId, { accountId = null, to = null } = {}) {
    if (accountId) { const r = await accountRow(orgId, accountId); if (r) return r; }
    const phone = String(to || '').replace(/\D/g, '');
    if (phone.length >= 8) {
      const r = (await pool.query(`select a.* from public.whatsapp_inbound_messages m join public.whatsapp_accounts a on a.id = m.account_id
        where m.organization_id = $1 and right(m.from_phone, 10) = right($2, 10) order by m.received_at desc limit 1`, [orgId, phone])).rows[0];
      if (r) return r;
    }
    return accountRow(orgId);
  }
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'whatsapp_unconfigured', 'O WhatsApp ainda não foi configurado neste ambiente (chave de segurança ausente).'); };
  const tokenOf = (row) => { needKey(); return decrypt(row.token_enc, secretKey); };

  async function connect(ctx, { waba_id, phone_number_id, access_token, app_secret }, embedded = false) {
    requireManager(ctx);
    needKey();
    const waba = String(waba_id || '').trim(); const pid = String(phone_number_id || '').trim(); const tok = String(access_token || '').trim();
    if (!/^\d{5,25}$/.test(waba) || !/^\d{5,25}$/.test(pid)) throw new AuthError(422, 'validation_failed', 'ID da conta WhatsApp Business e ID do número devem ser só números.');
    if (tok.length < 20) throw new AuthError(422, 'validation_failed', 'Informe o token de acesso.');
    let info;
    try { info = await graph.getPhoneNumber(pid, tok); await graph.getWaba(waba, tok); }
    catch (e) { throw metaToHttp(e); }
    const existing = (await pool.query(`select * from public.whatsapp_accounts where organization_id = $1 and phone_number_id = $2`, [ctx.orgId, pid])).rows[0];
    // um mesmo número não pode estar em duas empresas
    const dup = await pool.query(`select organization_id from public.whatsapp_accounts where phone_number_id = $1 and organization_id <> $2`, [pid, ctx.orgId]);
    if (dup.rows[0]) throw new AuthError(409, 'phone_in_use', 'Este número já está conectado em outra empresa.');
    const verify = existing ? existing.verify_token : randomBytes(18).toString('base64url');
    const args = [ctx.orgId, waba, pid, info.display_phone_number || null, info.verified_name || null, info.quality_rating || null, info.messaging_limit_tier || null,
      verify, encrypt(tok, secretKey), app_secret ? encrypt(String(app_secret).trim(), secretKey) : null, embedded];
    const { rows } = await pool.query(
      `insert into public.whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone, verified_name, quality_rating, messaging_limit, status, last_error, verify_token, token_enc, app_secret_enc, connected_at, embedded)
       values ($1,$2,$3,$4,$5,$6,$7,'connected',null,$8,$9,$10, now(), $11)
       on conflict (phone_number_id) do update set waba_id = excluded.waba_id, display_phone = excluded.display_phone,
         verified_name = excluded.verified_name, quality_rating = excluded.quality_rating, messaging_limit = excluded.messaging_limit, status = 'connected', last_error = null,
         token_enc = excluded.token_enc, app_secret_enc = case when excluded.embedded then null else coalesce(excluded.app_secret_enc, public.whatsapp_accounts.app_secret_enc) end, connected_at = now(), embedded = excluded.embedded
       returning *`, args);
    // assina a conta para receber os avisos (falha aqui não desfaz a conexão; vira aviso)
    let webhookWarning = null;
    try { await graph.subscribeApp(waba, tok); } catch (e) { webhookWarning = 'Conectado, mas não consegui assinar os avisos de entrega automaticamente. Configure o webhook no painel da Meta com a URL abaixo.'; }
    return { account: view(rows[0]), webhookWarning };
  }

  // ---- Um clique: "Conectar com Facebook" (Cadastro incorporado da Meta) ------------------
  function embeddedConfig() {
    return embeddedOn() ? { enabled: true, app_id: appId, config_id: esConfigId, graph_version: graphVersion } : { enabled: false };
  }
  // a tela manda o código do login + os IDs que a janela da Meta devolveu (conta e número escolhidos pelo cliente)
  async function embeddedConnect(ctx, { code, waba_id, phone_number_id }) {
    requireManager(ctx);
    if (!embeddedOn()) throw new AuthError(503, 'embedded_off', 'A conexão com um clique ainda não foi ativada no servidor da Kobly.');
    if (!/^[A-Za-z0-9_\-#.]{10,2048}$/.test(String(code || ''))) throw new AuthError(422, 'validation_failed', 'O login da Meta não devolveu o código. Tente de novo.');
    let tok;
    try { tok = (await graph.exchangeCode(appId, appSecret, String(code))).access_token; }
    catch (e) { throw new AuthError(400, 'embedded_code', 'A Meta não confirmou o login (o código vale poucos minutos). Clique em "Conectar com Facebook" de novo.'); }
    if (!tok) throw new AuthError(400, 'embedded_code', 'A Meta não devolveu o acesso. Tente de novo.');
    // número novo precisa ser ativado na Cloud API (PIN de 6 dígitos da verificação em duas etapas); se já estiver ativo, segue
    let registerWarning = null;
    const pin = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
    try { await graph.registerPhone(String(phone_number_id || ''), tok, pin); }
    catch (e) { if (!/already|registrad/i.test(String(e.message || ''))) registerWarning = `O número foi conectado, mas a Meta não confirmou a ativação: ${e.message}`; }
    const r = await connect(ctx, { waba_id, phone_number_id, access_token: tok }, true);
    return { ...r, registerWarning };
  }

  async function refreshRow(row) {
    try {
      const info = await graph.getPhoneNumber(row.phone_number_id, tokenOf(row));
      return (await pool.query(`update public.whatsapp_accounts set display_phone=$2, verified_name=$3, quality_rating=$4, messaging_limit=$5, status='connected', last_error=null where id=$1 returning *`,
        [row.id, info.display_phone_number || row.display_phone, info.verified_name || row.verified_name, info.quality_rating || row.quality_rating, info.messaging_limit_tier || row.messaging_limit])).rows[0];
    } catch (e) {
      const he = metaToHttp(e);
      return (await pool.query(`update public.whatsapp_accounts set status='error', last_error=$2 where id=$1 returning *`, [row.id, he.message])).rows[0];
    }
  }
  // account = o número escolhido (account_id) ou o principal; accounts = todos os números oficiais da empresa
  async function status(ctx, { refresh, account_id } = {}) {
    let rows = await accountsOf(ctx.orgId);
    if (!rows.length) return { connected: false, account: null, accounts: [] };
    if (refresh) rows = await Promise.all(rows.map((r) => (!account_id || r.id === account_id ? refreshRow(r) : r)));
    const row = (account_id && rows.find((r) => r.id === account_id)) || rows.find((r) => r.status === 'connected') || rows[0];
    return { connected: row.status === 'connected', account: view(row), accounts: rows.map(view) };
  }

  // desconecta um número (account_id) ou, sem ele, todos os números oficiais da empresa
  async function disconnect(ctx, { account_id } = {}) {
    requireManager(ctx);
    if (account_id) await pool.query(`delete from public.whatsapp_accounts where organization_id = $1 and id::text = $2`, [ctx.orgId, String(account_id)]);
    else await pool.query(`delete from public.whatsapp_accounts where organization_id = $1`, [ctx.orgId]);
    return { ok: true };
  }

  async function upsertTemplate(row, t) {
    const body = bodyOf(t.components);
    await pool.query(
      `insert into public.whatsapp_templates (organization_id, account_id, name, language, category, status, meta_template_id, components, body_text, variable_count, rejected_reason, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11, now())
       on conflict (account_id, name, language) do update set category=excluded.category, status=excluded.status, meta_template_id=excluded.meta_template_id,
         components=excluded.components, body_text=excluded.body_text, variable_count=excluded.variable_count, rejected_reason=excluded.rejected_reason, synced_at=now()`,
      [row.organization_id, row.id, t.name, t.language, t.category || 'MARKETING', t.status || 'PENDING', t.id || null, JSON.stringify(t.components || []), body, countVariables(body), t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null]);
  }

  async function syncTemplates(ctx, { account_id } = {}) {
    const row = await accountRow(ctx.orgId, account_id || null);
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    let list;
    try { list = await graph.listTemplates(row.waba_id, tokenOf(row)); } catch (e) { throw metaToHttp(e); }
    for (const t of list) await upsertTemplate(row, t);
    return { synced: list.length };
  }

  async function createTemplate(ctx, input) {
    requireManager(ctx);
    const row = await accountRow(ctx.orgId, input.account_id || null);
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    let req;
    try { req = buildTemplateRequest(input); } catch (e) { throw new AuthError(422, e.code || 'validation_failed', e.message); }
    let out;
    try { out = await graph.createTemplate(row.waba_id, tokenOf(row), req); } catch (e) { throw metaToHttp(e); }
    await upsertTemplate(row, { ...req, id: out.id, status: out.status || 'PENDING' });
    return { id: out.id, status: out.status || 'PENDING' };
  }

  // Envia um modelo a UM número. Usado no teste e (depois) pelo motor de campanhas.
  // o modelo pertence a um número: sai sempre por ele
  async function sendTemplateTo(orgId, { to, template_id, variables = [], button_suffix }) {
    const phone = normalizePhone(to);
    if (!phone) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDD + número.');
    const { rows } = await pool.query(`select * from public.whatsapp_templates where id = $1 and organization_id = $2`, [template_id, orgId]);
    const tpl = rows[0];
    if (!tpl) throw new AuthError(404, 'template_not_found', 'Modelo não encontrado.');
    const row = await accountRow(orgId, tpl.account_id);
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    if (tpl.status !== 'APPROVED') throw new AuthError(409, 'template_not_approved', `Este modelo está "${tpl.status}". Só modelos aprovados pela Meta podem ser enviados.`);
    let components;
    try { components = buildSendComponents(tpl, variables, button_suffix); } catch (e) { throw new AuthError(422, e.code || 'validation_failed', e.message); }
    try {
      const out = await graph.sendTemplate(row.phone_number_id, tokenOf(row), { to: phone, name: tpl.name, language: tpl.language, components });
      return { ok: true, id: (out.messages && out.messages[0] && out.messages[0].id) || null, to: phone, accountId: row.id };
    } catch (e) { throw metaToHttp(e); }
  }

  // Texto livre a UM número (motor de fluxos). Quem chama confere a janela de 24 h antes.
  async function sendTextTo(orgId, { to, text, replyTo = null, linkPreview = true, accountId = null }) {
    const row = await accountFor(orgId, { accountId, to });
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const phone = normalizePhone(to);
    if (!phone) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDD + número.');
    const body = String(text || '').slice(0, 4096);
    if (!body.trim()) throw new AuthError(422, 'empty_text', 'Mensagem vazia.');
    try {
      const out = await graph.sendText(row.phone_number_id, tokenOf(row), { to: phone, text: body, previewUrl: linkPreview !== false, replyTo: officialId(replyTo) });
      return { ok: true, id: (out.messages && out.messages[0] && out.messages[0].id) || null, to: phone, accountId: row.id };
    } catch (e) { throw metaToHttp(e); }
  }

  async function sendWith(orgId, to, fn, accountId = null) {
    const row = await accountFor(orgId, { accountId, to });
    if (!row) throw new AuthError(400, 'not_connected', 'Conecte o WhatsApp primeiro.');
    const phone = normalizePhone(to);
    if (!phone) throw new AuthError(422, 'bad_phone', 'Número inválido. Use DDD + número.');
    try {
      const out = await fn(row, phone);
      return { ok: true, id: (out && out.messages && out.messages[0] && out.messages[0].id) || null, to: phone, accountId: row.id };
    } catch (e) { throw metaToHttp(e); }
  }
  // ids de mensagem do WhatsApp por QR Code começam com "uaz:" e não valem na API oficial
  const officialId = (id) => (id && !String(id).startsWith('uaz:') ? String(id) : null);
  const sendMediaTo = (orgId, { to, kind, url, caption, filename, replyTo = null, accountId = null }) =>
    sendWith(orgId, to, (row, phone) => graph.sendMedia(row.phone_number_id, tokenOf(row), { to: phone, kind, link: url, caption, filename, replyTo: officialId(replyTo) }), accountId);
  // Reagir com emoji à mensagem do lead (só funciona com o id da API oficial)
  async function reactTo(orgId, { to, messageId, emoji, accountId = null }) {
    if (!officialId(messageId)) throw new AuthError(400, 'not_connected', 'Mensagem de outro canal.');
    return sendWith(orgId, to, (row, phone) => graph.sendReaction(row.phone_number_id, tokenOf(row), { to: phone, messageId: officialId(messageId), emoji }), accountId);
  }
  const sendInteractiveTo = (orgId, { to, interactive, accountId = null }) =>
    sendWith(orgId, to, (row, phone) => graph.sendInteractive(row.phone_number_id, tokenOf(row), { to: phone, interactive }), accountId);
  // "digitando..." é só cosmético: qualquer falha é ignorada.
  async function typingFor(orgId, messageId) {
    if (!messageId) return false;
    // "digitando" sai pelo número que recebeu a mensagem
    const row = (await pool.query(`select a.* from public.whatsapp_inbound_messages m join public.whatsapp_accounts a on a.id = m.account_id where m.organization_id = $1 and m.wa_message_id = $2`, [orgId, String(messageId)])).rows[0] || await accountRow(orgId);
    if (!row) return false;
    try { await graph.typing(row.phone_number_id, tokenOf(row), messageId); return true; } catch { return false; }
  }

  // Quem trata as mensagens recebidas (motor de fluxos). Definido depois para evitar dependência circular.
  let inboundHandler = null;
  const setInboundHandler = (fn) => { inboundHandler = fn; };

  // ---- Webhook da Meta ------------------------------------------------------
  async function verifyWebhook(publicId, mode, token, challenge) {
    const { rows } = await pool.query(`select verify_token from public.whatsapp_accounts where webhook_public_id::text = $1`, [publicId]);
    const ok = rows[0] && mode === 'subscribe' && token && timingEq(token, rows[0].verify_token);
    return ok ? String(challenge ?? '') : null;
  }
  function timingEq(a, b) { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }

  // Webhook do app da Kobly (contas conectadas com um clique): um endereço para todas; a conta é achada pelo número/WABA
  function verifyAppWebhook(mode, token, challenge) {
    return mode === 'subscribe' && appVerifyToken && token && timingEq(token, appVerifyToken) ? String(challenge ?? '') : null;
  }
  async function receiveAppWebhook(rawBody, signatureHeader) {
    if (!appSecret) return { status: 403, reason: 'app da Kobly sem segredo' };
    const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
    if (!signatureHeader || !timingEq(signatureHeader, expected)) return { status: 403, reason: 'assinatura inválida' };
    let payload; try { payload = JSON.parse(rawBody.toString()); } catch { return { status: 200, ignored: 'json' }; }
    const stats = { statuses: 0, templates: 0, optOuts: 0 };
    for (const entry of payload.entry || []) {
      const { rows } = await pool.query(`select * from public.whatsapp_accounts where waba_id = $1`, [String(entry.id || '')]);
      for (const row of rows) await processEntry(row, entry, stats);
    }
    return { status: 200, ...stats };
  }

  async function receiveWebhook(publicId, rawBody, signatureHeader) {
    const { rows } = await pool.query(`select * from public.whatsapp_accounts where webhook_public_id::text = $1`, [publicId]);
    const row = rows[0];
    if (!row) return { status: 404 };
    needKey();
    const secret = row.app_secret_enc ? decrypt(row.app_secret_enc, secretKey) : globalAppSecret;
    if (!secret) return { status: 403, reason: 'sem app secret para validar a assinatura' };
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!signatureHeader || !timingEq(signatureHeader, expected)) return { status: 403, reason: 'assinatura inválida' };
    let payload; try { payload = JSON.parse(rawBody.toString()); } catch { return { status: 200, ignored: 'json' }; }
    const stats = { statuses: 0, templates: 0, optOuts: 0 };
    for (const entry of payload.entry || []) await processEntry(row, entry, stats);
    return { status: 200, ...stats };
  }

  async function processEntry(row, entry, stats) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'messages') {
        if (v.metadata && v.metadata.phone_number_id && v.metadata.phone_number_id !== row.phone_number_id) continue; // outro número
        for (const s of v.statuses || []) stats.statuses += await recordStatus(row, s);
        for (const m of v.messages || []) {
          // caixa de entrada + retomada dos fluxos que aguardam resposta; falha aqui não pode derrubar o webhook
          if (inboundHandler) {
            try { await inboundHandler({ orgId: row.organization_id, accountId: row.id, message: m, contacts: v.contacts || [] }); }
            catch (e) { console.error('[whatsapp] inbound falhou:', e.message); }
          }
          if (m.type === 'text' && OPT_OUT.test(m.text && m.text.body || '')) stats.optOuts += await optOut(row, m.from);
        }
      } else if (ch.field === 'message_template_status_update') {
        const r = await pool.query(
          `update public.whatsapp_templates set status = $3, rejected_reason = $4, synced_at = now()
            where account_id = $1 and (meta_template_id = $2 or (name = $5 and language = coalesce($6, language)))`,
          [row.id, String(v.message_template_id || ''), String(v.event || '').toUpperCase(), v.reason && v.reason !== 'NONE' ? v.reason : null, v.message_template_name || '', v.message_template_language || null]);
        stats.templates += r.rowCount;
      } else if (ch.field === 'phone_number_quality_update') {
        await pool.query(`update public.whatsapp_accounts set quality_rating = coalesce($2, quality_rating), messaging_limit = coalesce($3, messaging_limit) where id = $1`,
          [row.id, v.current_quality_rating || null, v.current_limit || null]);
      }
    }
  }

  const STATUS = { delivered: 'entregue', read: 'lido', failed: 'falha' };
  async function recordStatus(row, s) {
    const mapped = STATUS[s.status];
    if (!mapped || !s.id) return 0;
    const send = await pool.query(
      `select organization_id, campaign_id, email from public.email_events where sg_message_id = $1 and channel = 'whatsapp' and event = 'send' and organization_id = $2 limit 1`, [s.id, row.organization_id]);
    if (!send.rows[0]) return 0;
    const reason = mapped === 'falha' ? String((s.errors && s.errors[0] && (s.errors[0].title || s.errors[0].message)) || 'falha no envio').slice(0, 300) : null;
    try {
      await pool.query(
        `insert into public.email_events (organization_id, campaign_id, event, channel, status, reason, email, sg_message_id, "timestamp")
         values ($1,$2,'status','whatsapp',$3,$4,$5,$6, now())`, [send.rows[0].organization_id, send.rows[0].campaign_id, mapped, reason, send.rows[0].email, s.id]);
      return 1;
    } catch (e) { if (e.code === '23505') return 0; throw e; } // reentrega do mesmo status: a unique parcial já cobre; outro erro aparece
  }
  async function optOut(row, from) {
    const phone = String(from || '').replace(/\D/g, '');
    if (phone.length < 10) return 0;
    const tail = phone.slice(-10); // casa com ou sem 55 e com/sem o 9
    const r = await pool.query(
      `update public.leads set whatsapp_opt_out = true where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2 and not whatsapp_opt_out`, [row.organization_id, tail]);
    return r.rowCount;
  }

  return { resolveOrg, accountsOf, connect, status, disconnect, syncTemplates, createTemplate, sendTemplateTo, sendTextTo, sendMediaTo, sendInteractiveTo, reactTo, typingFor, setInboundHandler, verifyWebhook, receiveWebhook, verifyAppWebhook, receiveAppWebhook, embeddedConfig, embeddedConnect, view, SAFE_COLS };
}
