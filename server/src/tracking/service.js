// Rotas POST /functions/v1/tracking e /functions/v1/products.
// tracking: relatório por origem (UTM do 1º toque do lead) e conexão da UTMify.
// products: catálogo da empresa + o que foi visto nos eventos de checkout (para cadastrar com um clique).
import { AuthError } from '../auth.js';

const UUID = /^[0-9a-f-]{36}$/i;
const fail = (msg) => { throw new AuthError(422, 'validation_failed', msg); };
const days = (v) => Math.max(1, Math.min(365, Number(v) || 30));
const editor = (ctx) => { if (ctx.role === 'Suporte') throw new AuthError(403, 'forbidden', 'Seu perfil não pode alterar esta configuração.'); };
const DIM = { utm_source: 'utm_source', utm_campaign: 'utm_campaign', utm_medium: 'utm_medium', utm_content: 'utm_content', src: 'src', sck: 'sck' };

export function createTracking({ pool, utmify }) {
  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'get': {
        const integ = (await pool.query(`select provider, token_hint, status, last_error, last_sent_at, updated_at from public.tracking_integrations where organization_id = $1`, [orgId])).rows;
        const sent = (await pool.query(`select tracking_status as status, count(*)::int as n from public.payment_charges where organization_id = $1 and tracking_status is not null and created_at >= now() - interval '30 days' group by 1`, [orgId])).rows;
        return { integrations: integ, utmify_30d: sent };
      }
      case 'report': { // por origem: leads, abandonos/Pix, compras aprovadas no checkout, vendas recuperadas pelo fluxo
        const dim = DIM[body.group_by] || 'utm_source';
        const { rows } = await pool.query(`
          with l as (
            select id, coalesce(nullif(utm->>'${dim}', ''), '(sem UTM)') as origem from public.leads
             where organization_id = $1 and created_at >= now() - make_interval(days => $2)
          )
          select l.origem,
                 count(distinct l.id)::int as leads,
                 count(distinct e.lead_id) filter (where e.tipo_evento in ('Abandono de carrinho','Pix Gerado','Boleto Gerado','Compra Recusada','Depósito Solicitado'))::int as abandonos,
                 count(distinct e.lead_id) filter (where e.tipo_evento = 'Compra Aprovada')::int as aprovadas,
                 coalesce(sum(e.valor_produto) filter (where e.tipo_evento = 'Compra Aprovada'), 0)::float as receita_checkout,
                 (select count(*)::int from public.flow_sales s where s.organization_id = $1 and s.lead_id in (select id from l l2 where l2.origem = l.origem)) as recuperadas,
                 (select coalesce(sum(s.amount), 0)::float from public.flow_sales s where s.organization_id = $1 and s.lead_id in (select id from l l2 where l2.origem = l.origem)) as receita_recuperada
            from l left join public.webhook_events e on e.lead_id = l.id and e.organization_id = $1
           group by l.origem order by leads desc limit 100`, [orgId, days(body.days)]);
        return { group_by: dim, days: days(body.days), rows };
      }
      case 'connect_utmify': editor(ctx); return utmify.connect(orgId, body.token);
      case 'disconnect_utmify': {
        editor(ctx);
        const r = await pool.query(`delete from public.tracking_integrations where organization_id = $1 and provider = 'utmify'`, [orgId]);
        return { ok: r.rowCount === 1 };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}

function cleanProduct(b) {
  const nome = typeof b.nome === 'string' ? b.nome.trim() : '';
  if (!nome || nome.length > 160) fail('Informe o nome do produto (até 160 caracteres).');
  const aliases = [...new Set((Array.isArray(b.aliases) ? b.aliases : []).map((a) => String(a).trim()).filter(Boolean))].slice(0, 20);
  let preco = null;
  if (b.preco !== undefined && b.preco !== null && b.preco !== '') { preco = Number(String(b.preco).replace(',', '.')); if (!(preco >= 0 && preco < 1e9)) fail('Preço inválido.'); }
  const moeda = String(b.moeda || 'BRL').toUpperCase();
  if (!/^[A-Z]{3}$/.test(moeda)) fail('Moeda inválida (ex.: BRL, MXN).');
  const url = typeof b.checkout_url === 'string' ? b.checkout_url.trim() : '';
  if (url && !/^https:\/\/\S+$/i.test(url)) fail('Link de checkout precisa começar com https://');
  return { nome, aliases, preco, moeda, checkout_url: url || null, ativo: b.ativo !== false };
}

export function createProducts({ pool }) {
  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'list': { // catálogo com números do período + nomes vistos no checkout que ainda não estão no catálogo
        const d = days(body.days);
        const products = (await pool.query(`
          select p.*,
                 count(e.id) filter (where e.tipo_evento <> 'Compra Aprovada')::int as eventos_abandono,
                 count(e.id) filter (where e.tipo_evento = 'Compra Aprovada')::int as aprovadas,
                 coalesce(sum(e.valor_produto) filter (where e.tipo_evento = 'Compra Aprovada'), 0)::float as receita,
                 (select count(*)::int from public.flow_sales s where s.organization_id = p.organization_id and s.created_at >= now() - make_interval(days => $2)
                    and (lower(s.product) = lower(p.nome) or s.product = any(p.aliases))) as recuperadas
            from public.products p
            left join public.webhook_events e on e.organization_id = p.organization_id and e.created_at >= now() - make_interval(days => $2)
                  and (lower(e.produto) = lower(p.nome) or e.produto = any(p.aliases))
           where p.organization_id = $1 group by p.id order by p.nome`, [orgId, d])).rows;
        const seen = (await pool.query(`
          select e.produto as nome, count(*)::int as eventos, max(e.valor_produto)::float as ultimo_valor
            from public.webhook_events e
           where e.organization_id = $1 and e.produto is not null and e.produto <> '' and e.created_at >= now() - interval '90 days'
             and not exists (select 1 from public.products p where p.organization_id = $1 and (lower(p.nome) = lower(e.produto) or e.produto = any(p.aliases)))
           group by e.produto order by count(*) desc limit 30`, [orgId])).rows;
        return { products, seen, days: d };
      }
      case 'upsert': {
        editor(ctx);
        const v = cleanProduct(body.item || {});
        const id = body.item && body.item.id;
        try {
          if (id) {
            if (!UUID.test(String(id))) fail('Produto inválido.');
            const r = await pool.query(`update public.products set nome = $3, aliases = $4, preco = $5, moeda = $6, checkout_url = $7, ativo = $8 where id = $1 and organization_id = $2 returning *`,
              [id, orgId, v.nome, v.aliases, v.preco, v.moeda, v.checkout_url, v.ativo]);
            if (!r.rows[0]) throw new AuthError(404, 'not_found', 'Produto não encontrado.');
            return { ok: true, item: r.rows[0] };
          }
          const r = await pool.query(`insert into public.products (organization_id, nome, aliases, preco, moeda, checkout_url, ativo) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
            [orgId, v.nome, v.aliases, v.preco, v.moeda, v.checkout_url, v.ativo]);
          return { ok: true, item: r.rows[0] };
        } catch (e) {
          if (e.code === '23505') throw new AuthError(409, 'duplicate', 'Já existe um produto com esse nome.');
          throw e;
        }
      }
      case 'delete': {
        editor(ctx);
        if (!UUID.test(String(body.id || ''))) fail('Produto inválido.');
        const r = await pool.query(`delete from public.products where id = $1 and organization_id = $2`, [body.id, orgId]);
        return { ok: r.rowCount === 1 };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
