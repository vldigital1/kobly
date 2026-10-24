// Pagamentos dentro do fluxo: credenciais do gateway por empresa, cobrança e confirmação.
// Confirmação: o aviso do gateway só DISPARA a checagem; quem decide é a consulta da transação na API
// do gateway com a credencial da empresa (o aviso da XPag não tem assinatura documentada).
import { randomBytes } from 'node:crypto';
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';
import { PaymentError } from './xpag.js';

const SAFE = 'id, organization_id, provider, label, client_id, sandbox, status, last_error, created_at, updated_at';

export function createPayments({ pool, providers, secretKey, publicBaseUrl, now = () => new Date() }) {
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'payments_unconfigured', 'Pagamentos não configurados neste ambiente (chave de segurança ausente).'); };
  const provider = (name) => { const p = providers[name]; if (!p) throw new AuthError(400, 'bad_provider', 'Gateway não suportado.'); return p; };
  const credOf = (row) => { needKey(); return { clientId: row.client_id, clientSecret: decrypt(row.secret_enc, secretKey) }; };
  const webhookUrl = (row) => `${publicBaseUrl}/webhooks/payments/${row.provider}/${row.webhook_token}`;
  const fromPayment = (e) => (e instanceof PaymentError ? new AuthError(e.status >= 500 ? 502 : 400, e.code, `Gateway: ${e.message}`) : e);

  // ---- credenciais (rota payment-integrations) ----------------------------------
  async function handle(ctx, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar integrações de pagamento.'); };
    switch (body.action) {
      case 'list': return {
        integrations: (await pool.query(`select ${SAFE} from public.payment_integrations where organization_id = $1 order by created_at`, [orgId])).rows,
        providers: Object.entries(providers).map(([id, p]) => ({ id, label: p.label || id, methods: p.methods || {}, needs_client_id: p.needsClientId !== false })),
      };
      case 'webhook_url': { // gateways que registram o aviso no painel (Woovi) precisam da URL da conta
        const r = (await pool.query(`select provider, webhook_token from public.payment_integrations where id = $1 and organization_id = $2`, [body.id, orgId])).rows[0];
        if (!r) throw new AuthError(404, 'not_found', 'Conta não encontrada.');
        return { url: webhookUrl(r) };
      }
      case 'connect': {
        editor(); needKey();
        const prov = String(body.provider || 'xpag');
        const p = provider(prov);
        const clientId = String(body.client_id || '').trim(), secret = String(body.client_secret || '').trim();
        if (p.needsClientId !== false && clientId.length < 4) throw new AuthError(422, 'validation_failed', 'Informe o Client ID e o Client Secret.');
        if (secret.length < 8) throw new AuthError(422, 'validation_failed', p.needsClientId !== false ? 'Informe o Client ID e o Client Secret.' : 'Cole a chave/token de API da conta.');
        try { await p.checkCredentials({ clientId, clientSecret: secret }); } catch (e) { throw fromPayment(e); }
        const sandbox = /sandbox|^TEST-/i.test(clientId || secret);
        const { rows } = await pool.query(`insert into public.payment_integrations (organization_id, provider, label, client_id, secret_enc, sandbox, webhook_token)
          values ($1,$2,$3,$4,$5,$6,$7) returning ${SAFE}`,
          [orgId, prov, String(body.label || (sandbox ? 'Sandbox' : 'Principal')).slice(0, 60), clientId || '—', encrypt(secret, secretKey), sandbox, randomBytes(24).toString('base64url')]);
        return { integration: rows[0] };
      }
      case 'disconnect': {
        editor();
        const r = await pool.query(`delete from public.payment_integrations where id = $1 and organization_id = $2`, [body.id, orgId]);
        return { ok: r.rowCount === 1 };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  // ---- cobrança gerada pelo bloco do fluxo --------------------------------------
  async function createCharge({ ex, nodeRef, integrationId, currency, method, amount, openAmount, payer, description, externalId, listenHours }) {
    const row = (await pool.query(`select * from public.payment_integrations where id::text = $1 and organization_id = $2`, [String(integrationId), ex.organization_id])).rows[0];
    if (!row) throw new PaymentError(400, 'integration_not_found', 'Credencial de pagamento não encontrada nesta empresa.');
    const gw = provider(row.provider);
    if (!((gw.methods || {})[currency] || []).includes(method)) throw new PaymentError(400, 'method_not_supported', `${gw.label || row.provider} não cobra ${method} em ${currency}.`);
    if (openAmount && !(gw.openAmountOk && gw.openAmountOk(currency, method))) throw new PaymentError(400, 'open_amount_not_supported', `${gw.label || row.provider} não aceita valor livre neste método.`);
    if (!openAmount && !(Number(amount) > 0)) throw new PaymentError(400, 'invalid_amount', 'Valor da cobrança inválido.');
    // idempotência: mesma external_id (repetição após falha temporária) devolve a mesma cobrança
    const prev = (await pool.query(`select * from public.payment_charges where external_id = $1`, [externalId])).rows[0];
    if (prev && prev.transaction_id) return prev;
    const out = await gw.createCharge(credOf(row), {
      currency, method, amount, openAmount, name: payer.name, document: payer.document, email: payer.email, phone: payer.phone,
      description, externalId, webhookUrl: webhookUrl(row),
    });
    const listenUntil = new Date(now().getTime() + Math.max(1, Math.min(168, listenHours || 48)) * 3600e3).toISOString();
    const { rows } = await pool.query(`insert into public.payment_charges (organization_id, integration_id, execution_id, campaign_id, lead_id, node_ref, provider, external_id, transaction_id, request_number,
        currency, method, amount, open_amount, status, payment_code, payment_qr, checkout_url, listen_until, raw)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
      on conflict (external_id) do update set transaction_id = excluded.transaction_id, request_number = excluded.request_number, payment_code = excluded.payment_code,
        payment_qr = excluded.payment_qr, checkout_url = excluded.checkout_url, raw = excluded.raw
      returning *`,
      [ex.organization_id, row.id, ex.id, ex.campaign_id, ex.lead_id, nodeRef, row.provider, externalId, out.transactionId, out.requestNumber, currency, method,
        openAmount ? null : Number(amount), !!openAmount, ['confirmed', 'expired', 'failed'].includes(out.status) ? out.status : 'pending', out.code, out.qr, out.link, listenUntil,
        JSON.stringify({ ...out.raw, qr_img: undefined, extra: out.extra })]);
    return { ...rows[0], extra: out.extra };
  }

  // ---- aviso do gateway ------------------------------------------------------------
  // Devolve { status, body }. Sempre 200 para avisos válidos (gateway desativa/repete em erro); 404 para token desconhecido.
  async function receiveWebhook(providerName, token, rawBody, onConfirmed) {
    const row = (await pool.query(`select * from public.payment_integrations where provider = $1 and webhook_token = $2`, [providerName, String(token || '')])).rows[0];
    if (!row) return { status: 404, body: { ok: false } };
    let body; try { body = JSON.parse(rawBody || '{}'); } catch { return { status: 200, body: { ok: true, ignored: 'json' } }; }
    const ev = provider(row.provider).parseWebhook(body);
    if (!ev) return { status: 200, body: { ok: true, ignored: 'not_cashin' } };
    const dup = await pool.query(`insert into public.payment_webhook_events (organization_id, integration_id, dedupe_key, status, payload) values ($1,$2,$3,$4,$5::jsonb)
      on conflict (integration_id, dedupe_key) do nothing returning id`, [row.organization_id, row.id, ev.dedupeKey, ev.status, JSON.stringify(body)]);
    if (!dup.rows[0]) return { status: 200, body: { ok: true, deduped: true } };
    const evId = dup.rows[0].id;
    const result = (r) => pool.query(`update public.payment_webhook_events set result = $2 where id = $1`, [evId, r]).catch(() => {});

    const charge = (await pool.query(`select * from public.payment_charges where integration_id = $1 and (transaction_id = $2 or request_number = $2 or external_id = $3) limit 1`,
      [row.id, ev.transactionId, ev.externalId])).rows[0];
    if (!charge) { await result('cobrança desconhecida'); return { status: 200, body: { ok: true, ignored: 'unknown_charge' } }; }
    if (charge.status === 'confirmed') { await result('já confirmada'); return { status: 200, body: { ok: true, already: true } }; }

    // fonte da verdade: consulta na API do gateway com a credencial da empresa
    let real;
    try { real = await provider(row.provider).consult(credOf(row), { transactionId: charge.transaction_id, externalId: charge.external_id }); }
    catch (e) { // libera a reentrega: o gateway repete o aviso e a checagem roda de novo
      await pool.query(`delete from public.payment_webhook_events where id = $1`, [evId]).catch(() => {});
      console.error('[payments] consulta falhou:', e.code || e.message);
      return { status: 503, body: { ok: false, retry: true } };
    }
    if (real.status === 'confirmed') {
      const upd = await pool.query(`update public.payment_charges set status = 'confirmed', confirmed_at = now(), paid_amount = coalesce($2, amount) where id = $1 and status <> 'confirmed' returning *`, [charge.id, real.amount]);
      if (upd.rows[0]) { await result('confirmada'); if (onConfirmed) await onConfirmed(upd.rows[0]); }
      return { status: 200, body: { ok: true, confirmed: true } };
    }
    if (real.status === 'expired' && charge.status === 'pending') await pool.query(`update public.payment_charges set status = 'expired' where id = $1`, [charge.id]);
    await result(`status real: ${real.status}`);
    return { status: 200, body: { ok: true, status: real.status } };
  }

  return { handle, createCharge, receiveWebhook };
}
