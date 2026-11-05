// API pública da Kobly: outros sistemas (gateway, checkout, CRM, Make/Zapier) disparam fluxos pela chave da empresa.
//   Autenticação: Authorization: Bearer kbk_...  (ou X-Api-Key: kbk_...)
//   GET  /public/v1/me                    valida a chave → empresa
//   GET  /public/v1/instances             números conectados (WhatsApp QR Code e API oficial)
//   GET  /public/v1/flows                 fluxos publicados
//   POST /public/v1/flows/{id}/trigger    { phone, name?, email?, variables? } → coloca o contato no início do fluxo
// Chaves: rota public-api-keys (list | create | revoke), só em hash no banco.
import { createHash, randomBytes } from 'node:crypto';
import { AuthError } from '../auth.js';
import { createLimiter } from '../ratelimit.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAR = /^[a-z][a-z0-9_]{0,39}$/;
const digits = (v) => String(v || '').replace(/\D/g, '');

export function createPublicApi({ pool, flows, limiter = createLimiter({ max: 120, windowMs: 60_000 }), now = () => new Date() }) {
  async function handleKeys(ctx, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte' || ctx.teamRole === 'atendente') throw new AuthError(403, 'forbidden', 'Seu perfil não pode gerenciar chaves da API.'); };
    switch (body.action) {
      case 'list': return { keys: (await pool.query(`select id, label, key_prefix, last_used_at, revoked_at, created_at from public.api_keys where organization_id = $1 order by created_at desc`, [orgId])).rows };
      case 'create': {
        editor();
        const key = `kbk_${randomBytes(24).toString('base64url')}`;
        const label = String(body.label || '').trim().slice(0, 60) || 'Minha integração';
        const row = (await pool.query(`insert into public.api_keys (organization_id, label, key_prefix, key_hash) values ($1,$2,$3,$4) returning id, label, key_prefix, created_at`,
          [orgId, label, key.slice(0, 12), sha(key)])).rows[0];
        return { key, ...row };
      }
      case 'revoke': {
        editor();
        if (!UUID.test(String(body.id || ''))) throw new AuthError(422, 'validation_failed', 'Chave inválida.');
        const r = await pool.query(`update public.api_keys set revoked_at = now() where id = $1 and organization_id = $2 and revoked_at is null`, [body.id, orgId]);
        return { ok: r.rowCount === 1 };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }

  async function authenticate(headers) {
    const auth = String(headers.authorization || '');
    const key = (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : String(headers['x-api-key'] || '')).trim();
    if (!/^kbk_[A-Za-z0-9_-]{30,}$/.test(key)) return null;
    const row = (await pool.query(`select k.id, k.organization_id, k.last_used_at, o.nome from public.api_keys k join public.organizations o on o.id = k.organization_id where k.key_hash = $1 and k.revoked_at is null`, [sha(key)])).rows[0];
    if (!row) return null;
    if (!row.last_used_at || now() - new Date(row.last_used_at) > 60_000) await pool.query(`update public.api_keys set last_used_at = now() where id = $1`, [row.id]).catch(() => {});
    return { keyId: row.id, orgId: row.organization_id, nome: row.nome };
  }

  const err = (status, code, message) => ({ status, body: { error: { code, message } } });

  // Requisição HTTP inteira (já com o caminho sem /public/v1) → { status, body }
  async function handleHttp(method, path, headers, rawBody) {
    const org = await authenticate(headers);
    if (!org) return err(401, 'invalid_key', 'Chave da API inválida ou revogada. Crie uma em Integrações → API pública.');
    if (!limiter(org.keyId)) return err(429, 'rate_limited', 'Muitas requisições: no máximo 120 por minuto por chave.');
    if (method === 'GET' && path === '/me') return { status: 200, body: { ok: true, organization: { id: org.orgId, nome: org.nome } } };
    if (method === 'GET' && path === '/instances') {
      const qr = (await pool.query(`select id, label, phone, status from public.whatsapp_uazapi_instances where organization_id = $1 order by created_at`, [org.orgId])).rows;
      const of = (await pool.query(`select id, display_phone as phone, status from public.whatsapp_accounts where organization_id = $1`, [org.orgId]).catch(() => ({ rows: [] }))).rows;
      return { status: 200, body: { instances: [...qr.map((r) => ({ id: r.id, tipo: 'qrcode', nome: r.label, telefone: r.phone, conectado: r.status === 'connected' })),
        ...of.map((r) => ({ id: r.id, tipo: 'oficial', nome: 'API oficial', telefone: r.phone, conectado: r.status === 'connected' }))] } };
    }
    if (method === 'GET' && path === '/flows') {
      const { rows } = await pool.query(`select c.id, c.nome, c.status_campanha = 'Ativa' as ativo from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
        join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where c.organization_id = $1 order by c.nome`, [org.orgId]);
      return { status: 200, body: { flows: rows } };
    }
    const m = /^\/flows\/([0-9a-f-]{36})\/trigger$/i.exec(path);
    if (method === 'POST' && m) {
      let b; try { b = JSON.parse(rawBody || '{}'); } catch { return err(400, 'bad_json', 'O corpo precisa ser um JSON válido.'); }
      let phone = digits(b.phone);
      if (phone.length === 10 || phone.length === 11) phone = `55${phone}`; // número brasileiro sem DDI
      if (phone.length < 10 || phone.length > 15) return err(422, 'bad_phone', 'Informe "phone" com DDI + DDD + número (ex.: 5511987654321).');
      const vars = {};
      if (b.variables !== undefined) {
        if (!b.variables || typeof b.variables !== 'object' || Array.isArray(b.variables)) return err(422, 'bad_variables', '"variables" precisa ser um objeto, ex.: { "produto": "Curso X" }.');
        for (const [k, v] of Object.entries(b.variables).slice(0, 50)) {
          const key = String(k).toLowerCase();
          if (!VAR.test(key)) return err(422, 'bad_variables', `Nome de variável inválido: "${k}" (use letras minúsculas, números e _).`);
          vars[key] = v === null || v === undefined ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 4096);
        }
      }
      const camp = (await pool.query(`select c.id from public.campaigns c where c.id = $1 and c.organization_id = $2`, [m[1], org.orgId])).rows[0];
      if (!camp) return err(404, 'flow_not_found', 'Fluxo não encontrado nesta conta.');
      const nome = String(b.name || '').trim().slice(0, 120) || null;
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email || '')) ? String(b.email).toLowerCase() : null;
      let lead = (await pool.query(`select id from public.leads where organization_id = $1 and right(regexp_replace(coalesce(telefone,''), '\\D', '', 'g'), 10) = $2 order by updated_at desc limit 1`, [org.orgId, phone.slice(-10)])).rows[0];
      if (lead) await pool.query(`update public.leads set nome = coalesce(nome, $2), email = coalesce(email, $3) where id = $1`, [lead.id, nome, email]);
      else lead = (await pool.query(`insert into public.leads (organization_id, nome, telefone, email, utm) values ($1,$2,$3,$4,'{"utm_source":"api"}'::jsonb) returning id`, [org.orgId, nome, phone, email])).rows[0];
      const r = await flows.startForLead({ orgId: org.orgId, campaignId: camp.id, leadId: lead.id, tipo: 'API', variables: vars });
      return { status: r.started ? 200 : 409, body: r.started ? { ok: true, lead_id: lead.id, flow_id: camp.id } : { ok: false, lead_id: lead.id, error: { code: 'not_started', message: r.reason } } };
    }
    return err(404, 'not_found', 'Rota não existe. Veja a documentação em Integrações → API pública.');
  }

  return { handleKeys, handleHttp, authenticate };
}
