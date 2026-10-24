// IA por empresa (BYOK): os blocos de IA, o agente e o copiloto usam a chave ATIVA da empresa.
// Sem chave cadastrada, só caem na chave da plataforma (AI_API_KEY) se AI_PLATFORM_FALLBACK=true —
// por padrão a IA fica desligada para a empresa e o bloco sai por "Erro" pedindo a chave.
// Rota POST /functions/v1/ai-keys: list | providers | connect | models | set_model | activate | remove.
import { AuthError } from '../auth.js';
import { encrypt, decrypt } from '../whatsapp/crypto.js';
import { AI_PROVIDERS, AiError, createLlm, listModels } from './llm.js';

const UUID = /^[0-9a-f-]{36}$/i;
const SAFE = 'id, provider, label, key_hint, model, is_active, status, last_error, last_used_at, created_at';
const CACHE_MS = 60_000;

export function createAiKeys({ pool, secretKey, platform = null, allowPlatform = false, fetchImpl = globalThis.fetch, anthropicClientFor = null }) {
  const cache = new Map(); // orgId → { at, llm }
  const needKey = () => { if (!secretKey) throw new AuthError(503, 'ai_keys_unconfigured', 'Chaves de IA indisponíveis neste ambiente (chave de segurança ausente).'); };
  const fail = (msg) => { throw new AuthError(422, 'validation_failed', msg); };
  const fromAi = (e) => (e instanceof AiError ? new AuthError(e.status === 401 ? 400 : (e.status >= 500 ? 502 : 400), e.code, e.message) : e);
  const extra = (provider, apiKey) => (provider === 'anthropic' && anthropicClientFor ? { anthropicClient: anthropicClientFor(apiKey) } : {});
  const platformLlm = () => (allowPlatform && platform && platform.apiKey ? createLlm({ ...platform, fetchImpl }) : null);
  const unconfigured = createLlm({ apiKey: '' }); // responde "cadastre a chave" em qualquer chamada

  // Cliente de IA da empresa (cache de 1 min; trocar a chave limpa o cache).
  async function forOrg(orgId) {
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.llm;
    const row = (await pool.query(`select id, provider, key_enc, model from public.ai_credentials where organization_id = $1 and is_active`, [orgId])).rows[0];
    let llm = platformLlm() || unconfigured;
    if (row && secretKey) {
      const apiKey = decrypt(row.key_enc, secretKey);
      const base = createLlm({ provider: row.provider, apiKey, model: row.model, fetchImpl, ...extra(row.provider, apiKey) });
      // registra uso e erro de chave (a tela mostra "chave recusada" para a pessoa trocar)
      const wrap = (fn) => async (...a) => {
        try { const out = await base[fn](...a); pool.query(`update public.ai_credentials set last_used_at = now(), status = 'ok', last_error = null where id = $1`, [row.id]).catch(() => {}); return out; }
        catch (e) {
          if (e && (e.code === 'ai_bad_key' || e.code === 'ai_bad_model')) { pool.query(`update public.ai_credentials set status = 'error', last_error = $2 where id = $1`, [row.id, e.message]).catch(() => {}); cache.delete(orgId); }
          throw e;
        }
      };
      llm = { ...base, classify: wrap('classify'), extract: wrap('extract'), agentReply: wrap('agentReply'), summarize: wrap('summarize') };
    }
    cache.set(orgId, { at: Date.now(), llm });
    return llm;
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    const editor = () => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar as chaves de IA.'); };
    const own = async (id) => {
      if (!UUID.test(String(id || ''))) fail('Chave inválida.');
      const r = (await pool.query(`select * from public.ai_credentials where id = $1 and organization_id = $2`, [id, orgId])).rows[0];
      if (!r) throw new AuthError(404, 'not_found', 'Chave não encontrada.');
      return r;
    };
    switch (body.action) {
      case 'providers': return { providers: Object.entries(AI_PROVIDERS).map(([id, p]) => ({ id, label: p.label, default_model: p.defaultModel || null })) };
      case 'list': {
        const keys = (await pool.query(`select ${SAFE} from public.ai_credentials where organization_id = $1 order by created_at`, [orgId])).rows;
        return { keys, platform_fallback: !!platformLlm() };
      }
      case 'connect': { // confere a chave listando os modelos; a 1ª chave da empresa já fica ativa
        editor(); needKey();
        const provider = String(body.provider || '');
        if (!AI_PROVIDERS[provider]) fail('Escolha o provedor de IA.');
        const apiKey = String(body.api_key || '').trim();
        if (apiKey.length < 12) fail('Cole a chave de API do provedor.');
        let models;
        try { models = await listModels({ provider, apiKey, fetchImpl, ...extra(provider, apiKey) }); } catch (e) { throw fromAi(e); }
        const wanted = String(body.model || '').trim();
        const model = wanted || AI_PROVIDERS[provider].defaultModel || models[0];
        if (!model) fail('Informe o modelo.');
        if (models.length && wanted && !models.includes(wanted)) fail(`O modelo "${wanted}" não está disponível para esta chave.`);
        const hasActive = (await pool.query(`select 1 from public.ai_credentials where organization_id = $1 and is_active`, [orgId])).rowCount > 0;
        const r = await pool.query(`insert into public.ai_credentials (organization_id, provider, label, key_enc, key_hint, model, is_active)
          values ($1,$2,$3,$4,$5,$6,$7) returning ${SAFE}`,
          [orgId, provider, String(body.label || AI_PROVIDERS[provider].label).slice(0, 60), encrypt(apiKey, secretKey), `…${apiKey.slice(-4)}`, model, !hasActive]);
        cache.delete(orgId);
        return { key: r.rows[0], models };
      }
      case 'models': {
        needKey();
        const r = await own(body.id);
        try { return { models: await listModels({ provider: r.provider, apiKey: decrypt(r.key_enc, secretKey), fetchImpl, ...extra(r.provider, decrypt(r.key_enc, secretKey)) }) }; } catch (e) { throw fromAi(e); }
      }
      case 'set_model': {
        editor();
        const r = await own(body.id);
        const model = String(body.model || '').trim();
        if (!model || model.length > 120) fail('Informe o modelo.');
        await pool.query(`update public.ai_credentials set model = $2, status = 'ok', last_error = null where id = $1`, [r.id, model]);
        cache.delete(orgId);
        return { ok: true };
      }
      case 'activate': {
        editor();
        const r = await own(body.id);
        const c = await pool.connect();
        try {
          await c.query('begin');
          await c.query(`update public.ai_credentials set is_active = false where organization_id = $1 and is_active`, [orgId]);
          await c.query(`update public.ai_credentials set is_active = true where id = $1`, [r.id]);
          await c.query('commit');
        } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
        cache.delete(orgId);
        return { ok: true };
      }
      case 'remove': {
        editor();
        const r = await own(body.id);
        await pool.query(`delete from public.ai_credentials where id = $1`, [r.id]);
        cache.delete(orgId);
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { forOrg, handle };
}
