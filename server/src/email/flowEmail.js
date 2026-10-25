// E-mail dos fluxos em grafo (bloco "Enviar e-mail"): mesmo envio das campanhas (supabase/functions/process-steps).
//  - remetente: "Nome <domínio verificado da empresa>" → senão "<sender_local>@<subdomínio da plataforma>" → senão o padrão
//  - descadastro: link assinado em {{unsubscribe_url}} e no "Descadastrar" do rodapé + List-Unsubscribe (one-click)
//  - quem se descadastrou (da empresa ou global) não recebe: o bloco segue sem enviar
//  - erro 4xx definitivo do Resend não é repetido; 5xx/429/rede repetem
import { signUnsubToken } from '../unsubscribe.js';

const NON_FATAL_4XX = new Set([401, 402, 408, 409, 429]);
export const isFatalClientError = (status) => status >= 400 && status < 500 && !NON_FATAL_4XX.has(status);
export const extractEmail = (s) => { if (!s) return null; const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : String(s)).trim() || null; };
export const fromNameSafe = (n) => String(n || '').replace(/["<>\\]/g, '').replace(/,/g, ' ').trim() || 'KOBLY';

class EmailError extends Error { constructor(msg, status, fatal) { super(msg); this.status = status; this.fatal = fatal; } }

export function createFlowEmail({ pool, apiKey = '', platformFrom = '', sendingDomain = '', unsubSecret = '', publicBaseUrl = '', fetchImpl = globalThis.fetch }) {
  const platformSender = extractEmail(platformFrom) || 'onboarding@resend.dev';
  async function senderEmail(orgId) {
    const dom = (await pool.query(`select from_email, url from public.domains
      where organization_id = $1 and status = 'verified' and id_resend is not null and id_resend not like 'sg%'
      order by created_at desc limit 1`, [orgId])).rows[0];
    let addr = dom ? extractEmail(dom.from_email) || (dom.url ? `contato@${dom.url}` : null) : null;
    if (!addr && sendingDomain) {
      const o = (await pool.query(`select sender_local from public.organizations where id = $1`, [orgId])).rows[0];
      if (o && o.sender_local) addr = `${o.sender_local}@${sendingDomain}`;
    }
    return addr || platformSender;
  }
  async function suppressed(orgId, email) {
    return (await pool.query(`select 1 from public.email_suppressions where email = $1 and (organization_id = $2 or organization_id is null) limit 1`, [String(email).toLowerCase(), orgId])).rowCount > 0;
  }

  // → { ok, id } | { skipped } ; erro com .fatal (não repetir) ou sem (repetir)
  async function send(orgId, { to, subject, html, fromName }) {
    if (await suppressed(orgId, to)) return { skipped: 'destinatário descadastrado' };
    if (!apiKey) throw new EmailError('envio de e-mail não configurado (RESEND_API_KEY)', 503, true);
    let unsubUrl = null;
    if (unsubSecret && publicBaseUrl) unsubUrl = `${publicBaseUrl}/functions/v1/unsubscribe?token=${signUnsubToken(unsubSecret, orgId, to)}`;
    const link = unsubUrl || 'mailto:unsubscribe@koblay.io';
    const body = String(html || '<p></p>').split('{{unsubscribe_url}}').join(link).replace(/href="#"(\s[^>]*>\s*Descadastrar)/i, `href="${link}"$1`);
    const replyTo = ((await pool.query(`select reply_to_email from public.organizations where id = $1`, [orgId])).rows[0] || {}).reply_to_email;
    const payload = {
      from: `${fromNameSafe(fromName)} <${await senderEmail(orgId)}>`, to: [to], subject: subject || 'KOBLY', html: body,
      headers: unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@koblay.io>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : { 'List-Unsubscribe': '<mailto:unsubscribe@koblay.io>' },
      ...(replyTo && String(replyTo).trim() ? { reply_to: String(replyTo).trim() } : {}),
    };
    let res;
    try {
      res = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    } catch { throw new EmailError('o serviço de e-mail não respondeu', 502, false); }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new EmailError(`Resend: ${(out && (out.message || out.error)) || `HTTP ${res.status}`}`.slice(0, 200), res.status, isFatalClientError(res.status));
    return { ok: true, id: (out && out.id) || null };
  }
  return { send, configured: () => !!apiKey };
}
