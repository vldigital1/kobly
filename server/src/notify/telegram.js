// Alertas para a equipe (bloco "Alerta" dos fluxos): Telegram por bot próprio da empresa.
// O token do bot fica cifrado; o fluxo só referencia o canal (id) e o texto.
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';

const SAFE = 'id, organization_id, kind, label, default_chat_id, created_at, updated_at';
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{20,80}$/;

export function createNotifier({ pool, secretKey, fetchImpl = globalThis.fetch, base = 'https://api.telegram.org' }) {
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'notify_unconfigured', 'Alertas não configurados neste ambiente (chave de segurança ausente).'); };

  async function telegram(token, method, payload) {
    let res;
    try {
      res = await fetchImpl(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    } catch { throw Object.assign(new Error('O Telegram não respondeu agora.'), { status: 503 }); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw Object.assign(new Error(j.description || `Telegram respondeu ${res.status}`), { status: res.status });
    return j.result;
  }

  // Envio pelo fluxo. Nunca lança: devolve { ok, detail } e o fluxo segue.
  async function send({ orgId, channelId, text, chatId }) {
    const row = (await pool.query(`select * from public.notification_channels where id::text = $1 and organization_id = $2`, [String(channelId), orgId])).rows[0];
    if (!row) return { ok: false, detail: 'canal de alerta não encontrado nesta empresa' };
    const chat = String(chatId || row.default_chat_id || '').trim();
    if (!chat) return { ok: false, detail: 'sem chat de destino' };
    try {
      needKey();
      await telegram(decrypt(row.token_enc, secretKey), 'sendMessage', { chat_id: chat, text: String(text || '').slice(0, 4000), disable_web_page_preview: true });
      return { ok: true, detail: 'enviado' };
    } catch (e) { return { ok: false, detail: String(e.message).slice(0, 200) }; }
  }

  // Rota notify-channels: list | save | delete | test
  async function handle(ctx, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar canais de alerta.'); };
    switch (body.action) {
      case 'list': return { channels: (await pool.query(`select ${SAFE} from public.notification_channels where organization_id = $1 order by created_at`, [orgId])).rows };
      case 'save': {
        editor(); needKey();
        const token = String(body.bot_token || '').trim();
        const chat = String(body.chat_id || '').trim();
        if (!TOKEN.test(token)) throw new AuthError(422, 'validation_failed', 'Token do bot inválido (formato 123456:ABC...). Pegue com o @BotFather.');
        if (!/^-?\d{3,20}$|^@[A-Za-z0-9_]{5,32}$/.test(chat)) throw new AuthError(422, 'validation_failed', 'Informe o ID do chat/grupo (número) ou o @canal.');
        let me;
        try { me = await telegram(token, 'getMe', {}); } catch (e) { throw new AuthError(400, 'telegram_rejected', `Telegram: ${e.message}`); }
        const { rows } = await pool.query(`insert into public.notification_channels (organization_id, kind, label, token_enc, default_chat_id) values ($1,'telegram',$2,$3,$4) returning ${SAFE}`,
          [orgId, String(body.label || `@${me.username || 'bot'}`).slice(0, 60), encrypt(token, secretKey), chat]);
        return { channel: rows[0] };
      }
      case 'delete': { editor(); const r = await pool.query(`delete from public.notification_channels where id = $1 and organization_id = $2`, [body.id, orgId]); return { ok: r.rowCount === 1 }; }
      case 'test': {
        const r = await send({ orgId, channelId: body.id, text: '✅ Kobly: alerta de teste. Os blocos "Alerta" dos seus fluxos vão chegar aqui.' });
        if (!r.ok) throw new AuthError(400, 'notify_test_failed', r.detail);
        return r;
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { send, handle };
}
