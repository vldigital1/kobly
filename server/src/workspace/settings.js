// Rota POST /functions/v1/workspace-settings: Configurações da automação da empresa.
// Empresa (nome e fuso), respostas rápidas, campos personalizados, variáveis globais e agentes de IA
// salvos. O cliente só lê estas tabelas; toda escrita passa por aqui, sempre presa à empresa.
import { AuthError } from '../auth.js';

const UUID = /^[0-9a-f-]{36}$/i;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const fail = (msg) => { throw new AuthError(422, 'validation_failed', msg); };
const text = (v, max, label, { required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) fail(`Preencha ${label}.`);
  if (s.length > max) fail(`${label} pode ter até ${max} caracteres.`);
  return s;
};
const intIn = (v, min, max, def, label) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} entre ${min} e ${max}.`);
  return n;
};
export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: tz }); return typeof tz === 'string' && tz.includes('/'); } catch { return false; }
}

// Cada coleção: tabela, colunas devolvidas e como limpar o que veio da tela.
const KINDS = {
  quick_reply: {
    table: 'quick_replies', cols: 'id, shortcut, body, updated_at', order: 'shortcut',
    clean: (b) => {
      const shortcut = text(b.shortcut, 32, 'o atalho').toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(shortcut)) fail('Atalho só com letras minúsculas, números, - e _ (ex.: pix, boas-vindas).');
      return { shortcut, body: text(b.body, 4096, 'a mensagem') };
    },
  },
  custom_field: {
    table: 'custom_fields', cols: 'id, key, label, field_type, options, updated_at', order: 'label',
    clean: (b) => {
      const key = text(b.key, 40, 'a chave').toLowerCase();
      if (!KEY.test(key)) fail('Chave começa com letra e usa só a-z, 0-9 e _ (ex.: cidade, plano_escolhido).');
      const field_type = ['texto', 'numero', 'data', 'opcoes'].includes(b.field_type) ? b.field_type : 'texto';
      const options = field_type === 'opcoes' ? (Array.isArray(b.options) ? b.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 30) : [];
      if (field_type === 'opcoes' && !options.length) fail('Informe ao menos uma opção.');
      return { key, label: text(b.label, 80, 'o nome do campo'), field_type, options: JSON.stringify(options) };
    },
  },
  global_var: {
    table: 'global_variables', cols: 'id, key, value, updated_at', order: 'key',
    clean: (b) => {
      const key = text(b.key, 40, 'a chave').toLowerCase();
      if (!KEY.test(key)) fail('Chave começa com letra e usa só a-z, 0-9 e _ (ex.: link_suporte, cupom).');
      return { key, value: text(b.value, 2000, 'o valor', { required: false }) };
    },
  },
  agent: {
    table: 'ai_agents', cols: 'id, name, objective, knowledge, tone, opening, max_turns, timeout_minutes, updated_at', order: 'name',
    clean: (b) => ({
      name: text(b.name, 80, 'o nome do agente'),
      objective: text(b.objective, 2000, 'o objetivo'),
      knowledge: text(b.knowledge, 8000, 'a base de conhecimento', { required: false }),
      tone: text(b.tone, 200, 'o tom de voz', { required: false }) || null,
      opening: text(b.opening, 1024, 'a mensagem de abertura', { required: false }) || null,
      max_turns: intIn(b.max_turns, 1, 30, 10, 'Máximo de respostas'),
      timeout_minutes: intIn(b.timeout_minutes, 1, 43200, 60, 'Prazo sem resposta (minutos)'),
    }),
  },
};

export function createWorkspaceSettings({ pool }) {
  const canEdit = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar as configurações.'); };
  const kindOf = (k) => KINDS[k] || fail('Tipo de configuração desconhecido.');

  async function list(orgId, k) {
    const c = KINDS[k];
    return (await pool.query(`select ${c.cols} from public.${c.table} where organization_id = $1 order by ${c.order}`, [orgId])).rows;
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'get': {
        const org = (await pool.query(`select id, nome, timezone from public.organizations where id = $1`, [orgId])).rows[0];
        const [quick_replies, custom_fields, global_vars, agents] = await Promise.all(['quick_reply', 'custom_field', 'global_var', 'agent'].map((k) => list(orgId, k)));
        return { org, quick_replies, custom_fields, global_vars, agents };
      }
      case 'update_org': {
        canEdit(ctx);
        const nome = text(body.nome, 120, 'o nome da empresa');
        if (!validTimezone(body.timezone)) fail('Fuso horário inválido.');
        await pool.query(`update public.organizations set nome = $2, timezone = $3 where id = $1`, [orgId, nome, body.timezone]);
        return { ok: true };
      }
      case 'upsert': {
        canEdit(ctx);
        const c = kindOf(body.kind);
        const v = c.clean(body.item || {});
        const cols = Object.keys(v);
        const id = body.item && body.item.id;
        try {
          if (id) {
            if (!UUID.test(String(id))) fail('Item inválido.');
            const sets = cols.map((col, i) => `${col} = $${i + 3}`).join(', ');
            const r = await pool.query(`update public.${c.table} set ${sets} where id = $1 and organization_id = $2 returning ${c.cols}`, [id, orgId, ...Object.values(v)]);
            if (!r.rows[0]) throw new AuthError(404, 'not_found', 'Item não encontrado.');
            return { ok: true, item: r.rows[0] };
          }
          const r = await pool.query(`insert into public.${c.table} (organization_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning ${c.cols}`, [orgId, ...Object.values(v)]);
          return { ok: true, item: r.rows[0] };
        } catch (e) {
          if (e.code === '23505') throw new AuthError(409, 'duplicate', 'Já existe um item com esse atalho/chave.');
          throw e;
        }
      }
      case 'delete': {
        canEdit(ctx);
        const c = kindOf(body.kind);
        if (!UUID.test(String(body.id || ''))) fail('Item inválido.');
        const r = await pool.query(`delete from public.${c.table} where id = $1 and organization_id = $2`, [body.id, orgId]);
        return { ok: r.rowCount === 1 };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
